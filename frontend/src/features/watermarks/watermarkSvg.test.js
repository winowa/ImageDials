import { expect, test } from 'vitest';

import vectors from '../../../../fixtures/api/watermark.json';
import { inspectSvg } from './watermarkSvg.js';

const NS = 'xmlns="http://www.w3.org/2000/svg"';
const wrap = (inner, attrs = 'viewBox="0 0 10 10"') =>
  `<svg ${NS} ${attrs}>${inner}</svg>`;

test('the shared fixture artwork is accepted with its aspect and a decoder size', () => {
  const result = inspectSvg(vectors.svg_request.svg_markup);
  expect(result.ok).toBe(true);
  expect(result.aspect).toEqual({ width: 10, height: 10 });
  expect(result.markup).toContain('width="10"');
  expect(result.markup).toContain('xmlns="http://www.w3.org/2000/svg"');
});

test('width and height without a viewBox give the aspect', () => {
  const result = inspectSvg(
    wrap('<path d="M0 0h1"/>', 'width="40px" height="20"'),
  );
  expect(result).toMatchObject({ ok: true, aspect: { width: 40, height: 20 } });
});

test.each([
  [
    'script',
    wrap('<script>alert(1)</script>'),
    /Unsupported SVG element: script/,
  ],
  ['foreignObject', wrap('<foreignObject/>'), /Unsupported SVG element/],
  ['image', wrap('<image href="#a"/>'), /Unsupported SVG element: image/],
  ['event handler', wrap('<path d="M0 0" onclick="x()"/>'), /event handlers/],
  [
    'external href',
    wrap('<use href="https://example.invalid/a.svg#x"/>'),
    /stay inside the artwork/,
  ],
  [
    'external url()',
    wrap('<path d="M0 0" fill="url(https://example.invalid/x)"/>'),
    /(Active or external|stay inside)/,
  ],
  [
    'style data url',
    wrap('<path d="M0 0" style="fill:url(data:image/png;base64,AA)"/>'),
    /(Active or external|stay inside)/,
  ],
  [
    'doctype',
    '<!DOCTYPE svg [<!ENTITY a "b">]><svg viewBox="0 0 1 1"/>',
    /declarations/,
  ],
  ['wrong root', '<div/>', /(SVG root|invalid)/],
  ['not xml', '<svg', /invalid/],
  ['no size', wrap('<path d="M0 0"/>', ''), /viewBox or width and height/],
  [
    'negative viewBox',
    wrap('<path d="M0 0"/>', 'viewBox="0 0 -1 1"'),
    /viewBox/,
  ],
  [
    'foreign namespace',
    `<svg ${NS} viewBox="0 0 1 1"><x:a xmlns:x="urn:x"/></svg>`,
    /SVG namespace/,
  ],
  ['empty', '  ', /Provide SVG/],
])('rejects %s', (_name, markup, message) => {
  const result = inspectSvg(markup);
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(message);
});

test('the byte limit counts UTF-8 bytes', () => {
  const markup = wrap(`<title>${'é'.repeat(40)}</title>`);
  expect(inspectSvg(markup, { max_svg_bytes: 200 }).ok).toBe(true);
  expect(inspectSvg(markup, { max_svg_bytes: 100 }).error).toMatch(
    /over 100 bytes/,
  );
});

test('local references and gradients inside the artwork are allowed', () => {
  const result = inspectSvg(
    wrap(
      '<defs><linearGradient id="g"><stop offset="0"/></linearGradient></defs><path d="M0 0h5v5z" fill="url(#g)"/><use href="#g"/>',
    ),
  );
  expect(result.ok).toBe(true);
});
