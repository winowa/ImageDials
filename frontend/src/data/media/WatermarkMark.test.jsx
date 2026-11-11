import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import sharedPolicy from '../../../../shared/watermark-policy.json';
import WatermarkMark from './WatermarkMark.jsx';
import { markFor } from '../../features/watermarks/watermarkRenderer.js';

vi.mock(
  '../../features/watermarks/watermarkRenderer.js',
  async (importOriginal) => ({
    ...(await importOriginal()),
    markFor: vi.fn(),
  }),
);

const policy = sharedPolicy;
const settings = (text) => ({
  type: 'text',
  text,
  rendering: policy,
  limits: { text_max_chars: 16 },
});
const image = {
  id: 'a',
  width: 400,
  height: 300,
  print_watermark: {
    position: { corner: 'bottom-left' },
    analysis_version: policy.analysisVersion,
  },
};

let img;
let imgRef;
let context;

beforeEach(() => {
  img = document.createElement('img');
  for (const [name, value] of [
    ['offsetWidth', 400],
    ['offsetHeight', 300],
    ['offsetLeft', 0],
    ['offsetTop', 0],
    ['complete', true],
  ])
    Object.defineProperty(img, name, { value, configurable: true });
  imgRef = { current: img };
  context = { clearRect: vi.fn(), drawImage: vi.fn() };
  HTMLCanvasElement.prototype.getContext = vi.fn(() => context);
  markFor.mockReset();
});

afterEach(() => vi.restoreAllMocks());

const flush = () => act(async () => {});

describe('WatermarkMark', () => {
  test('valid → invalid (null) → valid never dereferences missing settings', async () => {
    markFor.mockResolvedValue({ mark: document.createElement('canvas') });
    const view = render(
      <WatermarkMark image={image} imgRef={imgRef} settings={settings('ok')} />,
    );
    await flush();
    expect(view.container.querySelector('canvas.wm-mark')).not.toBeNull();

    expect(() =>
      view.rerender(
        <WatermarkMark image={image} imgRef={imgRef} settings={null} />,
      ),
    ).not.toThrow();
    await flush();
    expect(view.container.querySelector('canvas.wm-mark')).toBeNull();

    view.rerender(
      <WatermarkMark
        image={image}
        imgRef={imgRef}
        settings={settings('okay')}
      />,
    );
    await flush();
    expect(view.container.querySelector('canvas.wm-mark')).not.toBeNull();
    expect(context.drawImage).toHaveBeenCalled();
  });

  test('a stale paint resolving after the settings went invalid draws nothing', async () => {
    let resolve;
    markFor.mockReturnValue(new Promise((done) => (resolve = done)));
    const view = render(
      <WatermarkMark image={image} imgRef={imgRef} settings={settings('ok')} />,
    );
    await flush();
    view.rerender(
      <WatermarkMark image={image} imgRef={imgRef} settings={null} />,
    );
    await flush();
    await act(async () => resolve({ mark: document.createElement('canvas') }));
    expect(context.drawImage).not.toHaveBeenCalled();
    expect(view.container.querySelector('canvas.wm-mark')).toBeNull();
  });

  test('an unavailable 2D context or a failed render leaves the app standing', async () => {
    HTMLCanvasElement.prototype.getContext = vi.fn(() => null);
    markFor.mockResolvedValue({ mark: document.createElement('canvas') });
    render(
      <WatermarkMark image={image} imgRef={imgRef} settings={settings('ok')} />,
    );
    await flush();
    markFor.mockRejectedValue(new Error('boom'));
    render(
      <WatermarkMark image={image} imgRef={imgRef} settings={settings('x')} />,
    );
    await flush();
  });
});

test.each(['pixel-analysis-v3', 'pixel-analysis-v4', undefined])(
  'stale or unversioned analysis is never overlaid (%s)',
  async (version) => {
    const stale = {
      ...image,
      print_watermark: { ...image.print_watermark, analysis_version: version },
    };
    const view = render(
      <WatermarkMark image={stale} imgRef={imgRef} settings={settings('ok')} />,
    );
    await flush();
    expect(view.container.querySelector('canvas.wm-mark')).toBeNull();
    expect(markFor).not.toHaveBeenCalled();
  },
);

test('baked derivatives never receive a second overlay', async () => {
  const view = render(
    <WatermarkMark
      image={{ ...image, derivative_type: 'watermarked' }}
      imgRef={imgRef}
      settings={settings('ok')}
    />,
  );
  await flush();
  expect(view.container.querySelector('canvas.wm-mark')).toBeNull();
  expect(markFor).not.toHaveBeenCalled();
});
