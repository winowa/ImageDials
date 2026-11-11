import React from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import App from '../../src/app/App.jsx';
import { useHistoryReveal } from '../../src/features/create/historyReveal.js';
import {
  completeStatus,
  fakeLibrary,
  FakeEventSource,
  fixtures,
  installApi,
  listedFromJob,
  respond,
  sizedRecord,
} from '../helpers/testSupport.js';

const prototypeDescriptors = [];
function geometry(proto, key, get) {
  prototypeDescriptors.push([
    proto,
    key,
    Object.getOwnPropertyDescriptor(proto, key),
  ]);
  Object.defineProperty(proto, key, { configurable: true, get });
}
beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('scrollTo', vi.fn());
  geometry(HTMLLIElement.prototype, 'offsetLeft', function () {
    return [...this.parentElement.children].indexOf(this) * 100;
  });
  geometry(HTMLLIElement.prototype, 'offsetWidth', () => 100);
  geometry(HTMLUListElement.prototype, 'clientWidth', () => 500);
  geometry(HTMLUListElement.prototype, 'scrollWidth', function () {
    return this.children.length * 100;
  });
});
afterEach(() => {
  cleanup();
  for (const [proto, key, original] of prototypeDescriptors
    .splice(0)
    .reverse()) {
    if (original) Object.defineProperty(proto, key, original);
    else delete proto[key];
  }
  vi.unstubAllGlobals();
});

const region = () => screen.getByRole('region', { name: 'Saved images' });
const list = () => region().querySelector('ul');
async function generating() {
  const library = fakeLibrary(
    Array.from({ length: 240 }, (_, i) =>
      sizedRecord(`old-${i}`, 1152, 768, { title: `Old ${i}` }),
    ),
  );
  const api = installApi({
    ...library.routes,
    'POST /api/controls/dynamic': () => fixtures.m1.dynamic_response,
    'POST /api/generate-image': () => respond(202, fixtures.m1.accepted),
    'GET /api/generation-jobs/fixture-image-1': () => ({
      ...fixtures.m1.job_running,
    }),
  });
  render(<App jobPolicy={{ pollIntervalMs: 1 }} />);
  await screen.findByRole('button', { name: 'Old 0' });
  fireEvent.change(screen.getByLabelText('Image idea'), {
    target: { value: 'A paper crane' },
  });
  fireEvent.keyDown(screen.getByLabelText('Image idea'), { key: 'Enter' });
  await waitFor(() =>
    expect(
      FakeEventSource.all.some((s) => s.url.includes('generation-jobs')),
    ).toBe(true),
  );
  await screen.findByRole('button', { name: 'Generating: A paper crane' });
  await act(async () => {});
  return {
    library,
    api,
    complete: async () => {
      const status = completeStatus();
      library.records = [listedFromJob(status.result), ...library.records];
      await act(async () =>
        FakeEventSource.all
          .find((s) => s.url.includes('generation-jobs'))
          .emit('complete', status.result),
      );
      return status.result;
    },
  };
}

test('connected completion reveals its selected thumbnail in its own scrolled strip exactly once', async () => {
  const run = await generating();
  list().scrollLeft = 1700;
  fireEvent.scroll(list());
  const result = await run.complete();
  const thumb = await within(region()).findByRole('button', {
    name: result.title,
  });
  await waitFor(() => expect(thumb.getAttribute('aria-current')).toBe('true'));
  expect(list().scrollLeft).toBe(0);
  expect(screen.getByRole('heading', { name: result.title })).toBeTruthy();
  list().scrollLeft = 1200;
  fireEvent.scroll(list());
  await act(async () => {});
  expect(list().scrollLeft).toBe(1200);
  expect(run.api.called('POST /api/generate-image')).toHaveLength(1);
});

test.each(['draft', 'pick'])(
  'completion after a newer %s leaves browsing and selection alone',
  async (choice) => {
    const run = await generating();
    if (choice === 'draft')
      fireEvent.click(screen.getByRole('button', { name: 'New draft' }));
    else {
      fireEvent.click(within(region()).getByRole('button', { name: 'Old 5' }));
      await screen.findByRole('heading', { name: 'Old 5' });
    }
    list().scrollLeft = 1700;
    fireEvent.scroll(list());
    const result = await run.complete();
    const thumb = await within(region()).findByRole('button', {
      name: result.title,
    });
    expect(thumb.getAttribute('aria-current')).toBe('false');
    expect(list().scrollLeft).toBe(1700);
  },
);

function hookStrip() {
  const strip = document.createElement('ul');
  document.body.append(strip);
  const existing = document.createElement('li');
  existing.dataset.key = 'existing';
  strip.append(existing);
  const ref = { current: strip };
  const done = vi.fn();
  const row = () => {
    const li = document.createElement('li');
    li.dataset.key = 'new';
    strip.prepend(li);
    return li;
  };
  const request = { key: 'new' };
  const hook = renderHook(
    ({ items, wanted }) => useHistoryReveal(ref, items, wanted, done),
    { initialProps: { items: ['existing'], wanted: request } },
  );
  return { strip, done, row, request, ...hook };
}

test('waits for the actual row and sized layout, then never repeats on metadata or resize', () => {
  let resize;
  const disconnect = vi.fn();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(fn) {
        resize = fn;
      }
      observe() {}
      disconnect() {
        disconnect();
      }
    },
  );
  const t = hookStrip();
  t.strip.scrollLeft = 800;
  t.row();
  let width = 0;
  Object.defineProperty(t.strip, 'clientWidth', { get: () => width });
  t.rerender({ items: ['new'], wanted: t.request });
  expect(t.done).not.toHaveBeenCalled();
  width = 500;
  act(() => resize());
  expect(t.strip.scrollLeft).toBe(0);
  expect(t.done).toHaveBeenCalledTimes(1);
  t.strip.scrollLeft = 300;
  t.rerender({ items: ['metadata'], wanted: t.request });
  act(() => resize());
  expect(t.strip.scrollLeft).toBe(300);
  t.unmount();
  expect(disconnect).toHaveBeenCalled();
  t.strip.remove();
});

test.each([false, true])(
  'already visible needs no scroll writes, reduced motion %s',
  (reduced) => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: reduced })),
    );
    const t = hookStrip();
    t.row();
    const set = vi.fn();
    Object.defineProperty(t.strip, 'scrollLeft', { get: () => 0, set });
    t.rerender({ items: ['new'], wanted: t.request });
    expect(set).not.toHaveBeenCalled();
    expect(t.done).toHaveBeenCalledTimes(1);
    expect(window.scrollTo).not.toHaveBeenCalled();
    t.unmount();
    t.strip.remove();
  },
);

test('a later pick cancels a delayed row; a new request supersedes it without timers', () => {
  const t = hookStrip();
  t.strip.scrollLeft = 800;
  t.row();
  t.rerender({ items: ['new'], wanted: null });
  expect(t.strip.scrollLeft).toBe(800);
  expect(t.done).not.toHaveBeenCalled();
  const newer = { key: 'new' };
  t.rerender({ items: ['new'], wanted: newer });
  expect(t.strip.scrollLeft).toBe(0);
  expect(t.done).toHaveBeenCalledWith(newer);
  t.unmount();
  t.strip.remove();
});

test('an active touch drag defers reveal until release and never moves the page', () => {
  const t = hookStrip();
  t.row();
  t.strip.scrollLeft = 800;
  fireEvent.pointerDown(t.strip);
  t.rerender({ items: ['new'], wanted: t.request });
  expect(t.strip.scrollLeft).toBe(800);
  fireEvent.pointerUp(window);
  expect(t.strip.scrollLeft).toBe(0);
  expect(window.scrollTo).not.toHaveBeenCalled();
  t.unmount();
  t.strip.remove();
});

test('a selected completion outside the bounded catalog window mounts and reveals its exact row', async () => {
  const run = await generating();
  fireEvent.keyDown(list(), { key: 'End' });
  await within(region()).findByRole('button', { name: 'Old 239' });
  await waitFor(() =>
    expect(
      within(region()).queryByRole('button', { name: 'Old 0' }),
    ).toBeNull(),
  );
  const reads = () =>
    run.api.calls.filter((c) =>
      c.key.startsWith('GET /api/images/library/page'),
    ).length;
  const before = reads();
  const result = await run.complete();
  const thumb = await within(region()).findByRole('button', {
    name: result.title,
  });
  await waitFor(() => expect(thumb.getAttribute('aria-current')).toBe('true'));
  expect(list().scrollLeft).toBe(0);
  expect(list().children.length).toBeLessThanOrEqual(132);
  // The existing window may refresh once, but completion must not page back
  // through the catalog to find its new row.
  expect(reads() - before).toBeLessThanOrEqual(1);
  expect(screen.getByRole('heading', { name: result.title })).toBeTruthy();
});

test('bounded prefetch retains the first visible row and its horizontal offset', async () => {
  await generating();
  const ul = list();
  const count = ul.children.length;
  ul.scrollLeft = ul.scrollWidth - 1000;
  fireEvent.scroll(ul);
  const row = [...ul.children].find(
    (n) => n.offsetLeft + n.offsetWidth > ul.scrollLeft,
  );
  const key = row.dataset.key;
  const offset = row.offsetLeft - ul.scrollLeft;
  await waitFor(() => expect(ul.children.length).toBeGreaterThan(count));
  const retained = [...ul.children].find((n) => n.dataset.key === key);
  expect(retained.offsetLeft - ul.scrollLeft).toBe(offset);
});

test.each([false, true])(
  'offscreen reveal is immediate and horizontal with reduced motion %s',
  (reduced) => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: reduced })),
    );
    const t = hookStrip();
    t.row();
    t.strip.scrollLeft = 800;
    const intoView = vi.fn();
    t.strip.firstChild.scrollIntoView = intoView;
    t.rerender({ items: ['new'], wanted: t.request });
    expect(t.strip.scrollLeft).toBe(0);
    expect(intoView).not.toHaveBeenCalled();
    expect(window.scrollTo).not.toHaveBeenCalled();
    t.unmount();
    t.strip.remove();
  },
);

test('native touch scrolling pointer cancellation does not end the active touch gesture', () => {
  const t = hookStrip();
  t.row();
  t.strip.scrollLeft = 800;
  fireEvent.touchStart(t.strip, { touches: [{ identifier: 1 }] });
  fireEvent.pointerDown(t.strip);
  fireEvent.pointerCancel(window);
  t.rerender({ items: ['new'], wanted: t.request });
  expect(t.strip.scrollLeft).toBe(800);
  fireEvent.touchEnd(window, { touches: [] });
  expect(t.strip.scrollLeft).toBe(0);
  t.unmount();
  t.strip.remove();
});

test('touch inertia settles before the pending reveal, so later native scrolling cannot undo it', () => {
  const t = hookStrip();
  t.row();
  t.strip.scrollLeft = 800;
  fireEvent.touchStart(t.strip, { touches: [{ identifier: 1 }] });
  fireEvent.scroll(t.strip);
  fireEvent.touchEnd(window, { touches: [] });
  t.rerender({ items: ['new'], wanted: t.request });
  expect(t.strip.scrollLeft).toBe(800);
  t.strip.scrollLeft = 900;
  fireEvent.scroll(t.strip);
  expect(t.done).not.toHaveBeenCalled();
  fireEvent(t.strip, new Event('scrollend'));
  expect(t.strip.scrollLeft).toBe(0);
  expect(t.done).toHaveBeenCalledTimes(1);
  t.unmount();
  t.strip.remove();
});

test('releases the previous native snap target through the commit and restores snapping after two frames', () => {
  const frames = new Map();
  let next = 0;
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback) => {
      const id = ++next;
      frames.set(id, callback);
      return id;
    }),
  );
  vi.stubGlobal(
    'cancelAnimationFrame',
    vi.fn((id) => frames.delete(id)),
  );
  const t = hookStrip();
  t.row();
  t.strip.scrollLeft = 800;
  t.rerender({ items: ['new'], wanted: t.request });
  expect(t.strip.style.scrollSnapType).toBe('none');
  expect(t.strip.scrollLeft).toBe(0);
  const runFrame = () => {
    const [id, fn] = frames.entries().next().value;
    frames.delete(id);
    act(() => fn());
  };
  runFrame();
  expect(t.strip.style.scrollSnapType).toBe('none');
  runFrame();
  expect(t.strip.style.scrollSnapType).toBe('');
  expect(frames.size).toBe(0);
  t.unmount();
  t.strip.remove();
});

test('unmount restores native snapping and cancels pending reveal frames', () => {
  const frames = new Map();
  let next = 0;
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback) => {
      frames.set(++next, callback);
      return next;
    }),
  );
  vi.stubGlobal(
    'cancelAnimationFrame',
    vi.fn((id) => frames.delete(id)),
  );
  const t = hookStrip();
  t.row();
  t.strip.scrollLeft = 800;
  t.rerender({ items: ['new'], wanted: t.request });
  expect(t.strip.style.scrollSnapType).toBe('none');
  t.unmount();
  expect(t.strip.style.scrollSnapType).toBe('');
  expect(frames.size).toBe(0);
  t.strip.remove();
});

test('uses instant scrolling on the carousel element to cancel a retained native scroll target', () => {
  const t = hookStrip();
  t.row();
  t.strip.scrollLeft = 800;
  t.strip.scrollTo = vi.fn(({ left }) => {
    t.strip.scrollLeft = left;
  });
  t.rerender({ items: ['new'], wanted: t.request });
  expect(t.strip.scrollTo).toHaveBeenCalledExactlyOnceWith({
    left: 0,
    behavior: 'instant',
  });
  expect(window.scrollTo).not.toHaveBeenCalled();
  expect(t.strip.scrollLeft).toBe(0);
  t.unmount();
  t.strip.remove();
});
