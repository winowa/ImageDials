import { describe, expect, test } from 'vitest';

import {
  aspectsDiffer,
  clampView,
  comparisonSources,
  defaultSourceId,
  dividerForKey,
  dividerFromPoint,
  FIT_VIEW,
  fitBox,
  panBy,
  sourceLabel,
  viewForKey,
  viewTransform,
  ZOOM_MAX,
  zoomAt,
} from './comparison.js';
import { REF_STATUS } from '../references/references.js';

const blob = (label) => new Blob([label], { type: 'image/png' });

const ready = (id, sha256, extra = {}) => ({
  id,
  sha256,
  name: `${id}.png`,
  blob: blob(id),
  status: REF_STATUS.ready,
  dimensions: { width: 800, height: 600 },
  ...extra,
});

const editResult = {
  id: 'result-1',
  sha256: 'result-sha',
  generation_type: 'image-edit',
  width: 1200,
  height: 800,
  reference_images: [
    { id: 'upload:base', sha256: 'base-sha', role: 'base' },
    { id: 'upload:extra', sha256: 'extra-sha', role: 'reference' },
  ],
};

describe('comparisonSources', () => {
  test('keeps only references whose exact bytes are held, and marks recorded sources', () => {
    const refs = [
      ready('upload:other', 'other-sha'),
      ready('upload:extra', 'extra-sha'),
      ready('upload:base', 'base-sha'),
      { ...ready('upload:missing', 'missing-sha'), status: REF_STATUS.missing },
      { ...ready('upload:reading', null), status: REF_STATUS.reading },
      { ...ready('upload:nobytes', 'nobytes-sha'), blob: null },
    ];
    const sources = comparisonSources(editResult, refs);
    expect(sources.map((s) => [s.id, s.matched, s.recordedIndex])).toEqual([
      ['upload:other', false, -1],
      ['upload:extra', true, 1],
      ['upload:base', true, 0],
    ]);
    expect(sources[0].blob).toBe(refs[0].blob);
  });

  test('leaves out a reference holding the result itself', () => {
    const sources = comparisonSources(editResult, [
      ready('image:result-1', 'result-sha'),
    ]);
    expect(sources).toEqual([]);
  });

  test('matches nothing for a text-generated result', () => {
    const text = { id: 'r', sha256: 'r-sha', generation_type: 'text' };
    const [only] = comparisonSources(text, [ready('upload:a', 'a-sha')]);
    expect(only.matched).toBe(false);
    expect(sourceLabel(only)).toBe('Reference');
  });

  test('defaults to the recorded base, then other recorded sources, then the first reference', () => {
    const all = comparisonSources(editResult, [
      ready('upload:other', 'other-sha'),
      ready('upload:extra', 'extra-sha'),
      ready('upload:base', 'base-sha'),
    ]);
    expect(defaultSourceId(all)).toBe('upload:base');
    expect(defaultSourceId(all.filter((s) => s.id !== 'upload:base'))).toBe(
      'upload:extra',
    );
    expect(defaultSourceId(all.filter((s) => !s.matched))).toBe('upload:other');
    expect(defaultSourceId([])).toBeNull();
  });

  test('only a recorded source is labelled as the source', () => {
    expect(sourceLabel({ matched: true })).toBe('Source');
    expect(sourceLabel({ matched: false })).toBe('Reference');
  });
});

describe('fit and aspect', () => {
  test('fits the largest centered box of the image aspect', () => {
    expect(
      fitBox({ width: 1000, height: 600 }, { width: 1600, height: 900 }),
    ).toEqual({ left: 0, top: 18.75, width: 1000, height: 562.5 });
    expect(
      fitBox({ width: 1000, height: 600 }, { width: 600, height: 900 }),
    ).toEqual({ left: 300, top: 0, width: 400, height: 600 });
    expect(fitBox({ width: 500, height: 400 }, null)).toEqual({
      left: 0,
      top: 0,
      width: 500,
      height: 400,
    });
  });

  test('reports visibly different aspect ratios only', () => {
    expect(
      aspectsDiffer(
        { width: 1024, height: 1024 },
        { width: 1536, height: 1024 },
      ),
    ).toBe(true);
    expect(
      aspectsDiffer({ width: 512, height: 341 }, { width: 1536, height: 1024 }),
    ).toBe(false);
    expect(aspectsDiffer(null, { width: 2, height: 1 })).toBe(false);
  });
});

describe('shared view', () => {
  const frame = { width: 1000, height: 500 };

  test('keeps zoomed content covering the frame', () => {
    expect(clampView({ zoom: 1, x: 40, y: -40 }, frame)).toEqual(FIT_VIEW);
    expect(clampView({ zoom: 2, x: 900, y: -900 }, frame)).toEqual({
      zoom: 2,
      x: 500,
      y: -250,
    });
    expect(clampView({ zoom: 99, x: 0, y: 0 }, frame).zoom).toBe(ZOOM_MAX);
    expect(clampView({ zoom: 0.2, x: 0, y: 0 }, frame).zoom).toBe(1);
  });

  test('zooming about a point keeps the content under it still', () => {
    const point = { x: 800, y: 100 };
    const start = { zoom: 1.5, x: -50, y: 20 };
    const next = zoomAt(start, 3, frame, point);
    // Content coordinate under the point before and after.
    const content = (view) => ({
      x: (point.x - frame.width / 2 - view.x) / view.zoom,
      y: (point.y - frame.height / 2 - view.y) / view.zoom,
    });
    expect(next.zoom).toBe(3);
    expect(content(next).x).toBeCloseTo(content(start).x);
    expect(content(next).y).toBeCloseTo(content(start).y);
  });

  test('zooming back out to fit recenters', () => {
    expect(zoomAt({ zoom: 4, x: 900, y: 300 }, 1, frame)).toEqual(FIT_VIEW);
  });

  test('keyboard zooms, pans toward the named side and fits', () => {
    const zoomed = viewForKey('+', FIT_VIEW, frame);
    expect(zoomed.zoom).toBe(1.5);
    expect(viewForKey('-', zoomed, frame)).toEqual(FIT_VIEW);
    expect(viewForKey('ArrowLeft', zoomed, frame).x).toBe(100);
    expect(viewForKey('ArrowDown', zoomed, frame).y).toBe(-50);
    expect(viewForKey('0', zoomed, frame)).toBe(FIT_VIEW);
    expect(viewForKey('ArrowLeft', FIT_VIEW, frame)).toEqual(FIT_VIEW);
    expect(viewForKey('x', zoomed, frame)).toBeNull();
  });

  test('pans within bounds and renders one shared transform', () => {
    const view = panBy({ zoom: 2, x: 0, y: 0 }, 5000, 10, frame);
    expect(view).toEqual({ zoom: 2, x: 500, y: 10 });
    expect(viewTransform(view)).toBe('translate(500px, 10px) scale(2)');
  });
});

describe('divider', () => {
  test('follows the pointer within the frame', () => {
    const rect = { left: 100, width: 400 };
    expect(dividerFromPoint(200, rect)).toBe(25);
    expect(dividerFromPoint(-50, rect)).toBe(0);
    expect(dividerFromPoint(9999, rect)).toBe(100);
    expect(dividerFromPoint(10, { left: 0, width: 0 })).toBe(50);
  });

  test('moves by slider keys and clamps', () => {
    expect(dividerForKey('ArrowRight', 50)).toBe(55);
    expect(dividerForKey('ArrowDown', 2)).toBe(0);
    expect(dividerForKey('PageUp', 90)).toBe(100);
    expect(dividerForKey('Home', 40)).toBe(0);
    expect(dividerForKey('End', 40)).toBe(100);
    expect(dividerForKey('Enter', 40)).toBeNull();
  });
});
