import {
  openStandardControls,
  controlMenuAction,
} from '../helpers/controlUiTestSupport.js';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import App from '../../src/app/App.jsx';
import expanded from '../../../fixtures/api/expanded-static-controls.json';
import {
  fakeLibrary,
  installApi,
  libraryRecord,
  sizedRecord,
} from '../helpers/testSupport.js';

const STATIC = {
  standard: 'GET /api/controls/static?generation_mode=standard',
  trellis: 'GET /api/controls/static?generation_mode=trellis',
};

let observers;

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  localStorage.clear();
  observers = [];
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback) {
        this.callback = callback;
        observers.push(this);
      }
      observe(node) {
        this.node = node;
      }
      disconnect() {
        observers = observers.filter((o) => o !== this);
      }
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function setup(records = []) {
  const library = fakeLibrary(records);
  const api = installApi({
    [STATIC.standard]: () => expanded.standard,
    [STATIC.trellis]: () => expanded.trellis,
    ...library.routes,
  });
  render(<App />);
  return api;
}

const controlHeadings = (panel) =>
  within(panel)
    .getAllByRole('heading', { level: 3 })
    .map((h) => h.getAttribute('aria-label'));

test('every control of the expanded static catalogs is shown with all of its options', async () => {
  setup();
  const panel = await screen.findByRole('region', {
    name: 'Standard controls',
  });
  await openStandardControls();
  const catalog = expanded.standard.controls;
  expect(controlHeadings(panel)).toEqual(catalog.map((c) => c.label));
  const shownIn = (scope, wire) => {
    const count = Object.keys(wire.options).length;
    if (wire.kind === 'dropdown') {
      const select = within(scope).getByRole('combobox', { name: wire.label });
      // "Not set" plus every option.
      expect(within(select).getAllByRole('option')).toHaveLength(count + 1);
      return;
    }
    const multi = wire.kind === 'multi-select';
    const group = within(scope).getByRole(multi ? 'group' : 'radiogroup', {
      name: wire.label,
    });
    expect(
      within(group).getAllByRole(multi ? 'checkbox' : 'radio'),
    ).toHaveLength(count);
  };
  catalog.forEach((wire) => shownIn(panel, wire));
  // Composition is a chip family like the rest, never a dropdown.
  expect(within(panel).queryByRole('combobox')).toBeNull();
  const composition = within(panel).getByRole('group', {
    name: 'Composition',
  });
  expect(
    within(composition)
      .getAllByRole('checkbox', { checked: true })
      .map((box) => box.parentElement.textContent),
  ).toEqual(['Balanced']);
  // Unset multi-selects are empty lists and unset single choices are none.
  for (const name of ['Texture', 'Mood'])
    expect(
      within(within(panel).getByRole('group', { name })).queryAllByRole(
        'checkbox',
        { checked: true },
      ),
    ).toEqual([]);
  expect(
    within(
      within(panel).getByRole('radiogroup', { name: 'Camera angle' }),
    ).getByRole('radio', { name: 'Wide shot' }),
  ).toBeTruthy();

  fireEvent.click(screen.getByRole('radio', { name: 'Asset image for 3D' }));
  const assets = await screen.findByRole('region', {
    name: 'Asset controls',
  });
  await waitFor(() =>
    expect(controlHeadings(assets)).toEqual(
      expanded.trellis.controls.map((c) => c.label),
    ),
  );
  await openStandardControls();
  expanded.trellis.controls.forEach((wire) => shownIn(assets, wire));
  expect(
    within(within(assets).getByRole('combobox', { name: 'View' })).getByRole(
      'option',
      { name: 'Wide shot' },
    ),
  ).toBeTruthy();
});

test('the custom option entry replaces its button in the options flow and returns focus', async () => {
  setup();
  const panel = await screen.findByRole('region', {
    name: 'Standard controls',
  });
  await openStandardControls();
  const group = within(panel).getByRole('group', { name: 'Style' });
  const open = within(panel).getByRole('button', {
    name: 'More Style choices',
  });
  const tail = open.closest('.option-tail');
  expect(tail.parentElement).toBe(group);
  fireEvent.click(controlMenuAction('Style', 'Add custom Style option'));
  const field = within(panel).getByLabelText('Custom Style option');
  expect(document.activeElement).toBe(field);
  // Same group and flow, not a separate row; the button is gone meanwhile.
  expect(field.closest('form').parentElement).toBe(tail);
  expect(
    within(tail).getByRole('button', { name: 'More Style choices' }),
  ).toBeTruthy();
  expect(
    within(panel).queryByRole('button', { name: 'Add custom Style option' }),
  ).toBeNull();
  expect(
    within(panel).getByRole('button', { name: 'Add Style option' }),
  ).toBeTruthy();

  fireEvent.keyDown(field, { key: 'Escape' });
  expect(within(panel).queryByLabelText('Custom Style option')).toBeNull();
  expect(document.activeElement).toBe(
    within(panel).getByRole('button', { name: 'More Style choices' }),
  );

  fireEvent.click(controlMenuAction('Style', 'Add custom Style option'));
  const again = within(panel).getByLabelText('Custom Style option');
  fireEvent.change(again, { target: { value: 'Stained glass' } });
  fireEvent.submit(again.closest('form'));
  const added = within(group).getByRole('checkbox', {
    name: 'Stained glass',
  });
  expect(added.checked).toBe(true);
});

const lastObserver = () => observers.at(-1);
const report = (isIntersecting, intersectionRatio) =>
  act(() => lastObserver().callback([{ isIntersecting, intersectionRatio }]));

test('the history shortcut appears only while saved images are out of view and reveals them on request', async () => {
  const scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  vi.stubGlobal('matchMedia', (query) => ({
    matches: query.includes('reduce'),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  setup([libraryRecord(), sizedRecord('second', 1024, 768)]);
  await screen.findByRole('region', { name: 'Saved images' });
  await waitFor(() => expect(observers.length).toBeGreaterThan(0));
  const name = 'Show saved images';
  // Visible: no shortcut.
  report(true, 1);
  expect(screen.queryByRole('button', { name })).toBeNull();
  // Clipped by the pane or the viewport: a 44px shortcut.
  report(false, 0);
  const button = await screen.findByRole('button', { name });
  expect(button.hasAttribute('title')).toBe(false);
  // A sliver is still out of view; a mostly visible strip is not.
  report(true, 0.1);
  expect(screen.getByRole('button', { name })).toBeTruthy();

  const before = scrollIntoView.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name }));
  expect(scrollIntoView).toHaveBeenCalledTimes(before + 1);
  expect(scrollIntoView.mock.calls.at(-1)[0]).toMatchObject({
    behavior: 'auto',
  });
  expect(document.activeElement.classList.contains('thumb')).toBe(true);

  report(true, 0.9);
  expect(screen.queryByRole('button', { name })).toBeNull();
});
