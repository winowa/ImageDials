import { expect, test } from 'vitest';

import vectors from '../../../../fixtures/api/watermark.json';
import policy from '../../../../shared/watermark-policy.json';
import { legacy_rendering as legacyPolicy } from '../../../../fixtures/api/watermark-rule-spacing.json';
import {
  DEFAULT_CORNER,
  fitText,
  contentAnchor,
  analysisMatchesPolicy,
  hasPlacement,
  markGeometry,
  markLayout,
  normalizeCorner,
  normalizeText,
  placementOf,
  resolvePresentation,
  ruleBands,
} from './watermarkGeometry.js';

test.each(vectors.geometry_cases)(
  'geometry matches the shared vector $width×$height $corner',
  ({ width, height, corner, expected }) => {
    expect(markGeometry(width, height, corner, policy)).toMatchObject(expected);
  },
);

test('the mark stays on the image and wide images have no safe-frame gutters', () => {
  for (const [width, height] of [
    [1800, 1200],
    [1200, 1800],
    [1200, 1200],
    [3000, 900],
    [900, 3000],
    [7, 5],
  ])
    for (const corner of [
      'top-left',
      'top-right',
      'bottom-left',
      'bottom-right',
    ]) {
      const g = markGeometry(width, height, corner, policy);
      expect(g.x).toBeGreaterThanOrEqual(0);
      expect(g.y).toBeGreaterThanOrEqual(0);
      expect(g.x + g.size).toBeLessThanOrEqual(width);
      expect(g.y + g.size).toBeLessThanOrEqual(height);
    }
  // Size retains the reference aspect; placement uses the true image edge.
  const wide = markGeometry(3000, 1000, 'bottom-left', policy);
  expect(wide.x).toBe(wide.inset);
});

test('invalid dimensions are rejected, never guessed', () => {
  expect(() => markGeometry(0, 10, 'top-left', policy)).toThrow(RangeError);
  expect(() => markGeometry(10.5, 10, 'top-left', policy)).toThrow(RangeError);
});

test('corners are trimmed and case-normalised; anything else is the default', () => {
  expect(normalizeCorner('  Top-Right ')).toBe('top-right');
  expect(normalizeCorner('middle')).toBe(DEFAULT_CORNER);
  expect(normalizeCorner(undefined)).toBe(DEFAULT_CORNER);
});

test('presentation reads snake or camel hex fields and defaults the rest', () => {
  expect(
    resolvePresentation(
      { gradientStart: '#112233', separation_color: '#ABCDEF', angle: 45 },
      policy,
    ),
  ).toEqual({
    gradientStart: '#112233',
    gradientEnd: '#112233',
    separationColor: '#abcdef',
    glowColor: policy.defaultPresentation.glow_color,
  });
  expect(resolvePresentation(undefined, policy)).toEqual({
    gradientStart: '#ffd15e',
    gradientEnd: '#ffd15e',
    separationColor: '#05070a',
    glowColor: '#05070a',
  });
  // A malformed colour is not repaired into a different valid one.
  expect(
    resolvePresentation({ gradient_start: 'red', gradient_end: '#12' }, policy),
  ).toMatchObject({ gradientStart: '#ffd15e', gradientEnd: '#ffd15e' });
});

test('placement comes from the record analysis only when it has a corner', () => {
  expect(hasPlacement({})).toBe(false);
  expect(hasPlacement({ print_watermark: { position: {} } })).toBe(false);
  const analysis = {
    position: { corner: 'top-left' },
    presentation: { gradient_start: '#00ff00', use_gradient: false },
  };
  expect(hasPlacement({ print_watermark: analysis })).toBe(true);
  expect(placementOf(analysis, policy)).toMatchObject({
    corner: 'top-left',
    presentation: { gradientStart: '#00ff00' },
  });
});

test('rules and content area follow the policy fractions', () => {
  const layout = markLayout(240, policy);
  expect(layout.rule).toBe(Math.round(240 * 0.036));
  expect(layout.gap).toBe(Math.round(240 * 0.064));
  expect(layout.content.y).toBe(layout.pad + layout.rule + layout.gap);
  expect(layout.content.height).toBe(240 - 2 * layout.content.y);
  expect(markLayout(1, policy).content.height).toBeGreaterThanOrEqual(1);
});

test.each(vectors.unicode_text_cases)(
  'text rules match the shared vector %#',
  ({ text, normalized, valid }) => {
    const result = normalizeText(text);
    expect(result.ok).toBe(valid);
    if (normalized) expect(result.text).toBe(normalized);
  },
);

test('text counts code points, not UTF-16 units, and reports the failing line', () => {
  expect(normalizeText('😀'.repeat(16)).ok).toBe(true);
  expect(normalizeText('ok\n' + '😀'.repeat(17))).toEqual({
    ok: false,
    error: 'Line 2 is over 16 characters.',
  });
  expect(normalizeText('A\nB\nC\nD\nE').error).toMatch(/at most 4 lines/);
  expect(normalizeText(' \n ').error).toMatch(/at least one line/);
  expect(normalizeText(null).ok).toBe(false);
});

const ink = (text) => ({
  width: text.length * 0.6,
  ascent: 0.75,
  descent: 0.25,
});
const style = { lineHeight: 1.25, maxFontFraction: 1 };

test('text is fitted to the content area by its widest line and ink height', () => {
  const area = { x: 0, y: 40, width: 200, height: 120 };
  const one = fitText(['abcdefgh'], area, ink, style);
  // Width-bound: 200 / (8 × 0.6).
  expect(one.fontSize).toBeCloseTo(200 / 4.8);
  const many = fitText(['a', 'b', 'c', 'd'], area, ink, style);
  // Height-bound: 120 / (3 × 1.25 + 0.75 + 0.25).
  expect(many.fontSize).toBeCloseTo(120 / 4.75);
  expect(many.baselines.every((c) => c.x === 100)).toBe(true);
  expect(many.glyphs.bottom - many.glyphs.top).toBeCloseTo(120);
  const capped = fitText(['i'], area, ink, { ...style, maxFontFraction: 0.2 });
  expect(capped.fontSize).toBe(40);
});

test('ink bounds are centred in the area and follow the real glyph extents', () => {
  const area = { x: 0, y: 40, width: 200, height: 120 };
  const accented = () => ({ width: 0.6, ascent: 0.9, descent: 0.3 });
  const { fontSize, baselines, glyphs } = fitText(['Å'], area, accented, {
    lineHeight: 1.25,
    maxFontFraction: 0.2,
  });
  expect(glyphs.top + glyphs.bottom).toBeCloseTo(40 + 40 + 120);
  expect(glyphs.bottom - glyphs.top).toBeCloseTo(fontSize * 1.2);
  expect(baselines[0].y - glyphs.top).toBeCloseTo(fontSize * 0.9);
  expect(glyphs.bottom - baselines[0].y).toBeCloseTo(fontSize * 0.3);
});

const gluedPolicy = { ...policy, textRulePlacement: 'glyph-bounds' };

test.each([64, 154, 240, 256, 1000])(
  'glyph-bounds rules keep the same gap above and below any line count (%i px)',
  (size) => {
    const layout = markLayout(size, gluedPolicy);
    for (const lines of [
      ['ImageDials'],
      ['a', 'b', 'c'],
      ['a', 'b', 'c', 'd'],
    ]) {
      const { glyphs } = fitText(lines, layout.content, ink, {
        lineHeight: 1.25,
        maxFontFraction: 0.22,
      });
      const [top, bottom] = ruleBands(size, gluedPolicy, glyphs);
      expect(Math.floor(glyphs.top) - (top.y + top.height)).toBe(layout.gap);
      expect(bottom.y - Math.ceil(glyphs.bottom)).toBe(layout.gap);
      expect(top.y).toBeGreaterThanOrEqual(0);
      expect(bottom.y + bottom.height).toBeLessThanOrEqual(size);
      expect(top.height).toBe(layout.rule);
    }
  },
);

test('legacy policies and artwork keep rules on the square edges', () => {
  const glyphs = { top: 100, bottom: 120 };
  const edges = [
    { y: 0, height: 11 },
    { y: 240 - 11, height: 11 },
  ];
  expect(policy.textRulePlacement).toBe('glyph-bounds');
  const legacy = legacyPolicy;
  expect(ruleBands(240, legacy, glyphs)).toEqual(edges);
  expect(ruleBands(240, legacyPolicy)).toEqual(edges);
});

test.each(vectors.legacy_geometry_cases)(
  'explicit old geometry stays pixel compatible %#',
  ({ width, height, corner, expected }) => {
    expect(
      markGeometry(width, height, corner, vectors.legacy_geometry_policy),
    ).toMatchObject(expected);
  },
);
test('rules are quantitatively thinner at realistic sizes without changing gaps', () => {
  for (const size of [160, 200, 240, 256]) {
    const current = markLayout(size, policy),
      old = markLayout(size, legacyPolicy);
    expect(old.rule - current.rule).toBeGreaterThanOrEqual(1);
    expect(old.rule - current.rule).toBeLessThanOrEqual(2);
    expect(current.gap).toBe(old.gap);
  }
  expect(policy.ruleHeightFraction).toBe(0.036);
});
test.each(['top-left', 'top-right', 'bottom-left', 'bottom-right'])(
  'text follows the scored corner band: %s',
  (corner) => {
    const layout = markLayout(240, policy);
    const fitted = fitText(
      ['Studio'],
      layout.content,
      ink,
      { lineHeight: 1.25, maxFontFraction: 0.22 },
      contentAnchor(policy, corner),
    );
    const bands = ruleBands(240, policy, fitted.glyphs);
    if (corner.startsWith('top')) expect(bands[0].y).toBe(layout.pad);
    else expect(bands[1].y + bands[1].height).toBe(240 - layout.pad);
  },
);
test('current policy rejects stale and unversioned placements while explicit legacy policy accepts its records', () => {
  for (const analysis of [{}, { analysis_version: 'pixel-analysis-v3' }])
    expect(analysisMatchesPolicy(analysis, policy)).toBe(false);
  expect(
    analysisMatchesPolicy({ analysis_version: policy.analysisVersion }, policy),
  ).toBe(true);
  expect(analysisMatchesPolicy({}, vectors.legacy_geometry_policy)).toBe(true);
});

test('current-version analysis from another source is not an overlay', () => {
  const image = {
    sha256: 'a'.repeat(64),
    print_watermark: {
      position: { corner: 'top-left' },
      provenance: {
        generator_version: policy.analysisVersion,
        source_sha256: 'b'.repeat(64),
      },
    },
  };
  expect(hasPlacement(image, policy)).toBe(false);
  image.print_watermark.provenance.source_sha256 = image.sha256;
  expect(hasPlacement(image, policy)).toBe(true);
});
