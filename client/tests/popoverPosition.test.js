import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('popover positioning', () => {
  it('keeps a menu below its trigger when there is space', async () => {
    const { getPopoverPosition } = await import('../src/lib/popoverPosition.js');
    assert.deepEqual(getPopoverPosition({
      anchor: { left: 100, right: 200, top: 80, bottom: 120 },
      menuWidth: 180, menuHeight: 160, viewport: { width: 800, height: 600 },
    }), { left: 100, top: 124, maxHeight: 468, maxWidth: 784 });
  });

  it('opens above its trigger when a menu would be clipped below it', async () => {
    const { getPopoverPosition } = await import('../src/lib/popoverPosition.js');
    const result = getPopoverPosition({
      anchor: { left: 496, right: 697, top: 196, bottom: 240 },
      menuWidth: 352, menuHeight: 210, viewport: { width: 844, height: 390 },
    });
    assert.equal(result.top, 8);
    assert.equal(result.maxHeight, 184);
    assert.equal(result.left, 484);
  });

  it('caps a long menu to the available space, not the entire viewport', async () => {
    const { getPopoverPosition } = await import('../src/lib/popoverPosition.js');
    const result = getPopoverPosition({
      anchor: { left: 16, right: 150, top: 100, bottom: 144 },
      menuWidth: 176, menuHeight: 900, viewport: { width: 390, height: 844 },
    });
    assert.equal(result.top, 148);
    assert.equal(result.maxHeight, 688);
  });

  it('keeps right-aligned menus inside the visible viewport', async () => {
    const { getPopoverPosition } = await import('../src/lib/popoverPosition.js');
    const result = getPopoverPosition({
      anchor: { left: 250, right: 310, top: 40, bottom: 84 },
      menuWidth: 352, menuHeight: 120, viewport: { width: 320, height: 568 }, align: 'end',
    });
    assert.equal(result.left, 8);
    assert.equal(result.maxWidth, 304);
  });

  it('respects visual viewport offsets and keyboard-reduced height', async () => {
    const { getPopoverPosition } = await import('../src/lib/popoverPosition.js');
    const result = getPopoverPosition({
      anchor: { left: 120, right: 240, top: 350, bottom: 390 },
      menuWidth: 180, menuHeight: 200,
      viewport: { left: 100, top: 200, width: 300, height: 240 },
    });
    assert.equal(result.top, 208);
    assert.equal(result.maxHeight, 138);
    assert.equal(result.maxWidth, 284);
  });
});
