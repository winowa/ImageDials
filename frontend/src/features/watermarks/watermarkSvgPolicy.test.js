// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

import { SVG_ALLOWED_ELEMENTS } from './watermarkSvg.js';
import { DEFAULT_LIMITS } from './watermarkGeometry.js';

const server = readFileSync(
  fileURLToPath(
    new URL('../../../../backend/app/watermark_settings.py', import.meta.url),
  ),
  'utf8',
);

test('the client SVG allow-list and limits match the server', () => {
  const block = /SVG_ALLOWED_ELEMENTS = \{([^}]*)\}/.exec(server)[1];
  const elements = [...block.matchAll(/"(\w+)"/g)].map((m) => m[1]);
  expect([...SVG_ALLOWED_ELEMENTS].sort()).toEqual(elements.sort());
  const number = (name) =>
    Number(
      new RegExp(`${name} = ([\\d_]+)`).exec(server)[1].replaceAll('_', ''),
    );
  expect(DEFAULT_LIMITS).toEqual({
    max_lines: number('MAX_TEXT_LINES'),
    max_line_length: number('MAX_TEXT_LINE_CODEPOINTS'),
    max_svg_bytes: number('MAX_SVG_BYTES'),
  });
});
