import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import ImageComparison from './ImageComparison.jsx';

vi.mock('./ui.jsx', () => ({
  Icon: () => null,
  SavedImg: ({ image, onReady, className }) => (
    <img
      className={className}
      alt={image.alt_text}
      data-testid="result-original"
      src={`/files/${image.id}.png`}
      onLoad={() => onReady?.()}
    />
  ),
}));

const image = {
  id: 'result-1',
  title: 'Harbor at dusk',
  alt_text: 'A harbor at dusk',
  sha256: 'result-sha',
  width: 1600,
  height: 900,
};

const source = (id, extra = {}) => ({
  id,
  blob: new Blob([id], { type: 'image/png' }),
  sha256: `${id}-sha`,
  name: `${id}.png`,
  dimensions: { width: 1600, height: 900 },
  matched: false,
  recordedIndex: -1,
  ...extra,
});

let created;
let revoked;
let urlFor;
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
const STAGE = { width: 1000, height: 600 };
// 1600×900 fitted into 1000×600: 1000×562.5.
const FRAME = { left: 0, top: 0, width: 1000, height: 562.5 };

beforeEach(() => {
  created = [];
  revoked = [];
  urlFor = new Map();
  let n = 0;
  URL.createObjectURL = vi.fn((blob) => {
    const url = `blob:cmp-${(n += 1)}`;
    created.push(url);
    urlFor.set(url, blob);
    return url;
  });
  URL.revokeObjectURL = vi.fn((url) => revoked.push(url));
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return this.classList.contains('cmp-stage') ? STAGE.width : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return this.classList.contains('cmp-stage') ? STAGE.height : 0;
    },
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function rect() {
      const box = this.classList.contains('cmp-frame')
        ? FRAME
        : { left: 0, top: 0, width: 0, height: 0 };
      return {
        ...box,
        right: box.left + box.width,
        bottom: box.top + box.height,
        x: box.left,
        y: box.top,
      };
    },
  );
});

afterEach(() => {
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
  // The overrides shadow Element.prototype's getters; removing them restores those.
  delete HTMLElement.prototype.clientWidth;
  delete HTMLElement.prototype.clientHeight;
  vi.restoreAllMocks();
});

const split = () =>
  document.querySelector('.cmp-frame').style.getPropertyValue('--cmp-split');
const transforms = () =>
  [...document.querySelectorAll('.cmp-content')].map((n) => n.style.transform);
const beforeImg = () => document.querySelector('.cmp-before img');

describe('ImageComparison', () => {
  test('defaults to the recorded source, labels both sides and sizes the frame to the result', () => {
    const sources = [
      source('upload:other'),
      source('upload:base', {
        matched: true,
        recordedIndex: 0,
        dimensions: { width: 1024, height: 1024 },
      }),
    ];
    render(
      <ImageComparison image={image} sources={sources} onClose={() => {}} />,
    );
    expect(screen.getByRole('dialog', { name: 'Compare' })).toBeTruthy();
    const slider = screen.getByRole('slider', { name: 'Divider' });
    expect(document.activeElement).toBe(slider);
    expect(screen.getByRole('combobox', { name: 'With' }).value).toBe(
      'upload:base',
    );
    expect(beforeImg().getAttribute('alt')).toBe('Source: upload:base.png');
    expect(urlFor.get(beforeImg().getAttribute('src'))).toBe(sources[1].blob);
    expect(screen.getByText('Source · 1024×1024')).toBeTruthy();
    expect(screen.getByText('Result · 1600×900')).toBeTruthy();
    expect(
      screen.getByText('Different aspect ratios, fitted separately'),
    ).toBeTruthy();
    const frame = document.querySelector('.cmp-frame');
    expect(frame.style.width).toBe('1000px');
    expect(frame.style.height).toBe('562.5px');
  });

  test('an unrelated reference is never called the source', () => {
    render(
      <ImageComparison
        image={image}
        sources={[source('upload:draft')]}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByText('Reference · 1600×900')).toBeTruthy();
    expect(screen.queryByText(/^Source/)).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Hold for reference' }),
    ).toBeTruthy();
  });

  test('moves the divider by keyboard and by dragging the handle', () => {
    render(
      <ImageComparison
        image={image}
        sources={[source('upload:a')]}
        onClose={() => {}}
      />,
    );
    const slider = screen.getByRole('slider', { name: 'Divider' });
    expect(split()).toBe('50%');
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(slider.getAttribute('aria-valuenow')).toBe('55');
    expect(slider.getAttribute('aria-valuetext')).toBe(
      '55% reference, 45% result',
    );
    fireEvent.keyDown(slider, { key: 'Home' });
    expect(split()).toBe('0%');
    fireEvent.pointerDown(slider, { pointerId: 3, clientX: 250, button: 0 });
    expect(split()).toBe('25%');
    expect(document.querySelector('.cmp-stage').dataset.gesture).toBe(
      'divider',
    );
    fireEvent.pointerMove(slider, { pointerId: 3, clientX: 750 });
    expect(split()).toBe('75%');
    // An interrupted drag ends cleanly and further moves do nothing.
    fireEvent.pointerCancel(slider, { pointerId: 3 });
    expect(document.querySelector('.cmp-stage').dataset.gesture).toBe(
      undefined,
    );
    fireEvent.pointerMove(slider, { pointerId: 3, clientX: 100 });
    expect(split()).toBe('75%');
  });

  test('both images share zoom and pan, bounded to the frame, with fit', () => {
    render(
      <ImageComparison
        image={image}
        sources={[source('upload:a')]}
        onClose={() => {}}
      />,
    );
    const stage = screen.getByRole('group', { name: 'Comparison image' });
    const fit = screen.getByRole('button', { name: 'Fit' });
    expect(fit.disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Zoom out' }).disabled).toBe(
      true,
    );
    // At fit, dragging does not move anything.
    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 500, clientY: 200 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 700, clientY: 200 });
    fireEvent.pointerUp(stage, { pointerId: 1 });
    expect(transforms()).toEqual([
      'translate(0px, 0px) scale(1)',
      'translate(0px, 0px) scale(1)',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByText('150%')).toBeTruthy();
    // Pan far right: clamped to (1.5 - 1) * 1000 / 2 = 250.
    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 100, clientY: 200 });
    expect(stage.dataset.gesture).toBe('pan');
    fireEvent.pointerMove(stage, {
      pointerId: 1,
      clientX: 2000,
      clientY: 230,
    });
    const [after, before] = transforms();
    expect(after).toBe(before);
    expect(after).toBe('translate(250px, 30px) scale(1.5)');
    fireEvent.lostPointerCapture(stage, { pointerId: 1 });
    expect(stage.dataset.gesture).toBe(undefined);
    stage.focus();
    fireEvent.keyDown(stage, { key: '0' });
    expect(transforms()[0]).toBe('translate(0px, 0px) scale(1)');
    fireEvent.keyDown(stage, { key: '+' });
    fireEvent.keyDown(stage, { key: '+' });
    expect(screen.getByText('225%')).toBeTruthy();
    fireEvent.click(fit);
    expect(screen.getByText('100%')).toBeTruthy();
  });

  test('the wheel zooms about the pointer without scrolling the page', () => {
    render(
      <ImageComparison
        image={image}
        sources={[source('upload:a')]}
        onClose={() => {}}
      />,
    );
    const stage = screen.getByRole('group', { name: 'Comparison image' });
    const event = new WheelEvent('wheel', {
      deltaY: -600 * Math.log(2),
      clientX: 1000,
      clientY: 281.25,
      bubbles: true,
      cancelable: true,
    });
    act(() => stage.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    // Doubled about the right edge, which stays put: x = 500 - 2 × 500.
    expect(transforms()[0]).toBe('translate(-500px, 0px) scale(2)');
  });

  test('a two-finger pinch zooms about its midpoint and survives a lifted finger', () => {
    render(
      <ImageComparison
        image={image}
        sources={[source('upload:a')]}
        onClose={() => {}}
      />,
    );
    const stage = screen.getByRole('group', { name: 'Comparison image' });
    fireEvent.pointerDown(stage, {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 400,
      clientY: 281.25,
    });
    fireEvent.pointerDown(stage, {
      pointerId: 2,
      pointerType: 'touch',
      clientX: 600,
      clientY: 281.25,
    });
    expect(stage.dataset.gesture).toBe('pinch');
    fireEvent.pointerMove(stage, {
      pointerId: 2,
      pointerType: 'touch',
      clientX: 800,
      clientY: 281.25,
    });
    // Distance 200 → 400 doubles the zoom about the frame center, then the
    // midpoint moved 100px right.
    expect(transforms()[0]).toBe('translate(100px, 0px) scale(2)');
    fireEvent.pointerCancel(stage, { pointerId: 2, pointerType: 'touch' });
    expect(stage.dataset.gesture).toBe('pan');
    fireEvent.pointerUp(stage, { pointerId: 1, pointerType: 'touch' });
    expect(stage.dataset.gesture).toBe(undefined);
  });

  test('holding shows the source alone and every interruption ends it', () => {
    render(
      <ImageComparison
        image={image}
        sources={[source('upload:a', { matched: true, recordedIndex: 0 })]}
        onClose={() => {}}
      />,
    );
    const hold = screen.getByRole('button', { name: 'Hold for source' });
    fireEvent.pointerDown(hold, { pointerId: 7, button: 0 });
    expect(hold.getAttribute('aria-pressed')).toBe('true');
    expect(split()).toBe('100%');
    fireEvent.pointerCancel(hold, { pointerId: 7 });
    expect(hold.getAttribute('aria-pressed')).toBe('false');
    expect(split()).toBe('50%');
    fireEvent.keyDown(hold, { key: ' ' });
    expect(split()).toBe('100%');
    fireEvent.keyUp(hold, { key: ' ' });
    expect(split()).toBe('50%');
    fireEvent.keyDown(hold, { key: 'Enter' });
    act(() => window.dispatchEvent(new Event('blur')));
    expect(split()).toBe('50%');
  });

  test('owns one object URL per shown source and revokes it on switch and close', () => {
    const sources = [source('upload:a'), source('upload:b')];
    const { unmount } = render(
      <ImageComparison image={image} sources={sources} onClose={() => {}} />,
    );
    expect(created).toHaveLength(1);
    const first = created[0];
    fireEvent.change(screen.getByRole('combobox', { name: 'With' }), {
      target: { value: 'upload:b' },
    });
    expect(revoked).toEqual([first]);
    expect(created).toHaveLength(2);
    expect(urlFor.get(beforeImg().getAttribute('src'))).toBe(sources[1].blob);
    unmount();
    expect(revoked).toEqual([first, created[1]]);
  });

  test('a failed source shows an error that does not carry over to another source', () => {
    const sources = [source('upload:a'), source('upload:b')];
    render(
      <ImageComparison image={image} sources={sources} onClose={() => {}} />,
    );
    expect(beforeImg().dataset.state).toBe('loading');
    fireEvent.error(beforeImg());
    expect(screen.getByRole('alert').textContent).toBe(
      'Reference could not be displayed.',
    );
    fireEvent.change(screen.getByRole('combobox', { name: 'With' }), {
      target: { value: 'upload:b' },
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(beforeImg().dataset.state).toBe('loading');
    fireEvent.load(beforeImg());
    expect(beforeImg().dataset.state).toBe('ready');
  });

  test('a removed reference falls back honestly, and none left shows an empty state', () => {
    const a = source('upload:a');
    const b = source('upload:b', { matched: true, recordedIndex: 0 });
    const { rerender } = render(
      <ImageComparison image={image} sources={[a, b]} onClose={() => {}} />,
    );
    fireEvent.change(screen.getByRole('combobox', { name: 'With' }), {
      target: { value: 'upload:a' },
    });
    rerender(
      <ImageComparison image={image} sources={[b]} onClose={() => {}} />,
    );
    expect(
      screen
        .getByText(
          'The chosen reference was removed. Showing source upload:b.png.',
        )
        .getAttribute('role'),
    ).toBe('status');
    expect(urlFor.get(beforeImg().getAttribute('src'))).toBe(b.blob);
    rerender(<ImageComparison image={image} sources={[]} onClose={() => {}} />);
    expect(
      screen
        .getByText('No source is available to compare.')
        .getAttribute('role'),
    ).toBe('status');
    expect(screen.queryByRole('slider')).toBeNull();
    expect(revoked).toEqual(created);
  });

  test('Escape and the close button close; Tab stays inside', () => {
    const onClose = vi.fn();
    render(
      <ImageComparison
        image={image}
        sources={[source('upload:a')]}
        onClose={onClose}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Compare' });
    const close = screen.getByRole('button', { name: 'Close comparison' });
    close.focus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Hold for reference' }),
    );
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
