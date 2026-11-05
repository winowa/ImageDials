// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vitest';

const css = readFileSync(
  fileURLToPath(new URL('./index.css', import.meta.url)),
  'utf8',
);
const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
const rulesFor = (selector) =>
  [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selectors]) =>
      selectors
        .split(',')
        .map((s) => s.trim())
        .includes(selector),
    )
    .map(([, , body]) => body);

test('pressing a chip moves only its visible pill, never the 44px hit box', () => {
  // A transform on the chip itself would shrink the target while pressed.
  expect(rulesFor('.chip:active')).toEqual([]);
  const pill = rulesFor('.chip:active::before');
  expect(pill).toHaveLength(1);
  expect(pill[0]).toMatch(/transform:\s*scale\(/);
  // The pill is allowed to animate that transform.
  expect(rulesFor('.chip::before').join()).toMatch(/transform var/);
});
