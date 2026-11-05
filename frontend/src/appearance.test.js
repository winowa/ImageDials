// @vitest-environment node
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

import {
  ACCENT_VERSION,
  blend,
  contrastRatio,
  DEFAULT_ACCENT,
  LUMINANCE,
  MIN_FOCUS_CONTRAST,
  MIN_TEXT_CONTRAST,
  NEUTRALS,
  oklchToBytes,
  parseHex,
  resolveAccent,
  requestedContrastStatus,
  relativeLuminance,
  resolveTheme,
  SATURATION,
  sanitizeAccent,
  sanitizeMode,
  SWATCHES,
} from './appearance.js';

const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8');

/** Neutral tokens declared in one CSS rule, as [L, C, hue]. */
function cssNeutrals(selector) {
  const block = css.slice(css.indexOf(selector));
  const body = block.slice(0, block.indexOf('\n}'));
  const read = (name) => {
    const m = new RegExp(
      `--${name}: oklch\\(([\\d.]+) ([\\d.]+) ([\\d.]+)\\)`,
    ).exec(body);
    return m.slice(1).map(Number);
  };
  return {
    background: read('background'),
    surface: read('surface'),
    surface2: read('surface-2'),
    foreground: read('foreground'),
    muted: read('muted'),
  };
}

const bytes = (theme) =>
  Object.fromEntries(
    Object.entries(NEUTRALS[theme]).map(([k, [l, c, h]]) => [
      k,
      oklchToBytes(l, c, h),
    ]),
  );

test('contrast helper matches known WCAG values', () => {
  expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
  expect(contrastRatio([119, 119, 119], [255, 255, 255])).toBeCloseTo(4.48, 1);
});

test('measured neutrals are the stylesheet neutrals', () => {
  expect(cssNeutrals(':root {')).toEqual(NEUTRALS.dark);
  expect(cssNeutrals(":root[data-theme='light'] {")).toEqual(NEUTRALS.light);
});

test('control headers use a measured neutral surface rather than an unmeasured accent tint', () => {
  const panel = css.slice(css.indexOf('.control-panel {'));
  expect(panel.slice(0, panel.indexOf('\n}'))).toContain(
    '--control-band: var(--surface);',
  );
});

test('full-saturation Rebecca has an unadjusted passing luminance in both themes', () => {
  for (const [theme, luminance] of [
    ['dark', 150],
    ['light', 100],
  ]) {
    const result = resolveAccent(theme, {
      swatch: 'rebecca',
      saturation: 100,
      luminance,
    });
    expect(luminance).toBeLessThanOrEqual(LUMINANCE.max);
    expect(result.requested.ratio).toBeGreaterThanOrEqual(4.5);
    expect(result.limited).toBe(false);
    expect(result.hex).toBe(result.requested.hex);
    expect(result.measured.accentText).toBeGreaterThanOrEqual(4.5);
  }
});

test('the stylesheet fallback accent is the default accent in each theme', () => {
  for (const [selector, theme] of [
    [':root {', 'dark'],
    [":root[data-theme='light'] {", 'light'],
  ]) {
    const block = css.slice(css.indexOf(selector));
    const body = block.slice(0, block.indexOf('\n}'));
    const { tokens } = resolveAccent(theme);
    for (const [name, value] of Object.entries(tokens))
      expect(body).toContain(`${name}: ${value};`);
  }
});

test('every swatch at every slider extreme keeps measured contrast, in both themes', () => {
  const settings = [];
  for (const saturation of [SATURATION.min, SATURATION.initial, SATURATION.max])
    for (const luminance of [LUMINANCE.min, LUMINANCE.initial, LUMINANCE.max])
      settings.push({ saturation, luminance });
  for (const theme of ['dark', 'light']) {
    const n = bytes(theme);
    const surfaces = [n.background, n.surface, n.surface2];
    for (const swatch of SWATCHES)
      for (const setting of settings) {
        const { tokens, hex } = resolveAccent(theme, {
          swatch: swatch.id,
          ...setting,
        });
        const label = `${theme} ${swatch.id} ${JSON.stringify(setting)}`;
        const accent = parseHex(tokens['--accent']);
        const ink = parseHex(tokens['--accent-ink']);
        const focus = parseHex(tokens['--focus']);
        const alpha = parseInt(tokens['--accent-soft'].slice(7), 16) / 255;
        expect(hex).toBe(tokens['--accent']);
        for (const surface of surfaces) {
          expect(contrastRatio(accent, surface), label).toBeGreaterThanOrEqual(
            MIN_TEXT_CONTRAST,
          );
          expect(contrastRatio(focus, surface), label).toBeGreaterThanOrEqual(
            MIN_FOCUS_CONTRAST,
          );
        }
        expect(contrastRatio(ink, accent), label).toBeGreaterThanOrEqual(
          MIN_TEXT_CONTRAST,
        );
        for (const base of [n.surface, n.surface2])
          for (const text of [n.foreground, n.muted])
            expect(
              contrastRatio(text, blend(accent, base, alpha)),
              label,
            ).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
      }
  }
});

test('saturation and luminance change the accent, and limiting is reported', () => {
  const base = resolveAccent('dark', { ...DEFAULT_ACCENT, swatch: 'blue' });
  const vivid = resolveAccent('dark', {
    swatch: 'blue',
    saturation: SATURATION.max,
    luminance: 100,
  });
  const brighter = resolveAccent('dark', {
    swatch: 'blue',
    saturation: 100,
    luminance: 115,
  });
  expect(vivid.hex).not.toBe(base.hex);
  expect(brighter.hex).not.toBe(base.hex);
  expect(base.limited).toBe(false);
  const dim = resolveAccent('dark', {
    swatch: 'blue',
    saturation: 100,
    luminance: LUMINANCE.min,
  });
  expect(dim.limited).toBe(true);
  expect(dim.measured.accentText).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
});

test('stored values recover safely', () => {
  expect(sanitizeMode('system')).toBe('system');
  expect(sanitizeMode('light')).toBe('light');
  for (const bad of [null, undefined, '', 'purple', 3, {}])
    expect(sanitizeMode(bad)).toBe('dark');
  expect(resolveTheme('system', true)).toBe('light');
  expect(resolveTheme('system', false)).toBe('dark');
  expect(resolveTheme('dark', true)).toBe('dark');
  for (const bad of [
    null,
    'x',
    7,
    [],
    { v: 99, swatch: 'blue' },
    { swatch: 'blue' },
  ])
    expect(sanitizeAccent(bad)).toEqual(DEFAULT_ACCENT);
  expect(
    sanitizeAccent({
      v: ACCENT_VERSION,
      swatch: 'nope',
      saturation: 'lots',
      luminance: 1e9,
    }),
  ).toEqual({ ...DEFAULT_ACCENT, luminance: LUMINANCE.max });
  expect(
    sanitizeAccent({
      v: ACCENT_VERSION,
      swatch: 'teal',
      saturation: 52,
      luminance: NaN,
    }),
  ).toEqual({ swatch: 'teal', saturation: 50, luminance: 100 });
});

test('named presets reach their exact full-saturation anchors without changing safe applied tokens', () => {
  for (const theme of ['dark', 'light']) {
    for (const [swatch, anchor] of [
      ['rebecca', '#663399'],
      ['lagoon', '#00a8b5'],
    ]) {
      const result = resolveAccent(theme, {
        swatch,
        saturation: SATURATION.initial,
        luminance: 100,
      });
      expect(result.requested.hex).toBe(anchor);
      expect(result.requested.ratio).toBe(
        contrastRatio(
          parseHex(anchor),
          parseHex(result.requested.background.hex),
        ),
      );
      expect(result.measured.accentText).toBeGreaterThanOrEqual(4.5);
      expect(result.measured.buttonText).toBeGreaterThanOrEqual(4.5);
    }
  }
  expect(
    resolveAccent('light', {
      swatch: 'rebecca',
      saturation: 100,
      luminance: 100,
    }).hex,
  ).toBe('#663399');
  expect(
    resolveAccent('dark', {
      swatch: 'rebecca',
      saturation: 100,
      luminance: 100,
    }).hex,
  ).not.toBe('#663399');
});

test('requested contrast uses the theme extreme rather than the lowest applied contrast surface', () => {
  for (const theme of ['dark', 'light']) {
    const result = resolveAccent(theme);
    const backgrounds = Object.entries(bytes(theme)).filter(([name]) =>
      ['background', 'surface', 'surface2'].includes(name),
    );
    const chosen = parseHex(result.requested.background.hex);
    const luminance = relativeLuminance(chosen);
    for (const [, background] of backgrounds) {
      if (theme === 'dark')
        expect(luminance).toBeLessThanOrEqual(relativeLuminance(background));
      else
        expect(luminance).toBeGreaterThanOrEqual(relativeLuminance(background));
    }
    expect(result.requested.background.name).toBe(
      theme === 'dark' ? 'background' : 'surface',
    );
  }
});

test.each([
  [2.999999, 'error', 'Below AA'],
  [3, 'error', 'Below AA'],
  [4.499999, 'error', 'Below AA'],
  [4.5, 'warning', 'Near limit'],
  [4.999999, 'warning', 'Near limit'],
  [5, 'pass', 'AA'],
  [6.999999, 'pass', 'AA'],
  [7, 'pass', 'AAA'],
])(
  'requested contrast classifies unrounded ratio %s',
  (value, level, grade) => {
    expect(requestedContrastStatus(value)).toMatchObject({ level, grade });
  },
);

test('the warning margin is separate from a genuine AA failure and control failure', () => {
  expect(requestedContrastStatus(2.99).message).toContain('3:1 for controls');
  expect(requestedContrastStatus(3).message).not.toContain('3:1 for controls');
  expect(requestedContrastStatus(4.5).message).toContain('Near');
});

test.each(['rebecca', 'lagoon'])(
  'the %s preset restores from the existing stored record version',
  (swatch) => {
    expect(
      sanitizeAccent({
        v: ACCENT_VERSION,
        swatch,
        saturation: 150,
        luminance: 100,
      }),
    ).toEqual({ swatch, saturation: 150, luminance: 100 });
  },
);
