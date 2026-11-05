import { beforeEach, expect, test, vi } from 'vitest';

import sharedPolicy from '../../shared/watermark-policy.json';
import { legacy_rendering as legacyPolicy } from '../../fixtures/api/watermark-rule-spacing.json';
import { markFor } from './watermarkRenderer.js';
import { markLayout } from './watermarkGeometry.js';

const presentation = {
  gradientStart: '#112233',
  gradientEnd: '#445566',
  separationColor: '#000000',
  glowColor: '#ffffff',
};
const policyOf = (glowOpacity) => ({ ...sharedPolicy, glowOpacity });

beforeEach(() => {
  const gradient = { addColorStop: vi.fn() };
  HTMLCanvasElement.prototype.getContext = vi.fn(function () {
    return new Proxy(
      {
        createLinearGradient: () => gradient,
        measureText: () => ({ width: 60 }),
      },
      { get: (t, k) => t[k] ?? (() => {}), set: () => true },
    );
  });
});

test('mark layers are keyed by rendering policy as well as content', async () => {
  const call = (policy, text = 'ab') =>
    markFor({
      settings: { type: 'text', text },
      limits: { text_max_chars: 16, text_max_lines: 3 },
      presentation,
      policy,
      pixelSize: 64,
    });
  const first = await call(policyOf(0.3));
  expect(first.mark).toBeTruthy();
  expect((await call(policyOf(0.3))).mark).toBe(first.mark);
  expect((await call({ ...policyOf(0.3) })).mark).toBe(first.mark);
  const changed = await call(policyOf(0.6));
  expect(changed.mark).toBeTruthy();
  expect(changed.mark).not.toBe(first.mark);
});

/** Records fills on every canvas so rule rectangles and text baselines can be read. */
function recordingCanvases(metrics) {
  const calls = [];
  HTMLCanvasElement.prototype.getContext = vi.fn(function () {
    return new Proxy(
      {
        createLinearGradient: () => ({ addColorStop: vi.fn() }),
        measureText: () => metrics,
        fillRect: (...args) => calls.push(['rect', ...args]),
        fillText: (...args) => calls.push(['text', ...args]),
      },
      {
        get: (t, k) => t[k] ?? (() => {}),
        set: (t, k, v) => {
          if (k === 'font')
            calls.push(['font', Number.parseFloat(v.split(' ')[1])]);
          t[k] = v;
          return true;
        },
      },
    );
  });
  return calls;
}

const render = (policy, text, pixelSize) =>
  markFor({
    settings: { type: 'text', text },
    limits: { max_lines: 4, max_line_length: 16 },
    presentation,
    policy,
    pixelSize,
  });

test.each([
  ['ImageDials', 154],
  ['North\nSouth\nEast\nWest', 256],
  ['Ångström\ngyp jq', 64],
])(
  'text rules sit one fixed gap from the drawn glyphs: %j',
  async (text, size) => {
    const calls = recordingCanvases({
      width: 60,
      actualBoundingBoxAscent: 80,
      actualBoundingBoxDescent: 25,
    });
    await render(sharedPolicy, text, size);
    const [top, bottom] = calls.filter((c) => c[0] === 'rect').slice(-2);
    const baselines = calls.filter((c) => c[0] === 'text').map((c) => c[3]);
    const fontSize = calls.findLast((c) => c[0] === 'font')[1];
    const gap = Math.round(size * sharedPolicy.contentGapFraction);
    const rule = Math.round(size * sharedPolicy.ruleHeightFraction);
    const inkTop = baselines[0] - 0.8 * fontSize;
    const inkBottom = baselines.at(-1) + 0.25 * fontSize;
    expect(top[4]).toBe(rule);
    expect(Math.floor(inkTop + 1e-6) - (top[2] + rule)).toBe(gap);
    expect(bottom[2] - Math.ceil(inkBottom - 1e-6)).toBe(gap);
  },
);

test('missing ink metrics fall back instead of failing', async () => {
  const calls = recordingCanvases({ width: 60 });
  expect((await render(sharedPolicy, 'ab', 128)).mark).toBeTruthy();
  expect(calls.some((c) => c[0] === 'text')).toBe(true);
});

test('a legacy policy draws text rules on the square edges', async () => {
  const calls = recordingCanvases({ width: 60, actualBoundingBoxAscent: 75 });
  const legacy = legacyPolicy;
  await render(legacy, 'ab', 100);
  const rects = calls.filter((c) => c[0] === 'rect').slice(-2);
  expect(rects.map((c) => c[2])).toEqual([0, 100 - Math.round(100 * 0.044)]);
});

test.each([
  ['xy', 100],
  ['One\nTwo\nThree', 240],
  ['North\nSouth\nEast\nWest', 256],
])(
  'a policy without textRulePlacement keeps the original v1 text layout: %j',
  async (text, size) => {
    const calls = recordingCanvases({
      width: 60,
      actualBoundingBoxAscent: 80,
      actualBoundingBoxDescent: 25,
    });
    const legacy = legacyPolicy;
    await render(legacy, text, size);
    // The v1 recipe: size from advance width and line pitch only, lines
    // centred on a 1.25 pitch with a middle baseline, rules on the edges.
    const lines = text.split('\n');
    const gap = Math.round(size * legacy.contentGapFraction);
    const rule = Math.max(1, Math.round(size * legacy.ruleHeightFraction));
    const area = { width: size, height: Math.max(1, size - 2 * (rule + gap)) };
    const advance = 0.6; // the mock's 60px advance at the 100px reference
    const fontSize = Math.max(
      1,
      Math.min(
        area.width / advance,
        area.height / (lines.length * 1.25),
        area.width * 0.22,
      ),
    );
    const pitch = fontSize * 1.25;
    const first =
      rule + gap + area.height / 2 - (pitch * (lines.length - 1)) / 2;
    expect(calls.findLast((c) => c[0] === 'font')[1]).toBeCloseTo(fontSize);
    const ys = calls.filter((c) => c[0] === 'text').map((c) => c[3]);
    expect(ys).toHaveLength(lines.length);
    ys.forEach((y, index) => expect(y).toBeCloseTo(first + pitch * index));
    const rects = calls.filter((c) => c[0] === 'rect').slice(-2);
    expect(rects.map((c) => c[2])).toEqual([0, size - rule]);
  },
);

test('top and bottom corners draw distinct cached layers at their scored outer edges', async () => {
  const calls = recordingCanvases({
    width: 60,
    actualBoundingBoxAscent: 80,
    actualBoundingBoxDescent: 25,
  });
  const options = {
    settings: { type: 'text', text: 'Corner proof' },
    presentation,
    policy: sharedPolicy,
    pixelSize: 240,
  };
  const top = await markFor({ ...options, corner: 'top-left' });
  const topBands = calls.filter((c) => c[0] === 'rect').slice(-2);
  const bottom = await markFor({ ...options, corner: 'bottom-left' });
  const bottomBands = calls.filter((c) => c[0] === 'rect').slice(-2);
  const layout = markLayout(240, sharedPolicy);
  expect(top.mark).not.toBe(bottom.mark);
  expect(topBands[0].slice(1)).toEqual([
    layout.pad,
    layout.pad,
    240 - 2 * layout.pad,
    layout.rule,
  ]);
  expect(bottomBands[1][2] + bottomBands[1][4]).toBe(240 - layout.pad);
});
