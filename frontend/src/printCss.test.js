// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const css = readFileSync(
  fileURLToPath(new URL('./index.css', import.meta.url)),
  'utf8',
);

test('print-only CSS paints a white page above the dark theme backdrop', () => {
  const block = css.slice(css.indexOf('@media print'));
  expect(block).toMatch(
    /html\[data-printing\]:root,\s*html\[data-printing\] body\s*\{[^}]*background:\s*#fff/,
  );
});
