import { controlMenuAction } from './controlUiTestSupport.js';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, expect, test } from 'vitest';

import { Control } from './Controls.jsx';
import {
  addCustomOption,
  createEntries,
  GROUP,
  resetEntry,
  setValue,
  toggleOption,
} from './controls.js';
import { clone, fixtures } from './testSupport.js';

afterEach(cleanup);

const dynamicWire = (id) =>
  clone(fixtures.m1.dynamic_response.controls.find((w) => w.id === id));

/** Hosts one control with the same edit surface the studio provides. */
function setup(wire) {
  const seen = { entry: null };
  function Host() {
    const [entry, setEntry] = useState(
      () => createEntries([wire], GROUP.generated)[0],
    );
    useEffect(() => {
      seen.entry = entry;
    }, [entry]);
    const editors = {
      setValue: (_key, value) => setEntry((e) => setValue(e, value)),
      toggleOption: (_key, option) => setEntry((e) => toggleOption(e, option)),
      addCustomOption: (_key, text) =>
        setEntry((e) => addCustomOption(e, text)),
      reset: () => setEntry(resetEntry),
    };
    return <Control entry={entry} editors={editors} />;
  }
  render(<Host />);
  return seen;
}

test('single-select chips are radios that deselect to null when pressed again', () => {
  const seen = setup(dynamicWire('surface'));
  const chip = screen.getByRole('radio', { name: /smooth glass/ });
  expect(chip.checked).toBe(true);
  // The option description is available to assistive technology only.
  expect(chip.closest('label').textContent).toContain('Even surface');
  fireEvent.click(chip);
  expect(seen.entry.wire.value).toBeNull();
  fireEvent.click(chip);
  expect(seen.entry.wire.value).toBe('smooth');
});

test('multi-select chips are checkboxes in a labelled group', () => {
  const seen = setup(dynamicWire('colors'));
  expect(screen.getByRole('group', { name: 'Highlights' })).toBeTruthy();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Red' }));
  expect(seen.entry.wire.value).toEqual(['gold', 'red']);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Gold' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Red' }));
  expect(seen.entry.wire.value).toEqual([]);
});

test('dropdown can be cleared to null', () => {
  const seen = setup(dynamicWire('setting'));
  const select = screen.getByRole('combobox', { name: 'Setting' });
  fireEvent.change(select, { target: { value: 'shelf' } });
  expect(seen.entry.wire.value).toBe('shelf');
  fireEvent.change(select, { target: { value: '' } });
  expect(seen.entry.wire.value).toBeNull();
});

test('radio and checkbox kinds render as plain choice lists', () => {
  const radio = setup(dynamicWire('view'));
  fireEvent.click(screen.getByRole('radio', { name: 'Side' }));
  expect(radio.entry.wire.value).toBe('side');
  cleanup();
  const boxes = setup(dynamicWire('parts'));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Tail' }));
  expect(boxes.entry.wire.value).toEqual(['tail']);
});

test('a slider at zero keeps zero and reports it', () => {
  const seen = setup(dynamicWire('angle'));
  const slider = screen.getByRole('slider', { name: 'Head angle' });
  expect(slider.value).toBe('0');
  expect(screen.getByText('0', { selector: 'output' })).toBeTruthy();
  fireEvent.change(slider, { target: { value: '30' } });
  expect(seen.entry.wire.value).toBe(30);
  fireEvent.change(slider, { target: { value: '0' } });
  expect(seen.entry.wire.value).toBe(0);
});

test('binary switch sets an explicit false and honours custom labels', () => {
  const wire = {
    ...dynamicWire('pattern'),
    trueLabel: 'Etched',
    falseLabel: 'Plain',
  };
  const seen = setup(wire);
  const toggle = screen.getByRole('switch', { name: 'Etched pattern' });
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(screen.getByText('Plain', { selector: '.switch-text' })).toBeTruthy();
  fireEvent.click(toggle);
  expect(seen.entry.wire.value).toBe(true);
  expect(screen.getByText('Etched', { selector: '.switch-text' })).toBeTruthy();
  fireEvent.click(toggle);
  expect(seen.entry.wire.value).toBe(false);
});

test('text input updates and can be emptied', () => {
  const seen = setup(dynamicWire('notes'));
  const field = screen.getByRole('textbox', { name: 'Stand details' });
  expect(field.value).toBe('Rounded edges');
  fireEvent.change(field, { target: { value: '' } });
  expect(seen.entry.wire.value).toBe('');
});

test('an unknown kind is kept and labelled, never rendered as another kind', () => {
  const seen = setup(dynamicWire('future'));
  expect(screen.getByText('future-control')).toBeTruthy();
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(seen.entry.wire).toEqual(dynamicWire('future'));
});

test('reset appears only after a change and restores the original value', () => {
  setup(dynamicWire('colors'));
  expect(screen.queryByRole('button', { name: 'Reset Highlights' })).toBeNull();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Red' }));
  fireEvent.click(screen.getByRole('button', { name: 'Reset Highlights' }));
  expect(screen.getByRole('checkbox', { name: 'Red' }).checked).toBe(false);
  expect(screen.getByRole('checkbox', { name: 'Gold' }).checked).toBe(true);
});

test('a custom option is typed in, added and selected; Escape cancels', () => {
  const seen = setup(dynamicWire('setting'));
  fireEvent.click(controlMenuAction('Setting', 'Add custom Setting option'));
  const field = screen.getByRole('textbox', { name: 'Custom Setting option' });
  fireEvent.keyDown(field, { key: 'Escape' });
  expect(
    screen.queryByRole('textbox', { name: 'Custom Setting option' }),
  ).toBeNull();
  fireEvent.click(controlMenuAction('Setting', 'Add custom Setting option'));
  const next = screen.getByRole('textbox', { name: 'Custom Setting option' });
  fireEvent.change(next, { target: { value: 'Rooftop' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add Setting option' }));
  expect(seen.entry.wire.value).toBe('Rooftop');
  expect(screen.getByRole('option', { name: 'Rooftop' }).selected).toBe(true);
});

test('one trailing More chip opens both actions without starting a request', () => {
  for (const id of ['surface', 'colors']) {
    const wire = dynamicWire(id);
    const { unmount } = render(<ControlWithMore wire={wire} />);
    const trigger = screen.getByRole('button', {
      name: `More ${wire.label} choices`,
    });
    const tail = trigger.closest('.option-tail');
    expect(tail.querySelectorAll('button')).toHaveLength(1);
    fireEvent.click(trigger);
    expect(
      screen.getByRole('menuitem', { name: `More ${wire.label} options` }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole('menuitem', { name: `Add custom ${wire.label} option` }),
    );
    expect(tail.querySelector('form')).toBeTruthy();
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.keyDown(
      screen.getByRole('textbox', { name: `Custom ${wire.label} option` }),
      { key: 'Escape' },
    );
    expect(document.activeElement).toBe(trigger);
    unmount();
  }
});

test('an expansion failure message sits outside the Custom/More group', () => {
  render(
    <ControlWithMore
      wire={dynamicWire('surface')}
      expansion={{ status: 'error', error: new Error('offline') }}
    />,
  );
  const alert = screen.getByRole('alert');
  expect(alert.textContent).toContain('offline');
  expect(alert.closest('.option-tail')).toBeNull();
});

test('without an expand editor the More chip offers only custom entry', () => {
  render(<ControlWithMore wire={dynamicWire('surface')} noExpand />);
  fireEvent.click(screen.getByRole('button', { name: 'More Surface choices' }));
  expect(screen.getAllByRole('menuitem')).toHaveLength(1);
  expect(
    screen.getByRole('menuitem', { name: 'Add custom Surface option' }),
  ).toBeTruthy();
});

function ControlWithMore({ wire, expansion, noExpand }) {
  const entry = createEntries([wire], GROUP.generated)[0];
  const editors = {
    setValue() {},
    toggleOption() {},
    addCustomOption() {},
    reset() {},
    expansions: expansion ? { [entry.key]: expansion } : {},
    ...(noExpand ? {} : { expand() {} }),
  };
  return <Control entry={entry} editors={editors} />;
}
