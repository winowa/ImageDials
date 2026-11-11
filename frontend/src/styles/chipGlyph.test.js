// @vitest-environment node
import { expect, test } from 'vitest';

import { readStylesheet } from '../../tests/helpers/styles.js';

/**
 * jsdom does not resolve the cascade by specificity, so the checked-glyph
 * regression is guarded on the stylesheet itself: a rule that reveals a chip's
 * check mark must never lose to one that hides it.
 */
const css = readStylesheet();

/** [ids, classes/attributes/pseudo-classes, types/pseudo-elements] */
function specificity(selector) {
  let [a, b, c] = [0, 0, 0];
  let rest = selector;
  // :has/:is/:not take the specificity of their most specific argument.
  for (;;) {
    const match = /:(?:has|is|not)\(([^()]*)\)/.exec(rest);
    if (!match) break;
    const inner = match[1]
      .split(',')
      .map(specificity)
      .reduce((best, s) => (compare(s, best) > 0 ? s : best), [0, 0, 0]);
    [a, b, c] = [a + inner[0], b + inner[1], c + inner[2]];
    rest = rest.replace(match[0], '');
  }
  a += (rest.match(/#[\w-]+/g) ?? []).length;
  b += (rest.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) ?? []).length;
  c += (rest.match(/::[\w-]+/g) ?? []).length;
  const types = rest
    .replace(/\[[^\]]*\]|[.#:][\w-]+/g, ' ')
    .split(/[\s>+~]+/)
    .filter((part) => /^[a-z][\w-]*$/i.test(part));
  return [a, b, c + types.length];
}

const compare = (x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2];

/** Declared `property` values per selector, in source order. */
function declarations(property) {
  const found = [];
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  for (const [, selectors, body] of css.matchAll(rule)) {
    const value = new RegExp(`(?:^|[;\\s])${property}:\\s*([^;]+)`).exec(body);
    if (!value) continue;
    for (const selector of selectors.split(',')) {
      found.push({ selector: selector.trim(), value: value[1].trim() });
    }
  }
  return found;
}

test('a selected multi-select chip reveals its check glyph', () => {
  const glyph = declarations('opacity').filter(({ selector }) =>
    /\.chip-mark\s+\.icon$/.test(selector),
  );
  const hides = glyph.filter(({ value }) => value === '0');
  const shows = glyph.filter(({ value }) => value === '1');
  expect(hides.length).toBeGreaterThan(0);
  expect(shows.length).toBeGreaterThan(0);
  for (const show of shows)
    for (const hide of hides)
      expect(
        compare(specificity(show.selector), specificity(hide.selector)),
        `${show.selector} must outrank ${hide.selector}`,
      ).toBeGreaterThan(0);
});

test('specificity helper counts :has() arguments', () => {
  expect(
    specificity(".chip:has(input[type='checkbox']) .chip-mark .icon"),
  ).toEqual([0, 4, 1]);
  expect(specificity(".chip[data-checked='true'] .chip-mark .icon")).toEqual([
    0, 4, 0,
  ]);
});
