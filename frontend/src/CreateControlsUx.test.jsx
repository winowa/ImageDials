import React, { useLayoutEffect, useState } from 'react';
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
import { Control } from './Controls.jsx';
import Create from './Create.jsx';
import { createEntries, GROUP, serializeEntries } from './controls.js';
import { useStudio } from './studio.js';
import { normalizeClientPolicy } from './clientPolicy.js';
import { clone, installApi, fakeLibrary } from './testSupport.js';
import { controlMenuAction } from './controlUiTestSupport.js';

let current;
const dynamic = 'POST /api/controls/dynamic';
const wire = (extra = {}) => ({
  id: 'detail',
  kind: 'text-input',
  label: 'Detail',
  value: 'Original',
  ...extra,
});
const editors = () => ({
  setValue: vi.fn(),
  toggleOption: vi.fn(),
  reset: vi.fn(),
  addCustomOption: vi.fn(),
  expand: vi.fn(),
});
const summary = () => document.querySelector('.category-summary').textContent;
function connected(routes = {}) {
  const api = installApi({
    ...fakeLibrary([]).routes,
    [dynamic]: () => ({
      controls: [wire()],
      dynamic_controls_metadata: { raw_response: 'synthetic' },
    }),
    ...routes,
  });
  function Harness() {
    const studio = useStudio({
      clientPolicy: normalizeClientPolicy({
        controls: { debounce_ms: 5000, reset_debounce_ms: 5000 },
      }),
    });
    useLayoutEffect(() => {
      current = studio;
    });
    return <Create studio={studio} />;
  }
  render(<Harness />);
  return api;
}
beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test.each([
  [{ kind: 'slider', min: -5, max: 5, step: 1, value: 0 }, '0'],
  [{ kind: 'binary', value: false, falseLabel: 'No marks' }, 'No marks'],
  [{ kind: 'text-input', value: '' }, 'Not set'],
  [{ kind: 'multi-select', value: [], options: { a: 'A' } }, 'Not set'],
  [
    { kind: 'future-kind', value: { zero: 0, flag: false } },
    '{"zero":0,"flag":false}',
  ],
  [
    { kind: 'single-select', value: 'unlisted Ω', options: { a: 'A' } },
    'unlisted Ω',
  ],
])('summary preserves actual value %#', (extra, expected) => {
  const entry = createEntries([wire(extra)], GROUP.base)[0];
  render(<Control entry={entry} editors={editors()} />);
  expect(summary()).toBe(expected);
  const toggle = screen.getByRole('button', { name: 'Expand Detail' });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(
    document
      .getElementById(toggle.getAttribute('aria-controls'))
      .hasAttribute('inert'),
  ).toBe(true);
  fireEvent.click(toggle);
  expect(document.querySelector('.category-full-value').textContent).toBe(
    expected,
  );
});

test('pending, disabled and edit application summaries follow authoritative fields', () => {
  const entry = {
    ...createEntries([wire({ value: 'Chosen' })], GROUP.base)[0],
    pending: true,
  };
  const edit = editors();
  const view = render(<Control entry={entry} editors={edit} />);
  expect(summary()).toBe('Choosing…');
  view.rerender(
    <Control entry={{ ...entry, enabled: false }} editors={edit} />,
  );
  expect(summary()).toBe('Model decides');
  view.rerender(
    <Control
      entry={entry}
      editors={{
        ...edit,
        editing: true,
        appliesToEdit: () => false,
        setApplyToEdit: vi.fn(),
      }}
    />,
  );
  expect(summary()).toBe('Kept from the source · Chosen');
  view.rerender(
    <Control
      entry={entry}
      editors={{
        ...edit,
        editing: true,
        appliesToEdit: () => true,
        setApplyToEdit: vi.fn(),
      }}
    />,
  );
  expect(summary()).toBe('Applied · Chosen');
});

test('header application, disclosure, reset and remove are independent siblings', () => {
  const entry = {
    ...createEntries([wire({ value: 'Changed' })], GROUP.base)[0],
    initial: 'Original',
  };
  render(
    <Control
      entry={entry}
      editors={{ ...editors(), setEnabled: vi.fn(), textToggle: true }}
      onRemove={vi.fn()}
    />,
  );
  const toggle = screen.getByRole('button', { name: 'Expand Detail' });
  expect(toggle.querySelector('button,input,label')).toBeNull();
  for (const action of [
    screen.getByRole('button', { name: 'Apply Detail' }),
    screen.getByRole('button', { name: 'Reset Detail' }),
    screen.getByRole('button', { name: 'Remove Detail' }),
  ])
    expect(toggle.contains(action)).toBe(false);
});

test('controlled collapse returns descendant focus to header and preserves custom draft', () => {
  const entry = createEntries(
    [wire({ kind: 'single-select', value: 'a', options: { a: 'A' } })],
    GROUP.generated,
  )[0];
  function Host() {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button onClick={() => setOpen(false)}>Close category</button>
        <Control
          entry={entry}
          editors={editors()}
          expanded={open}
          onExpandedChange={(_entry, value) => setOpen(value)}
        />
      </>
    );
  }
  render(<Host />);
  fireEvent.click(controlMenuAction('Detail', 'Add custom Detail option'));
  const input = screen.getByRole('textbox', { name: 'Custom Detail option' });
  fireEvent.change(input, { target: { value: 'Draft Ω' } });
  input.focus();
  fireEvent.click(screen.getByRole('button', { name: 'Close category' }));
  expect(document.activeElement).toBe(
    screen.getByRole('button', { name: 'Expand Detail' }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Expand Detail' }));
  expect(
    screen.getByRole('textbox', { name: 'Custom Detail option' }).value,
  ).toBe('Draft Ω');
});

test('More passive focus never requests or steals focus, custom save returns to More, errors stay visible', () => {
  const entry = createEntries(
    [wire({ kind: 'dropdown', value: 'a', options: { a: 'A' } })],
    GROUP.generated,
  )[0];
  const edit = editors();
  render(
    <Control
      entry={entry}
      editors={{
        ...edit,
        expansions: {
          [entry.key]: {
            status: 'error',
            error: new Error('Synthetic offline'),
          },
        },
      }}
    />,
  );
  const trigger = screen.getByRole('button', { name: 'More Detail choices' });
  act(() => trigger.focus());
  expect(document.activeElement).toBe(trigger);
  expect(edit.expand).not.toHaveBeenCalled();
  expect(screen.getByRole('alert').textContent).toContain('Synthetic offline');
  fireEvent.keyDown(trigger, { key: 'Escape' });
  expect(screen.queryByRole('menu')).toBeNull();
  fireEvent.click(controlMenuAction('Detail', 'Add custom Detail option'));
  const input = screen.getByRole('textbox', { name: 'Custom Detail option' });
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: 'New choice' } });
  fireEvent.submit(input.closest('form'));
  expect(edit.addCustomOption).toHaveBeenCalledWith(entry.key, 'New choice');
  expect(document.activeElement).toBe(trigger);
});

test.each([
  {},
  { minLabel: 'Calm Ω'.repeat(12) },
  { maxLabel: 'Rapid 波'.repeat(12) },
  { minLabel: 'Still', maxLabel: 'Moving' },
])('range uses actual bounds and optional endpoint meanings %#', (labels) => {
  const entry = createEntries(
    [
      wire({
        kind: 'slider',
        min: -2,
        max: 2,
        step: 1,
        value: 0,
        unit: 'degrees',
        ...labels,
      }),
    ],
    GROUP.generated,
  )[0];
  render(<Control entry={entry} editors={editors()} />);
  const slider = screen.getByRole('slider', { name: 'Detail' });
  expect(slider.min).toBe('-2');
  expect(slider.max).toBe('2');
  expect(slider.step).toBe('1');
  expect(slider.getAttribute('aria-valuetext')).toContain(
    '0 degrees, range -2 to 2',
  );
  expect(document.querySelectorAll('datalist option')).toHaveLength(5);
  expect(Boolean(document.querySelector('.slider-endpoints'))).toBe(
    Boolean(labels.minLabel || labels.maxLabel),
  );
});

test('large or invalid tick domains do not allocate tick positions', () => {
  const edit = editors();
  const view = render(
    <Control
      entry={
        createEntries(
          [wire({ kind: 'slider', min: 0, max: 100000, step: 0.01, value: 0 })],
          GROUP.generated,
        )[0]
      }
      editors={edit}
    />,
  );
  expect(document.querySelector('datalist')).toBeNull();
  view.rerender(
    <Control
      entry={
        createEntries(
          [wire({ kind: 'slider', min: 0, max: 10, step: 0, value: 0 })],
          GROUP.generated,
        )[0]
      }
      editors={edit}
    />,
  );
  expect(document.querySelector('datalist')).toBeNull();
});

test('connected defaults, panel actions and session disclosures never mutate serialized controls', async () => {
  connected();
  await screen.findByRole('button', { name: 'Expand Style' });
  const panel = screen.getByRole('region', { name: 'Standard controls' });
  const before = serializeEntries(current.entries);
  expect(within(panel).queryByRole('radio', { name: 'Watercolor' })).toBeNull();
  // One state-dependent action replaces the former pair.
  expect(
    within(panel).queryByRole('button', { name: 'Collapse all' }),
  ).toBeNull();
  const bulk = within(panel).getByRole('button', { name: 'Expand all' });
  fireEvent.focus(bulk.closest('.tip'));
  expect(screen.getByRole('tooltip').textContent).toBe('Expand all');
  fireEvent.keyDown(bulk, { key: 'Escape' });
  expect(screen.queryByRole('tooltip')).toBeNull();
  fireEvent.click(bulk);
  expect(within(panel).getByRole('radio', { name: 'Watercolor' })).toBeTruthy();
  expect(
    within(panel).queryByRole('button', { name: 'Expand all' }),
  ).toBeNull();
  // Closing one category makes the action offer Expand all again.
  fireEvent.click(
    within(panel).getByRole('button', { name: 'Collapse Style' }),
  );
  expect(
    within(panel).getByRole('button', { name: 'Expand all' }),
  ).toBeTruthy();
  fireEvent.click(within(panel).getByRole('button', { name: 'Expand all' }));
  expect(
    within(panel).getByRole('button', { name: 'Collapse all' }),
  ).toBeTruthy();
  expect(serializeEntries(current.entries)).toEqual(before);
  act(() => current.setPrompt('A synthetic bird'));
  expect(
    within(panel).getByRole('button', { name: 'Collapse Style' }),
  ).toBeTruthy();
  fireEvent.click(within(panel).getByRole('button', { name: 'Collapse all' }));
  expect(within(panel).queryByRole('radio', { name: 'Watercolor' })).toBeNull();
  // One Generate control, inside the prompt; no separate bar between panels.
  expect(document.querySelectorAll('.generate-btn')).toHaveLength(1);
  expect(
    document.querySelector('.prompt-card .prompt-tools .generate-btn'),
  ).toBeTruthy();
  expect(document.querySelector('.generate-bar')).toBeNull();
  expect(
    document
      .querySelector('.prompt-card')
      .nextElementSibling.classList.contains('options-card'),
  ).toBe(true);
});

test('connected retained manual control renders once, Remove and Undo restore the exact entry', async () => {
  let answer = 0;
  connected({
    [dynamic]: () => ({
      controls: [
        wire({
          id: answer++ ? 'replacement' : 'earlier',
          label: answer === 1 ? 'Earlier' : 'Replacement',
        }),
      ],
      dynamic_controls_metadata: { raw_response: 'synthetic' },
    }),
  });
  await screen.findByRole('button', { name: 'Expand Style' });
  act(() => current.setPrompt('A synthetic bird'));
  await act(async () => current.regenerateOptions());
  await screen.findByRole('button', { name: 'Collapse Earlier' });
  const earlier = current.entries.find((e) => e.wire.id === 'earlier');
  act(() => current.setValue(earlier.key, 'My value'));
  await act(async () => current.regenerateOptions());
  const kept = await screen.findByRole('region', {
    name: 'Kept from earlier options (1)',
  });
  expect(
    within(kept).getAllByRole('button', { name: 'Collapse Earlier' }),
  ).toHaveLength(1);
  expect(screen.getAllByRole('textbox', { name: 'Earlier' })).toHaveLength(1);
  const exact = clone(current.entries.find((e) => e.key === earlier.key));
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  fireEvent.click(within(kept).getByRole('button', { name: 'Remove Earlier' }));
  expect(current.entries.some((e) => e.key === earlier.key)).toBe(false);
  act(() => current.undoDraft());
  expect(current.entries.find((e) => e.key === earlier.key)).toEqual(exact);
});

test('capacity refusal exposes the exact error, counts every retained entry, and keeps Refresh available', async () => {
  let second = false;
  connected({
    [dynamic]: () => ({
      controls: Array.from({ length: second ? 23 : 22 }, (_, i) =>
        wire({
          id: `${second ? 'new' : 'old'}-${i}`,
          label: `${second ? 'New' : 'Old'} ${i}`,
        }),
      ),
      dynamic_controls_metadata: { raw_response: 'synthetic' },
    }),
  });
  await screen.findByRole('button', { name: 'Expand Style' });
  act(() => current.setPrompt('A synthetic bird'));
  await act(async () => current.regenerateOptions());
  await waitFor(() =>
    expect(
      current.entries.filter((e) => e.group === GROUP.generated),
    ).toHaveLength(22),
  );
  for (const entry of current.entries.filter(
    (e) => e.group === GROUP.generated,
  ))
    act(() => current.setValue(entry.key, 'Keep'));
  second = true;
  const exact = serializeEntries(current.entries);
  await act(async () => current.regenerateOptions());
  expect(current.capacityError).toBeTruthy();
  expect(
    within(
      screen.getByRole('region', { name: 'Generated controls' }),
    ).getByText(current.capacityError.message).textContent,
  ).toBe(current.capacityError.message + ' Retry');
  expect(
    document
      .querySelector('.options-card .status-line')
      .getAttribute('aria-live'),
  ).toBe('off');
  expect(serializeEntries(current.entries)).toEqual(exact);
  expect(
    screen.getByRole('button', { name: 'Regenerate options' }).disabled,
  ).toBe(false);
  expect(screen.getByText('22 generated · 26 of 30 controls')).toBeTruthy();
});

test('legacy retained summary exposes saved origin and the complete accessible value without claiming manual intent', () => {
  const entry = {
    ...createEntries(
      [
        wire({
          kind: 'future-kind',
          value: { zero: 0, flag: false, text: '長い名前 Ω'.repeat(24) },
        }),
      ],
      GROUP.generated,
    )[0],
    intentClass: 'legacy',
    retained: { anchor: 'earlier-set' },
  };
  const original = clone(entry.wire);
  render(<Control entry={entry} editors={editors()} />);
  const button = screen.getByRole('button', { name: 'Collapse Detail' });
  const description = document.getElementById(
    button.getAttribute('aria-describedby'),
  );
  expect(description.textContent).toContain('From the saved image');
  expect(description.textContent).toContain('長い名前 Ω'.repeat(24));
  expect(description.textContent).not.toContain('manual');
  expect(entry.wire).toEqual(original);
});
