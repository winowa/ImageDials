import { expect, test } from 'vitest';

import application from '../../../fixtures/api/control-application.json';
import {
  controlApplicationSupported,
  createEntries,
  GROUP,
  isEnabled,
} from '../../src/features/controls/controls.js';
import {
  serializeEditEntries,
  serializeTextEntries,
} from '../../src/features/references/references.js';
import {
  buildSubmission,
  disabledControlBlock,
} from '../../src/features/create/submission.js';

const draft = { prompt: 'A tin robot', aspect: '3:2', mode: 'image' };
const idle = { status: 'idle', anchor: null, metadata: null };
const clone = (value) => JSON.parse(JSON.stringify(value));

test('the capability is recognised only as the server names it', () => {
  expect(
    controlApplicationSupported({
      control_application: application.capability,
    }),
  ).toBe(true);
  expect(controlApplicationSupported({})).toBe(false);
  expect(
    controlApplicationSupported({
      control_application: { ...application.capability, enabled: false },
    }),
  ).toBe(false);
  expect(
    controlApplicationSupported({
      control_application: { ...application.capability, text_flag: 'other' },
    }),
  ).toBe(false);
});

test('fixture controls round-trip: the flag becomes entry state and is written back exactly', () => {
  const entries = createEntries(clone(application.controls), GROUP.base);
  expect(entries.map(isEnabled)).toEqual([false, true]);
  expect(entries[0].wire).not.toHaveProperty('apply_to_generation');
  expect(serializeTextEntries(entries)).toEqual(application.controls);
});

test('an off control is sent unvalidated with its value; an on one is still checked', () => {
  const [lighting, gloss] = createEntries(
    clone(application.controls),
    GROUP.base,
  );
  const unusable = {
    ...lighting,
    wire: { ...lighting.wire, value: 42 },
  };
  const ok = buildSubmission({
    draft,
    entries: [unusable, gloss],
    dynamic: idle,
    dimensions: '1152x768',
  });
  expect(ok.error).toBeUndefined();
  expect(ok.body.controls[0]).toMatchObject({
    value: 42,
    apply_to_generation: false,
  });
  const refused = buildSubmission({
    draft,
    entries: [{ ...unusable, enabled: true }, gloss],
    dynamic: idle,
    dimensions: '1152x768',
  });
  expect(refused.error).toMatch(/^Lighting /);
});

test('a server without the capability refuses an off control instead of using it', () => {
  const entries = createEntries(clone(application.controls), GROUP.base);
  expect(disabledControlBlock(entries, { textFlags: false })).toBe(
    'This server uses every control. Turn Lighting back on to generate.',
  );
  expect(
    buildSubmission({
      draft,
      entries,
      dynamic: idle,
      dimensions: '1152x768',
      textFlags: false,
    }).error,
  ).toMatch(/Turn Lighting back on/);
  expect(disabledControlBlock(entries, { textFlags: true })).toBeNull();
});

test('an edit sends apply_to_edit alone, whatever the text state', () => {
  const entries = createEntries(clone(application.controls), GROUP.base).map(
    (entry) => ({ ...entry, applyToEdit: entry.wire.id === 'gloss' }),
  );
  const wires = serializeEditEntries(entries);
  expect(JSON.stringify(wires)).not.toContain('apply_to_generation');
  expect(wires.map((w) => w.apply_to_edit)).toEqual([false, true]);
});
