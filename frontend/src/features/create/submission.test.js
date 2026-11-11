import { expect, test } from 'vitest';

import regionFixture from '../../../../fixtures/api/region-editing.json';
import { createEntries, GROUP, setValue } from '../controls/controls.js';
import {
  buildSubmission,
  dimensionsFor,
  libraryRecordFromResult,
  nearestAspect,
  orderEntries,
  parseDimensions,
  promptKey,
  submitBlockReason,
} from './submission.js';
import {
  clone,
  completedRecord,
  fixtures,
} from '../../../tests/helpers/testSupport.js';

const { models, static_standard: staticStandard } = fixtures.m1;
const base = () => createEntries(clone(staticStandard.controls), GROUP.base);
const generated = () =>
  createEntries(clone(fixtures.m1.dynamic_response.controls), GROUP.generated);
const draft = { prompt: '  amber bird  ', mode: 'image', aspect: '2:3' };
const readyDynamic = (extra = {}) => ({
  status: 'ready',
  anchor: promptKey(draft.prompt, draft.mode),
  metadata: { prompt: 'm' },
  ...extra,
});

test('prompt keys ignore edge whitespace and Unicode form but not mode or text', () => {
  expect(promptKey(' café ', 'image')).toBe(promptKey('café', 'image'));
  expect(promptKey('a', 'image')).not.toBe(promptKey('a', 'asset-image'));
  expect(promptKey('a', 'image')).not.toBe(promptKey('b', 'image'));
});

test('dimensions come only from the server mapping', () => {
  expect(dimensionsFor(models, '3:2')).toBe('1152x768');
  expect(dimensionsFor(models, '2:3')).toBe('768x1152');
  expect(
    dimensionsFor({ supported_dimensions: { '3:2': 'wide' } }, '3:2'),
  ).toBeNull();
  expect(dimensionsFor(null, '3:2')).toBeNull();
  expect(parseDimensions('1024x1024')).toEqual({ width: 1024, height: 1024 });
  expect(parseDimensions('0x5')).toBeNull();
});

test('the nearest supported aspect follows the requested shape', () => {
  const supported = models.supported_dimensions;
  expect(nearestAspect(1152, 768, supported)).toBe('3:2');
  expect(nearestAspect(700, 1000, supported)).toBe('2:3');
  expect(nearestAspect(1000, 1010, supported)).toBe('1:1');
  expect(nearestAspect(800, 400, undefined)).toBe('3:2');
  expect(nearestAspect(0, 0, supported)).toBe('3:2');
});

test('base controls precede generated ones in the request', () => {
  const entries = [...generated(), ...base()];
  expect(orderEntries(entries).map((e) => e.group)).toEqual([
    ...base().map(() => GROUP.base),
    ...generated().map(() => GROUP.generated),
  ]);
});

test('the request carries original wire controls, size, mode and matching metadata', () => {
  const { body } = buildSubmission({
    draft,
    entries: [...generated(), ...base()],
    dynamic: readyDynamic(),
    dimensions: '768x1152',
  });
  expect(body).toMatchObject({
    prompt: 'amber bird',
    dimensions: '768x1152',
    generation_mode: 'standard',
    dynamic_controls_metadata: { prompt: 'm' },
  });
  expect(body.controls).toEqual([
    ...staticStandard.controls,
    ...fixtures.m1.dynamic_response.controls,
  ]);
});

test('canonical generation terms are cloned into the request and fingerprint', () => {
  const terms = clone(fixtures.generation.must_have_terms);
  const sourceEntries = [...generated(), ...base()];
  const sourceControls = clone(sourceEntries.map((entry) => entry.wire));
  const { body, fingerprint } = buildSubmission({
    draft: { ...draft, mustHaveTerms: terms },
    entries: sourceEntries,
    dynamic: readyDynamic(),
    dimensions: '768x1152',
  });

  expect(body.must_have_terms).toEqual(fixtures.generation.must_have_terms);
  expect(body.must_have_terms).not.toBe(terms);
  expect(fingerprint).toBe(JSON.stringify(body));
  terms[0] = 'changed after submit';
  expect(body.must_have_terms).toEqual(fixtures.generation.must_have_terms);
  expect(fingerprint).toBe(JSON.stringify(body));
  expect(sourceEntries.map((entry) => entry.wire)).toEqual(sourceControls);
});

test('empty must-have terms are omitted to preserve existing request identity', () => {
  const args = {
    entries: base(),
    dynamic: readyDynamic(),
    dimensions: '768x1152',
  };
  const withoutTerms = buildSubmission({ draft, ...args });
  const withEmptyTerms = buildSubmission({
    draft: { ...draft, mustHaveTerms: [] },
    ...args,
  });

  expect(withEmptyTerms.body).not.toHaveProperty('must_have_terms');
  expect(withEmptyTerms.fingerprint).toBe(withoutTerms.fingerprint);
});

test('region edits are optional and bind the exact oriented base into request identity', () => {
  const sha = regionFixture.selection.source_sha256;
  const refs = [
    {
      id: 'base',
      sha256: sha,
      description: 'base image',
      dimensions: { width: 16, height: 12 },
      status: 'ready',
      blob: new Blob(['base']),
    },
  ];
  const selection = clone(regionFixture.selection);
  const ordinary = buildSubmission({
    draft,
    entries: base(),
    dynamic: readyDynamic(),
    dimensions: '768x1152',
    references: refs,
  });
  const selected = buildSubmission({
    draft,
    entries: base(),
    dynamic: readyDynamic(),
    dimensions: '768x1152',
    references: refs,
    regionEdit: selection,
    regionCapability: regionFixture.capability,
  });
  expect(ordinary.body).not.toHaveProperty('region_edit');
  expect(selected.body.region_edit).toEqual(selection);
  expect(selected.fingerprint).toBe(JSON.stringify(selected.body));
  selection.shapes[0].x = 0;
  expect(selected.body.region_edit.shapes[0].x).toBe(3);
});

test('region edits refuse unsupported capability or a different base without fallback', () => {
  const refs = [
    {
      id: 'base',
      sha256: regionFixture.selection.source_sha256,
      description: 'base image',
      dimensions: { width: 16, height: 12 },
      status: 'ready',
      blob: new Blob(['base']),
    },
  ];
  const args = {
    draft,
    entries: base(),
    dynamic: readyDynamic(),
    dimensions: '768x1152',
    references: refs,
    regionEdit: regionFixture.selection,
  };
  expect(buildSubmission({ ...args, regionCapability: null }).error).toMatch(
    /clear the region selection/i,
  );
  expect(
    buildSubmission({
      ...args,
      references: [{ ...refs[0], sha256: 'b'.repeat(64) }],
      regionCapability: regionFixture.capability,
    }).error,
  ).toMatch(/different base image/i);
});

test('malformed must-have terms return a submission validation error', () => {
  for (const mustHaveTerms of ['amber', [1], ['amber', null]]) {
    expect(
      buildSubmission({
        draft: { ...draft, mustHaveTerms },
        entries: base(),
        dynamic: readyDynamic(),
        dimensions: '768x1152',
      }),
    ).toEqual({ error: 'Must-have terms must be an array of strings.' });
  }
});

test('metadata from another prompt is not sent', () => {
  const { body } = buildSubmission({
    draft,
    entries: base(),
    dynamic: readyDynamic({ anchor: promptKey('other', 'image') }),
    dimensions: '768x1152',
  });
  expect(body.dynamic_controls_metadata).toBeNull();
});

test('asset mode submits the trellis wire mode', () => {
  const { body } = buildSubmission({
    draft: { ...draft, mode: 'asset-image' },
    entries: base(),
    dynamic: { status: 'idle' },
    dimensions: '768x1152',
  });
  expect(body.generation_mode).toBe('trellis');
});

test('no controls and invalid values are errors, not requests', () => {
  expect(
    buildSubmission({
      draft,
      entries: [],
      dynamic: readyDynamic(),
      dimensions: 'x',
    }).error,
  ).toMatch(/No controls are available/);
  const [first] = generated();
  const slider = generated().find((e) => e.wire.kind === 'slider');
  const result = buildSubmission({
    draft,
    entries: [first, setValue(slider, 500)],
    dynamic: readyDynamic(),
    dimensions: '768x1152',
  });
  expect(result.error).toBe('Head angle must be between 0 and 90.');
  expect(result.body).toBeUndefined();
});

test('identical drafts share a fingerprint; a changed value does not', () => {
  const args = { draft, dynamic: readyDynamic(), dimensions: '768x1152' };
  const a = buildSubmission({ ...args, entries: base() });
  const b = buildSubmission({ ...args, entries: base() });
  const [head, ...rest] = base();
  const c = buildSubmission({
    ...args,
    entries: [setValue(head, null), ...rest],
  });
  expect(a.fingerprint).toBe(b.fingerprint);
  expect(a.fingerprint).not.toBe(c.fingerprint);
});

test('submission is blocked with a specific reason', () => {
  const ready = { status: 'ready', data: models, error: null };
  const health = { status: 'ready', data: fixtures.m1.health };
  const ok = { discovery: { health, models: ready }, draft };
  expect(submitBlockReason(ok)).toBeNull();
  expect(
    submitBlockReason({
      ...ok,
      discovery: {
        health: { data: { inference_enabled: false } },
        models: ready,
      },
    }),
  ).toMatch(/disabled/);
  expect(
    submitBlockReason({
      ...ok,
      discovery: { health, models: { status: 'loading' } },
    }),
  ).toMatch(/Loading/);
  expect(
    submitBlockReason({
      ...ok,
      discovery: { health, models: { status: 'error' } },
    }),
  ).toBe('Image sizes are unavailable.');
  expect(
    submitBlockReason({
      ...ok,
      discovery: {
        health,
        models: {
          status: 'ready',
          data: { ...models, routing: { image: { configured: false } } },
        },
      },
    }),
  ).toMatch(/provider/);
});

test('a completed job becomes a library record with original controls', () => {
  const record = libraryRecordFromResult(completedRecord());
  expect(record.selected_controls).toEqual(fixtures.generation.controls);
  expect(record.resolved_controls[0].value).toBe('smooth glass');
  expect(record.dynamic_controls_metadata).toEqual(
    fixtures.generation.dynamic_controls_metadata,
  );
});
