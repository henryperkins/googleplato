import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dataUrlBlob, logoDimensions, opaqueBounds, prepareLogo, MAX_LOGO_FILE_BYTES } from '../src/lib/logoUpload.js';

describe('logo preparation', () => {
  it('preserves wordmarks without square padding or minimum dimensions', () => {
    assert.deepEqual(logoDimensions(1200, 300), { width: 512, height: 128 });
    assert.deepEqual(logoDimensions(2048, 512), { width: 512, height: 128 });
    assert.deepEqual(logoDimensions(256, 64), { width: 256, height: 64 });
    assert.deepEqual(logoDimensions(10000, 100), { width: 1024, height: 10 });
    assert.deepEqual(logoDimensions(512, 512), { width: 128, height: 128 });
    assert.throws(() => logoDimensions(0, 20));
  });

  it('grows vector logos to fill the header box, so they stay sharp on dense screens', () => {
    assert.deepEqual(logoDimensions(120, 30, 1024, 128, { upscale: true }), { width: 512, height: 128 });
    assert.deepEqual(logoDimensions(300, 75, 1024, 128, { upscale: true }), { width: 512, height: 128 });
    assert.deepEqual(logoDimensions(24, 24, 1024, 128, { upscale: true }), { width: 128, height: 128 });
    assert.deepEqual(logoDimensions(120, 30), { width: 120, height: 30 }, 'bitmaps never grow');
  });

  it('finds the visible part of a padded logo', () => {
    const width = 8;
    const height = 6;
    const data = new Uint8ClampedArray(width * height * 4);
    for (const [x, y] of [[2, 2], [5, 3]]) data[(y * width + x) * 4 + 3] = 255;
    assert.deepEqual(opaqueBounds({ data, width, height }), { x: 2, y: 2, width: 4, height: 2 });
    assert.equal(opaqueBounds({ data: new Uint8ClampedArray(16), width: 2, height: 2 }), null);
  });

  it('turns a stored data URL back into a file for re-preparing', async () => {
    const blob = dataUrlBlob('data:image/png;base64,iVBORw0K');
    assert.equal(blob.type, 'image/png');
    assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    assert.throws(() => dataUrlBlob('https://example.com/logo.png'));
  });

  it('rejects oversize or unsupported files before reading or decoding them', async () => {
    await assert.rejects(prepareLogo({ type: 'image/png', size: MAX_LOGO_FILE_BYTES + 1 }), /5 MiB/);
    await assert.rejects(prepareLogo({ type: 'text/html', size: 100 }), /PNG, JPG, WebP, or SVG/);
    await assert.rejects(prepareLogo({ type: 'application/pdf', size: 100 }), /PNG, JPG, WebP, or SVG/);
  });
});
