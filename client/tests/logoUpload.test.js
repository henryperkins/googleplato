import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { logoDimensions, prepareLogo, MAX_LOGO_FILE_BYTES } from '../src/lib/logoUpload.js';

describe('logo preparation', () => {
  it('preserves wordmarks without square padding or minimum dimensions', () => {
    assert.deepEqual(logoDimensions(1200, 300), { width: 512, height: 128 });
    assert.deepEqual(logoDimensions(2048, 512), { width: 512, height: 128 });
    assert.deepEqual(logoDimensions(256, 64), { width: 256, height: 64 });
    assert.deepEqual(logoDimensions(10000, 100), { width: 1024, height: 10 });
    assert.deepEqual(logoDimensions(512, 512), { width: 128, height: 128 });
    assert.throws(() => logoDimensions(0, 20));
  });

  it('rejects oversize or unsupported files before reading or decoding them', async () => {
    await assert.rejects(prepareLogo({ type: 'image/png', size: MAX_LOGO_FILE_BYTES + 1 }), /5 MiB/);
    await assert.rejects(prepareLogo({ type: 'text/html', size: 100 }), /PNG, JPG, WebP, or SVG/);
  });
});
