// @vitest-environment node
import { expect, test } from 'vitest';

import { readStylesheet } from '../../tests/helpers/styles.js';

const css = readStylesheet();

test('print-only CSS paints a white page above the dark theme backdrop', () => {
  const block = css.slice(css.indexOf('@media print'));
  expect(block).toMatch(
    /html\[data-printing\]:root,\s*html\[data-printing\] body\s*\{[^}]*background:\s*#fff/,
  );
});
