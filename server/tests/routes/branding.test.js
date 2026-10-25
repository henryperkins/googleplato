import { beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import admin from '../../src/routes/admin.js';
import content from '../../src/routes/content.js';
import db from '../../src/lib/db.js';
import { signAccessToken } from '../../src/lib/jwt.js';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==';
const svg = text => `data:image/svg+xml;base64,${Buffer.from(text).toString('base64')}`;
const app = new Hono();
app.route('/', admin);
app.route('/', content);
let records;
let originals;
async function put(body) {
  const token = await signAccessToken('admin', 'admin');
  return app.request('/v1/admin/theme', { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
const settings = () => records.get('_system/settings')?.data;

describe('branding boundary', () => {
  beforeEach(() => {
    originals = { getSyncData: db.getSyncData, putSyncData: db.putSyncData, getUserById: db.getUserById };
    records = new Map([['_system/settings', { version: 4, data: { userGroups: ['Staff'], customUserFields: [{ id: 'team' }] } }]]);
    db.getUserById = async () => ({ userId: 'admin', role: 'admin' });
    db.getSyncData = async (user, key) => records.get(`${user}/${key}`) || null;
    db.putSyncData = async (user, key, data, version) => {
      const item = { data, version: version + 1 };
      records.set(`${user}/${key}`, item);
      return item;
    };
  });
  afterEach(() => Object.assign(db, originals));

  it('validates body and name types without writes', async () => {
    for (const body of [null, [], 'theme', { classroomName: 42 }, { classroomName: {} }, { classroomName: null }, { classroomName: 'a'.repeat(101) }, { classroomName: 'Class\r\nBcc: x' }]) {
      assert.equal((await put(body)).status, 400, JSON.stringify(body));
    }
    assert.equal(records.size, 1);
    assert.equal(records.get('_system/settings').version, 4);
  });

  it('trims names, preserves private settings, and drops unknown theme fields', async () => {
    const response = await put({ classroomName: '  École & Co, Ltd  ', theme: { primary: '#ABC', accent: '#def', secret: 'private' }, userGroups: ['Everyone'] });
    assert.equal(response.status, 200);
    assert.equal(settings().classroomName, 'École & Co, Ltd');
    assert.deepEqual(settings().theme, { primary: '#aabbcc', accent: '#ddeeff' });
    assert.deepEqual(settings().userGroups, ['Staff']);
    assert.deepEqual(settings().customUserFields, [{ id: 'team' }]);
  });

  it('supports matching primary by omitting the accent', async () => {
    assert.equal((await put({ theme: { primary: '#123456' }, classroomName: '   ' })).status, 200);
    assert.deepEqual(settings().theme, { primary: '#123456' });
    assert.equal(settings().classroomName, '');
  });

  it('limits the entire request before parsing oversized JSON', async () => {
    assert.equal((await put({ ignored: 'x'.repeat(200 * 1024) })).status, 413);
    assert.equal(records.get('_system/settings').version, 4);
  });

  it('rejects URLs, non-images, mismatched image bytes, and oversize data', async () => {
    for (const logoBase64 of ['https://example.com/logo.png', 4, {}, '', 'data:text/html;base64,PGgxPmhpPC9oMT4=', 'data:image/png;base64,aGVsbG8=', png + 'A'.repeat(128 * 1024)]) {
      const response = await put({ logoBase64 });
      assert.ok([400, 413].includes(response.status), `accepted ${String(logoBase64).slice(0, 60)}`);
    }
    assert.equal(records.get('_system/settings').version, 4);
  });

  it('stores the bounded logo outside settings and returns only a cacheable URL publicly', async () => {
    assert.equal((await put({ logoBase64: png, theme: { primary: '#123456' } })).status, 200);
    assert.equal(settings().logoBase64, undefined);
    const response = await app.request('/v1/branding');
    const branding = await response.json();
    assert.equal(branding.logoBase64, undefined);
    assert.match(branding.logoUrl, /^\/v1\/branding\/logo\/[a-f0-9]{64}$/);
    assert.ok(JSON.stringify(branding).length < 300);
    const logo = await app.request(branding.logoUrl);
    assert.equal(logo.status, 200);
    assert.equal(logo.headers.get('content-type'), 'image/png');
    assert.match(logo.headers.get('cache-control'), /public.*immutable/);
    assert.deepEqual(Buffer.from(await logo.arrayBuffer()), Buffer.from(png.split(',')[1], 'base64'));
    const unchanged = await app.request(branding.logoUrl, { headers: { 'If-None-Match': logo.headers.get('etag') } });
    assert.equal(unchanged.status, 304);
    assert.equal((await put({ logoBase64: null })).status, 200);
    assert.equal((await (await app.request('/v1/branding')).json()).logoUrl, null);
  });

  it('preserves safe legacy logos through a name-only save, without exposing image data publicly', async () => {
    Object.assign(settings(), { logoBase64: png, logoAlt: 'Legacy', theme: { primary: '#ABC', leaked: 'private' } });
    const old = await (await app.request('/v1/branding')).json();
    assert.equal(old.classroomName, 'Legacy');
    assert.deepEqual(old.theme, { primary: '#aabbcc' });
    assert.equal((await app.request(old.logoUrl)).status, 200);
    assert.equal((await put({ classroomName: 'Updated' })).status, 200);
    assert.equal(settings().logoBase64, undefined);
    assert.equal((await app.request(old.logoUrl)).status, 200);
  });

  it('rejects active or externally linked SVGs and serves static SVGs with a sandbox', async () => {
    for (const image of ['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/a.png"/></svg>']) {
      assert.equal((await put({ logoBase64: svg(image) })).status, 400);
    }
    const image = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 300"><path fill="#123456" d="M0 0h1200v300H0z"/></svg>';
    assert.equal((await put({ logoBase64: svg(image) })).status, 200);
    const branding = await (await app.request('/v1/branding')).json();
    const logo = await app.request(branding.logoUrl);
    assert.equal(logo.status, 200);
    assert.match(logo.headers.get('content-security-policy'), /sandbox/);
    assert.equal(logo.headers.get('x-content-type-options'), 'nosniff');
  });

  it('sanitizes malformed legacy branding on read', async () => {
    Object.assign(settings(), { classroomName: { broken: true }, logoAlt: '   ', logoBase64: 'https://example.com/pixel', theme: { primary: 2, accent: '#fff', unknown: 'hidden' } });
    assert.deepEqual(await (await app.request('/v1/branding')).json(), { theme: { accent: '#ffffff' }, classroomName: '', logoUrl: null });
  });

  it('preserves usable legacy CSS colors while enforcing hex on new writes', async () => {
    settings().theme = { primary: 'rgb(139, 26, 26)', accent: '#abcd' };
    assert.deepEqual((await (await app.request('/v1/branding')).json()).theme, { primary: '#8b1a1a', accent: '#aabbcc' });
    assert.equal((await put({ theme: settings().theme })).status, 400);
  });

  it('does not publish a logo pointer when its asset write fails', async () => {
    db.putSyncData = async () => { throw new Error('Asset store unavailable'); };
    assert.equal((await put({ logoBase64: png })).status, 500);
    assert.equal(settings().logoHash, undefined);
    assert.equal(records.get('_system/settings').version, 4);
  });

  it('reports a settings conflict without changing the previous branding', async () => {
    db.putSyncData = async () => { throw Object.assign(new Error('Conflict'), { name: 'ConditionalCheckFailedException' }); };
    const response = await put({ classroomName: 'Unacknowledged' });
    assert.equal(response.status, 409);
    assert.equal(settings().classroomName, undefined);
  });
});
