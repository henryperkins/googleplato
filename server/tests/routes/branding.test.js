import { beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import admin from '../../src/routes/admin.js';
import content from '../../src/routes/content.js';
import db from '../../src/lib/db.js';
import { signAccessToken } from '../../src/lib/jwt.js';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==';
const svg = text => `data:image/svg+xml;base64,${Buffer.from(text).toString('base64')}`;
// A structurally valid PNG of any declared size, padded to a given byte length.
function pngOf(width, height, padding = 0) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', Buffer.alloc(padding, 1)), chunk('IEND', Buffer.alloc(0))]);
  return `data:image/png;base64,${bytes.toString('base64')}`;
}
const app = new Hono();
app.route('/', admin);
app.route('/', content);
let records;
let originals;
async function put(body, path = '/v1/admin/theme') {
  const token = await signAccessToken('admin', 'admin');
  return app.request(path, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
async function adminTheme() {
  const token = await signAccessToken('admin', 'admin');
  return (await app.request('/v1/admin/theme', { headers: { Authorization: `Bearer ${token}` } })).json();
}
const settings = () => records.get('_system/settings')?.data;
const assets = () => [...records.keys()].filter(key => key.startsWith('_branding/'));
const hashOf = url => url.split('/').pop();

describe('branding boundary', () => {
  beforeEach(() => {
    originals = { getSyncData: db.getSyncData, putSyncData: db.putSyncData, putBrandingSettings: db.putBrandingSettings, deleteSyncData: db.deleteSyncData, getUserById: db.getUserById };
    records = new Map([['_system/settings', { version: 4, data: { userGroups: ['Staff'], customUserFields: [{ id: 'team' }] } }]]);
    db.getUserById = async () => ({ userId: 'admin', role: 'admin' });
    db.getSyncData = async (user, key) => records.get(`${user}/${key}`) || null;
    db.putSyncData = async (user, key, data, version) => {
      const item = { data, version: version + 1 };
      records.set(`${user}/${key}`, item);
      return item;
    };
    db.deleteSyncData = async (user, key) => { records.delete(`${user}/${key}`); };
    db.putBrandingSettings = async (data, version, { logo, previousLogoHash } = {}) => {
      const current = records.get('_system/settings');
      if ((current?.version || 0) !== version) throw Object.assign(new Error('Conflict'), { name: 'ConditionalCheckFailedException' });
      if (logo) records.set(`_branding/logo:${logo.hash}`, { version: 1,
        data: { dataUrl: logo.dataUrl, ...(logo.legacy ? { legacy: true } : {}) } });
      records.set('_system/settings', { data, version: version + 1 });
      if (previousLogoHash && previousLogoHash !== data.logoHash) records.delete(`_branding/logo:${previousLogoHash}`);
      return { version: version + 1 };
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

  it('merges independent color edits and explicitly clears a matching accent', async () => {
    settings().theme = { primary: '#123456', accent: '#abcdef' };
    assert.equal((await put({ themePatch: { primary: '#112233' } })).status, 200);
    assert.deepEqual(settings().theme, { primary: '#112233', accent: '#abcdef' });
    assert.equal((await put({ themePatch: { accent: '#f90' } })).status, 200);
    assert.deepEqual(settings().theme, { primary: '#112233', accent: '#ff9900' });
    assert.equal((await put({ themePatch: { accent: null } })).status, 200);
    assert.deepEqual(settings().theme, { primary: '#112233' });
  });

  it('rejects ambiguous or malformed color patches without changing settings', async () => {
    for (const body of [{ theme: {}, themePatch: {} }, { themePatch: null }, { themePatch: [] },
      { themePatch: { primary: null } }, { themePatch: { accent: 'red' } }, { themePatch: { background: '#fff' } }]) {
      assert.equal((await put(body)).status, 400, JSON.stringify(body));
    }
    assert.equal(records.get('_system/settings').version, 4);
  });

  it('keeps an older explicitly equal accent following the primary', async () => {
    settings().theme = { primary: '#123456', accent: '#123456' };
    assert.equal((await put({ themePatch: { primary: '#112233' } })).status, 200);
    assert.deepEqual(settings().theme, { primary: '#112233' });
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
    assert.match(logo.headers.get('cache-control'), /public.*no-cache/);
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
    db.putBrandingSettings = async () => { throw new Error('Asset store unavailable'); };
    assert.equal((await put({ logoBase64: png })).status, 500);
    assert.equal(settings().logoHash, undefined);
    assert.equal(records.get('_system/settings').version, 4);
  });

  it('reports a settings conflict without changing the previous branding', async () => {
    db.putBrandingSettings = async () => { throw Object.assign(new Error('Conflict'), { name: 'ConditionalCheckFailedException' }); };
    const response = await put({ classroomName: 'Unacknowledged' });
    assert.equal(response.status, 409);
    assert.equal(settings().classroomName, undefined);
  });

  it('keeps showing logos saved before the size limit, and moves them out of settings on the next save', async () => {
    const legacy = pngOf(512, 512, 150 * 1024);
    assert.ok(legacy.length > 128 * 1024);
    Object.assign(settings(), { logoBase64: legacy });
    const { logoUrl } = await (await app.request('/v1/branding')).json();
    assert.match(logoUrl, /^\/v1\/branding\/logo\/[a-f0-9]{64}$/);
    assert.equal((await app.request(logoUrl)).status, 200);
    const view = await adminTheme();
    assert.equal(view.logoBase64, legacy);
    assert.equal(view.logoLegacy, true);
    assert.equal((await put({ classroomName: 'Renamed' })).status, 200);
    assert.equal(settings().logoBase64, undefined);
    assert.equal(settings().logoHash, hashOf(logoUrl));
    assert.equal(records.get(`_branding/logo:${hashOf(logoUrl)}`).data.legacy, true);
    assert.equal((await (await app.request('/v1/branding')).json()).logoUrl, logoUrl);
    assert.equal((await app.request(logoUrl)).status, 200);
    assert.equal((await adminTheme()).logoLegacy, true);
  });

  it('keeps showing design-tool SVGs saved before the allowlist, sandboxed, and accepts them sent back unchanged', async () => {
    const legacy = svg('<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg xmlns="http://www.w3.org/2000/svg" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" viewBox="0 0 10 10"><sodipodi:namedview pagecolor="#ffffff"/><defs><style>.a{fill:#123456}</style></defs><path class="a" d="M0 0h10v10H0z"/></svg>');
    Object.assign(settings(), { logoBase64: legacy });
    const { logoUrl } = await (await app.request('/v1/branding')).json();
    const logo = await app.request(logoUrl);
    assert.equal(logo.headers.get('content-type'), 'image/svg+xml');
    assert.match(logo.headers.get('content-security-policy'), /sandbox/);
    assert.equal((await put({ logoBase64: legacy, classroomName: 'Kept' })).status, 200);
    assert.equal(settings().logoHash, hashOf(logoUrl));
    assert.equal((await put({ logoBase64: svg('<svg xmlns="http://www.w3.org/2000/svg"><style>.b{fill:red}</style></svg>') })).status, 400);
    Object.assign(settings(), { logoHash: undefined, logoBase64: svg('<!DOCTYPE svg [<!ENTITY a "aaaa">]><svg xmlns="http://www.w3.org/2000/svg">&a;</svg>') });
    assert.equal((await (await app.request('/v1/branding')).json()).logoUrl, null);
  });

  it('keeps showing a large SVG that an earlier version stored unchecked', async () => {
    const legacy = svg(`<svg xmlns="http://www.w3.org/2000/svg"><desc>${'x'.repeat(2.5 * 1024 * 1024)}</desc><path d="M0 0h1v1z"/></svg>`);
    Object.assign(settings(), { logoBase64: legacy });
    const { logoUrl } = await (await app.request('/v1/branding')).json();
    assert.equal((await app.request(logoUrl)).status, 200);
  });

  it('never deletes an inline logo it cannot show until the admin replaces or removes it', async () => {
    Object.assign(settings(), { logoBase64: 'https://example.com/logo.png' });
    assert.equal((await (await app.request('/v1/branding')).json()).logoUrl, null);
    assert.equal((await put({ classroomName: 'Renamed', theme: { primary: '#123456' } })).status, 200);
    assert.equal(settings().logoBase64, 'https://example.com/logo.png');
    assert.equal((await put({ logoBase64: null })).status, 200);
    assert.equal(settings().logoBase64, undefined);
  });

  it('preserves blocked SVG originals across unrelated saves without advertising or serving them', async () => {
    let defs = '<rect id="n0" width="1" height="1"/>';
    for (let i = 1; i <= 15; i++) defs += `<g id="n${i}"><use href="#n${i - 1}"/><use href="#n${i - 1}"/></g>`;
    const source = `<svg xmlns="http://www.w3.org/2000/svg"><defs>${defs}</defs><use href="#n15"/></svg>`;
    const original = svg(source);
    const hash = createHash('sha256').update('image/svg+xml').update(source).digest('hex');
    for (const storedAsAsset of [false, true]) {
      delete settings().logoHash;
      delete settings().logoBase64;
      if (storedAsAsset) {
        settings().logoHash = hash;
        records.set(`_branding/logo:${hash}`, { version: 1, data: { dataUrl: original } });
      } else settings().logoBase64 = original;
      assert.equal((await (await app.request('/v1/branding')).json()).logoUrl, null);
      assert.equal((await app.request(`/v1/branding/logo/${hash}`)).status, 404);
      const before = await adminTheme();
      assert.equal(before.logoBase64, original);
      assert.equal(before.logoBlocked, true);
      assert.equal((await put({ classroomName: 'Renamed', themePatch: { primary: '#123456' } })).status, 200);
      assert.equal((await adminTheme()).logoBase64, original);
      assert.equal((await adminTheme()).logoBlocked, true);
      assert.equal((await put({ logoBase64: null })).status, 200);
      assert.equal((await adminTheme()).logoBase64, null);
      assert.equal(settings().logoBase64, undefined);
      assert.equal(settings().logoHash, undefined);
      assert.equal(records.has(`_branding/logo:${hash}`), false);
    }
  });

  it('rejects SVG <use> expansion and large decoded areas in new uploads', async () => {
    let defs = '<rect id="l0" width="1" height="1"/>';
    for (let i = 1; i <= 5; i++) defs += `<g id="l${i}">${`<use href="#l${i - 1}"/>`.repeat(10)}</g>`;
    assert.equal((await put({ logoBase64: svg(`<svg xmlns="http://www.w3.org/2000/svg"><defs>${defs}</defs><use href="#l5"/></svg>`) })).status, 400);
    assert.equal((await put({ logoBase64: svg('<svg xmlns="http://www.w3.org/2000/svg"><g id="a"><use href="#a"/></g></svg>') })).status, 400);
    assert.equal((await put({ logoBase64: svg('<svg xmlns="http://www.w3.org/2000/svg"><defs><path id="p" d="M0 0h1v1z"/></defs><use href="#p"/><use href="#p" x="2"/></svg>') })).status, 200);
    assert.equal((await put({ logoBase64: pngOf(4096, 4096) })).status, 400);
    assert.equal((await put({ logoBase64: pngOf(2048, 512) })).status, 200);
  });

  it('counts every kind of SVG reference, the way browsers resolve them', async () => {
    const ns = 'xmlns="http://www.w3.org/2000/svg"';
    const tower = (levels, ref) => {
      let defs = '<rect id="l0" width="1" height="1"/>';
      for (let i = 1; i <= levels; i++) defs += `<g id="l${i}">${ref(i - 1)}${ref(i - 1)}</g>`;
      return defs;
    };
    const chain = (tag, use) => {
      let defs = `<${tag} id="c0"><rect width="1" height="1"/></${tag}>`;
      for (let i = 1; i <= 30; i++) defs += `<${tag} id="c${i}">${use(i - 1)}${use(i - 1)}</${tag}>`;
      return defs;
    };
    for (const image of [
      `<svg ${ns} xmlns:q="http://www.w3.org/1999/xlink"><defs>${tower(40, i => `<use q:href="#l${i}"/>`)}</defs><use q:href="#l40"/></svg>`,
      `<svg ${ns}><defs>${tower(30, i => `<use href="#l${i}"/>`)}<rect id="l30"/></defs><use href="#l30"/></svg>`,
      `<svg ${ns}><defs>${chain('clipPath', i => `<rect clip-path="url(#c${i})" width="1" height="1"/>`)}</defs><rect clip-path="url(#c30)"/></svg>`,
      `<svg ${ns}><defs>${chain('mask', i => `<rect style="mask:url('#c${i}')" width="1" height="1"/>`)}</defs><rect mask="url(#c30)"/></svg>`,
    ]) {
      assert.equal((await put({ logoBase64: svg(image) })).status, 400, image.slice(0, 120));
    }
    const gradient = '<defs><linearGradient id="g"><stop offset="0"/><stop offset="1"/></linearGradient></defs>';
    assert.equal((await put({ logoBase64: svg(`<svg ${ns}>${gradient}${'<path fill="url(#g)" d="M0 0h1v1z"/>'.repeat(2000)}</svg>`) })).status, 200);
  });

  it('deletes replaced and removed logo assets, so their old URLs stop resolving', async () => {
    assert.equal((await put({ logoBase64: pngOf(64, 16) })).status, 200);
    const first = (await (await app.request('/v1/branding')).json()).logoUrl;
    assert.equal((await put({ logoBase64: pngOf(32, 8) })).status, 200);
    const second = (await (await app.request('/v1/branding')).json()).logoUrl;
    assert.notEqual(first, second);
    assert.equal((await app.request(first)).status, 404);
    assert.equal((await app.request(second)).status, 200);
    assert.equal((await put({ logoBase64: null })).status, 200);
    assert.equal((await app.request(second)).status, 404);
    assert.deepEqual(assets(), []);
  });

  it('rolls back an upload whose settings write conflicts, then stores it on retry', async () => {
    const write = db.putBrandingSettings;
    db.putBrandingSettings = async () => { throw Object.assign(new Error('Conflict'), { name: 'ConditionalCheckFailedException' }); };
    assert.equal((await put({ logoBase64: pngOf(64, 16) })).status, 409);
    assert.equal(settings().logoHash, undefined);
    assert.deepEqual(assets(), []);
    assert.equal((await (await app.request('/v1/branding')).json()).logoUrl, null);
    db.putBrandingSettings = write;
    assert.equal((await put({ logoBase64: pngOf(64, 16) })).status, 200);
    assert.deepEqual(assets(), [`_branding/logo:${settings().logoHash}`]);
  });

  it('stores the current logo again when its asset is missing', async () => {
    assert.equal((await put({ logoBase64: pngOf(64, 16) })).status, 200);
    const { logoUrl } = await (await app.request('/v1/branding')).json();
    records.delete(`_branding/logo:${hashOf(logoUrl)}`);
    assert.equal((await app.request(logoUrl)).status, 404);
    assert.equal((await put({ logoBase64: pngOf(64, 16) })).status, 200);
    assert.equal((await app.request(logoUrl)).status, 200);
  });

  it('reads settings with strong consistency before its versioned write', async () => {
    const reads = [];
    const read = db.getSyncData;
    db.getSyncData = async (user, key, options) => { reads.push(`${user}/${key}:${options?.consistentRead === true}`); return read(user, key); };
    assert.equal((await put({ classroomName: 'Consistent' })).status, 200);
    assert.deepEqual(reads.filter(read => read.startsWith('_system/settings')), ['_system/settings:true']);
  });

  it('rejects names that are not well-formed Unicode, and never cuts a stored name inside a character', async () => {
    assert.equal((await put({ classroomName: 'Acme\ud83e' })).status, 400);
    settings().classroomName = `${'a'.repeat(99)}🦉 Academy`;
    const { classroomName } = await (await app.request('/v1/branding')).json();
    assert.ok(classroomName.isWellFormed());
    assert.equal(classroomName, `${'a'.repeat(99)}🦉`);
  });

  it('keeps branding out of the raw settings merge', async () => {
    for (const key of ['theme', 'classroomName', 'logoAlt', 'logoBase64', 'logoHash']) {
      assert.equal((await put({ [key]: 'x' }, '/v1/admin/settings')).status, 400, key);
    }
    assert.equal((await put({ welcome: 'Hello' }, '/v1/admin/settings')).status, 200);
    assert.equal(settings().welcome, 'Hello');
    assert.deepEqual(settings().userGroups, ['Staff']);
  });
});
