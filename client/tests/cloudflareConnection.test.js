import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cloudflareAuthorizationUrl, cloudflareReturnFeedback, rememberCloudflareDraft, restoreCloudflareDraft } from '../src/lib/cloudflareConnection.js';

const saved = { provider: 'bedrock', workersAiModel: 'model-a', version: 2, workersAiModels: [{ id: 'model-a' }, { id: 'model-b' }] };
const draft = { provider: 'workers-ai', workersAiModel: 'model-b' };
function storage() {
  const values = new Map();
  return { setItem: (key, value) => values.set(key, value), getItem: key => values.get(key) ?? null, removeItem: key => values.delete(key) };
}

describe('Cloudflare connection handoff', () => {
  it('preserves pending selections for only the initiating admin and consumes them once', () => {
    const store = storage();
    assert.equal(rememberCloudflareDraft(store, 'admin-a', saved, draft), true);
    assert.equal(restoreCloudflareDraft(store, 'admin-b', saved), null);
    assert.deepEqual(restoreCloudflareDraft(store, 'admin-a', saved).draft, draft);
    assert.equal(restoreCloudflareDraft(store, 'admin-a', saved), null);
  });

  it('refuses stale selections if another administrator changed the settings', () => {
    const store = storage();
    rememberCloudflareDraft(store, 'admin-a', saved, draft);
    assert.deepEqual(restoreCloudflareDraft(store, 'admin-a', { ...saved, version: 3 }), { changed: true });
  });

  it('does not navigate to an arbitrary authorization endpoint supplied by a response', () => {
    assert.equal(cloudflareAuthorizationUrl('https://dash.cloudflare.com/oauth2/auth?state=x'), 'https://dash.cloudflare.com/oauth2/auth?state=x');
    for (const url of ['https://attacker.example/oauth2/auth', 'javascript:alert(1)', 'http://dash.cloudflare.com/oauth2/auth', 'https://dash.cloudflare.com@attacker.example/oauth2/auth']) {
      assert.throws(() => cloudflareAuthorizationUrl(url));
    }
  });

  it('confirms connection from loaded server state and never reflects arbitrary callback errors', () => {
    assert.equal(cloudflareReturnFeedback('connected', { connected: false }).error, true);
    assert.equal(cloudflareReturnFeedback('connected', { connected: true, account: { name: 'Classroom' } }).error, false);
    assert.equal(cloudflareReturnFeedback('denied', {}).error, true);
    assert.doesNotMatch(cloudflareReturnFeedback('<script>unsafe</script>', {}).text, /unsafe|script/);
  });

  it('reports unavailable browser storage without discarding the current selection', () => {
    assert.equal(rememberCloudflareDraft({ setItem() { throw new Error('Storage unavailable'); } }, 'admin', saved, draft), false);
  });
});
