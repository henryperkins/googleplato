import { it } from 'node:test';
import assert from 'node:assert/strict';
import { parseLogo } from '../../src/lib/branding.js';

const svg = body => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${body}</svg>`;
const encoded = source => `data:image/svg+xml;base64,${Buffer.from(source).toString('base64')}`;
const accepted = (source, legacy = true) => Boolean(parseLogo(encoded(source), { legacy }));

it('bounds stored use expansion, including SVG element and XLink namespace aliases', () => {
  for (const prefix of ['', 's:']) {
    let defs = `<${prefix}rect id="n0" width="1" height="1"/>`;
    for (let i = 1; i <= 15; i++) defs += `<${prefix}g id="n${i}"><${prefix}use q:href="#n${i - 1}"/><${prefix}use q:href="#n${i - 1}"/></${prefix}g>`;
    const source = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg" xmlns:q="http://www.w3.org/1999/xlink"><defs>${defs}</defs><use href="#n15"/></svg>`;
    assert.equal(accepted(source), false);
  }
});

it('counts resource references in stored stylesheets', () => {
  let defs = '<mask id="m0"><rect width="1" height="1" fill="white"/></mask>';
  let styles = '';
  for (let i = 1; i <= 15; i++) {
    styles += `.m${i}{mask:url(#m${i - 1})}`;
    defs += `<mask id="m${i}"><rect class="m${i}" width="1" height="1"/><rect class="m${i}" width="1" height="1"/></mask>`;
  }
  assert.equal(accepted(svg(`<style>${styles}</style><defs>${defs}</defs><rect mask="url(#m15)" width="1" height="1"/>`)), false);
});

it('counts inherited resource references for every painted descendant', () => {
  let defs = '<pattern id="p0" width="1" height="1"><rect width="1" height="1" fill="red"/></pattern>';
  for (let i = 1; i <= 5; i++) defs += `<pattern id="p${i}" width="1" height="1"><g fill="url(#p${i - 1})">${'<rect width="1" height="1"/>'.repeat(10)}</g></pattern>`;
  const source = svg(`<defs>${defs}</defs><rect width="10" height="10" fill="url(#p5)"/>`);
  assert.equal(accepted(source), false);
  assert.equal(accepted(source, false), false);
});

it('refuses cycles, dynamic styles, animation, filters and oversized rendering structure', () => {
  for (const source of [
    svg('<g id="a"><use href="#a"/></g>'),
    svg('<style>.a{--paint:url(#p);fill:var(--paint)}</style><rect class="a"/>'),
    svg('<rect style="fill:v/**/ar(--paint)"/>'),
    svg('<style>.absent{filter:blur(100000px)}</style><rect/>'),
    svg('<style xmlns="http://www.w3.org/1999/xhtml">rect{filter:blur(100000px)}</style><rect/>'),
    svg('<style>@keyframes spin{to{transform:rotate(360deg)}}</style><rect/>'),
    svg('<rect style="filter:blur(100000px)"/>'),
    svg('<filter id="f"><feTurbulence numOctaves="10000"/></filter><rect filter="url(#f)"/>'),
    svg('<animate attributeName="width" dur="1s" repeatCount="indefinite"/>'),
    svg('<g>'.repeat(140) + '<rect/>' + '</g>'.repeat(140)),
    svg('<rect/>'.repeat(10001)),
    svg(`<path d="M0 0${'L1 1'.repeat(50000)}"/>`),
  ]) assert.equal(accepted(source), false, source.slice(0, 180));
});

it('preserves bounded editor metadata, styles, gradients and clip paths', () => {
  const source = `<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
    <svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd">
      <sodipodi:namedview pagecolor="#ffffff"/><metadata><inkscape:note>Editor data</inkscape:note></metadata>
      <style>.mark { fill:url(#paint); clip-path:url(#clip); stroke:none }</style>
      <defs><linearGradient id="paint"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient><clipPath id="clip"><rect width="10" height="10"/></clipPath></defs>
      <g><rect class="mark" width="10" height="10"/></g>
    </svg>`;
  assert.equal(accepted(source), true);
  assert.equal(accepted(source, false), false, 'editor markup is not enabled for new API uploads');
  assert.equal(accepted(svg(`<desc>${'x'.repeat(2.5 * 1024 * 1024)}</desc><rect width="1" height="1"/>`)), true);
  assert.equal(accepted(svg('<defs><pattern id="p" width="1" height="1"><rect fill="red" width="1" height="1"/></pattern></defs><g fill="url(#p)"><rect width="1" height="1"/><rect width="1" height="1"/></g>')), true);
});
