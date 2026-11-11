import { act, render } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { useCardMotion } from './libraryMotion.js';

let layout = {};
let inflight = {};
let animations = [];
let reduced = false;
const harness = { api: null };

function Grid({ keys, density = 4 }) {
  const api = useCardMotion(keys, density);
  const { attachList } = api;
  useEffect(() => {
    harness.api = api;
  });
  return (
    <ul ref={attachList}>
      {keys.map((key) => (
        <li key={key} data-card-key={key}>
          <button type="button">{key}</button>
        </li>
      ))}
    </ul>
  );
}

beforeEach(() => {
  layout = {};
  inflight = {};
  animations = [];
  reduced = false;
  vi.stubGlobal('matchMedia', () => ({ matches: reduced }));
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function rect() {
      const key = this.dataset?.cardKey;
      const at = layout[key] ?? { x: 0, y: 0 };
      const moving = animations.some((a) => a.el === this && a.active);
      const dx = moving ? (inflight[key]?.x ?? 0) : 0;
      const dy = moving ? (inflight[key]?.y ?? 0) : 0;
      return {
        left: at.x + dx,
        top: at.y + dy,
        width: 100,
        height: 100,
        right: at.x + dx + 100,
        bottom: at.y + dy + 100,
      };
    },
  );
  HTMLElement.prototype.animate = function animate(frames, options) {
    const animation = {
      el: this,
      frames,
      options,
      active: true,
      cancel() {
        if (!this.active) return;
        this.active = false;
        this.oncancel?.();
      },
      finish() {
        this.active = false;
        this.onfinish?.();
      },
    };
    animations.push(animation);
    return animation;
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete HTMLElement.prototype.animate;
});

const place = (keys, columns) => {
  layout = {};
  keys.forEach((key, i) => {
    layout[key] = { x: (i % columns) * 110, y: Math.floor(i / columns) * 110 };
  });
};
const live = () => animations.filter((a) => a.active);
const cardOf = (container, key) =>
  container.querySelector(`[data-card-key="${key}"]`);

test('first mount and unchanged metadata refresh animate nothing', () => {
  place(['a', 'b', 'c'], 3);
  const { rerender } = render(<Grid keys={['a', 'b', 'c']} />);
  expect(animations).toHaveLength(0);
  rerender(<Grid keys={['a', 'b', 'c']} />);
  expect(animations).toHaveLength(0);
});

test('a density change moves the same card elements from their old positions', () => {
  place(['a', 'b', 'c', 'd'], 4);
  const { container, rerender } = render(<Grid keys={['a', 'b', 'c', 'd']} />);
  const before = ['a', 'b', 'c', 'd'].map((k) => cardOf(container, k));
  place(['a', 'b', 'c', 'd'], 2);
  rerender(<Grid keys={['a', 'b', 'c', 'd']} density={2} />);
  expect(['a', 'b', 'c', 'd'].map((k) => cardOf(container, k))).toEqual(before);
  const moved = live();
  // c and d wrapped to a new row; a and b stayed put.
  expect(moved.map((a) => a.el.dataset.cardKey)).toEqual(['c', 'd']);
  expect(moved[0].frames[0].transform).toBe('translate(220px, -110px)');
  expect(moved[0].frames[1].transform).toBe('none');
  // Position only: the cards are never scaled, so proportions stay natural.
  expect(JSON.stringify(moved[0].frames)).not.toMatch(/scale/);
});

test('an arrival among kept cards enters; neighbours make room', () => {
  place(['a', 'b'], 2);
  const { container, rerender } = render(<Grid keys={['a', 'b']} />);
  place(['n', 'a', 'b'], 2);
  rerender(<Grid keys={['n', 'a', 'b']} />);
  const byKey = Object.fromEntries(
    live().map((a) => [a.el.dataset.cardKey, a]),
  );
  expect(byKey.n.frames[0]).toMatchObject({ opacity: 0 });
  expect(byKey.n.frames[0].transform).toMatch(/scale\(0\.94\)/);
  expect(byKey.n.options.delay).toBe(0);
  expect(byKey.a.frames[0].transform).toBe('translate(-110px, 0px)');
  expect(cardOf(container, 'a')).toBe(byKey.a.el);
});

test('a replaced page only fades and a reduced-motion preference skips all motion', () => {
  place(['a', 'b'], 2);
  const { rerender } = render(<Grid keys={['a', 'b']} />);
  place(['x', 'y'], 2);
  rerender(<Grid keys={['x', 'y']} />);
  expect(live()).toHaveLength(2);
  expect(live()[0].frames).toEqual([{ opacity: 0 }, { opacity: 1 }]);
  animations = [];
  reduced = true;
  HTMLElement.prototype.getBoundingClientRect.mockClear();
  place(['p', 'q', 'r'], 2);
  rerender(<Grid keys={['p', 'q', 'r']} />);
  expect(animations).toHaveLength(0);
  // One list origin and one read per card; reduced motion needs no FLIP pair.
  expect(HTMLElement.prototype.getBoundingClientRect).toHaveBeenCalledTimes(4);
});

test('an interrupted move restarts from where the card is drawn', () => {
  place(['a', 'b', 'c'], 3);
  const { rerender } = render(<Grid keys={['a', 'b', 'c']} />);
  place(['a', 'b', 'c'], 2);
  rerender(<Grid keys={['a', 'b', 'c']} density={2} />);
  const first = live().find((a) => a.el.dataset.cardKey === 'c');
  expect(first.frames[0].transform).toBe('translate(220px, -110px)');
  // Halfway: c is drawn 100px left and 50px above its new slot.
  inflight = { c: { x: 100, y: -50 } };
  place(['a', 'b', 'c'], 1);
  rerender(<Grid keys={['a', 'b', 'c']} density={1} />);
  expect(first.active).toBe(false);
  const second = live().find((a) => a.el.dataset.cardKey === 'c');
  // Old layout (0,110) + drawn offset (100,-50) minus new layout (0,220).
  expect(second.frames[0].transform).toBe('translate(100px, -160px)');
  expect(live().filter((a) => a.el.dataset.cardKey === 'c')).toHaveLength(1);
});

test('a confirmed removal leaves an inert exit copy that cleans itself up', () => {
  place(['a', 'b', 'c'], 3);
  const { container, rerender } = render(<Grid keys={['a', 'b', 'c']} />);
  act(() => harness.api.prepareExit('b'));
  place(['a', 'c'], 3);
  rerender(<Grid keys={['a', 'c']} />);
  const ghost = container.querySelector('[data-card-exit]');
  expect(ghost).toBeTruthy();
  expect(ghost.hasAttribute('data-card-key')).toBe(false);
  expect(ghost.getAttribute('aria-hidden')).toBe('true');
  expect(ghost.inert).toBe(true);
  expect(ghost.style.left).toBe('110px');
  expect(cardOf(container, 'b')).toBeNull();
  const exit = live().find((a) => a.el === ghost);
  act(() => exit.finish());
  expect(container.querySelector('[data-card-exit]')).toBeNull();
});

test('a discarded (failed) delete never produces an exit copy', () => {
  place(['a', 'b'], 2);
  const { container, rerender } = render(<Grid keys={['a', 'b']} />);
  act(() => harness.api.prepareExit('b'));
  act(() => harness.api.discardExit());
  place(['a'], 2);
  rerender(<Grid keys={['a']} />);
  expect(container.querySelector('[data-card-exit]')).toBeNull();
});

test('unmounting cancels running motion and removes the exit copy', () => {
  place(['a', 'b', 'c'], 3);
  const { container, rerender, unmount } = render(
    <Grid keys={['a', 'b', 'c']} />,
  );
  act(() => harness.api.prepareExit('a'));
  place(['b', 'c', 'n'], 3);
  rerender(<Grid keys={['b', 'c', 'n']} />);
  const ghost = container.querySelector('[data-card-exit]');
  expect(live().length).toBeGreaterThan(0);
  unmount();
  expect(live()).toHaveLength(0);
  expect(ghost.isConnected).toBe(false);
});
