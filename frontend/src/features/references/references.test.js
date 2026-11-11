import { expect, test } from 'vitest';

import editing from '../../../../fixtures/api/image-editing.json';
import { createEntries, GROUP, setValue } from '../controls/controls.js';
import {
  appliesToEdit,
  buildEditForm,
  checkReferenceFile,
  DRAFT_KIND,
  draftKind,
  EDIT_NEEDS_REFERENCE,
  EDIT_UNAVAILABLE,
  editBlockReason,
  editingCapability,
  EDIT_CHECKING,
  EDIT_UNKNOWN,
  overLimitReason,
  selectedEditingCapability,
  recordReferences,
  REF_STATUS,
  referenceBlockReason,
  referenceDescriptors,
  referenceSignature,
  serializeEditEntries,
  serializeTextEntries,
  savedReferenceFile,
  withRecordedEdit,
} from './references.js';
import { buildSubmission } from '../create/submission.js';

const capability = editingCapability({ image_editing: editing.capabilities });
const uploads = {
  image_mime_types: ['image/png', 'image/jpeg', 'image/webp'],
  import_max_bytes: 32 * 1024 * 1024,
};
const file = (name, size = 10, type = 'image/png') =>
  new File([new Uint8Array(size)], name, { type });
const wire = (id, value, extra = {}) => ({
  id,
  label: id,
  kind: 'single-select',
  origin: 'fixed',
  options: { a: 'A', b: 'B' },
  value,
  ...extra,
});

test('saved reference files use valid metadata, response MIME or extension fallback without losing bytes', () => {
  const source = new Blob(['original bytes'], {
    type: 'application/octet-stream',
  });
  for (const [filename, expected] of [
    ['base.png', 'image/png'],
    ['base.JPG', 'image/jpeg'],
    ['base.webp', 'image/webp'],
  ]) {
    const named = savedReferenceFile(source, { filename, content_type: '' });
    expect(named.type).toBe(expected);
    expect(named.name).toBe(filename);
    expect(named.size).toBe(source.size);
  }
  expect(
    savedReferenceFile(new Blob(['x'], { type: 'image/jpeg' }), {
      filename: 'no-extension',
    }).type,
  ).toBe('image/jpeg');
});

test('capability: a missing object, unknown transport or disabled flag is unsupported', () => {
  expect(editingCapability({})).toBeNull();
  expect(capability).toMatchObject({
    enabled: true,
    maxReferences: 10,
    model: 'Qwen-Image-2.1',
    modelMaxReferences: 10,
    limitSource: 'model',
    prompting: {
      strategy: 'qwen-image-2.1',
      model: 'Qwen-Image-2.1',
      labels: {
        1: ['the image'],
        2: ['<image1>', '<image2>'],
      },
    },
  });
  // An older server's fixed limit is honored exactly.
  expect(
    editingCapability({ image_editing: editing.legacy_capabilities }),
  ).toMatchObject({
    enabled: true,
    maxReferences: 4,
    model: 'Qwen-Image-2.1',
    modelMaxReferences: null,
  });
  expect(
    editingCapability({
      image_editing: { ...editing.capabilities, transport: 'other' },
    }).enabled,
  ).toBe(false);
  expect(
    editingCapability({
      image_editing: { ...editing.capabilities, enabled: false },
    }).enabled,
  ).toBe(false);
});

test('file checks follow the count, type, per-file and combined limits', () => {
  expect(checkReferenceFile(file('a.png'), capability, [], uploads)).toBeNull();
  expect(
    checkReferenceFile(file('a.gif', 10, 'image/gif'), capability, [], uploads),
  ).toMatch(/not a PNG, JPEG or WebP/);
  const nine = Array.from({ length: 9 }, () => ({}));
  expect(
    checkReferenceFile(file('a.png'), capability, nine, uploads),
  ).toBeNull();
  expect(
    checkReferenceFile(file('a.png'), capability, [...nine, {}], uploads),
  ).toBe('Qwen-Image-2.1 accepts up to 10 references here.');
  const legacy = editingCapability({
    image_editing: editing.legacy_capabilities,
  });
  expect(
    checkReferenceFile(file('a.png'), legacy, [{}, {}, {}, {}], uploads),
  ).toBe('Qwen-Image-2.1 accepts up to 4 references here.');
  const unnamed = editingCapability({
    image_editing: { ...editing.legacy_capabilities, prompting: null },
  });
  expect(
    checkReferenceFile(file('a.png'), unnamed, [{}, {}, {}, {}], uploads),
  ).toBe('At most 4 references can be attached.');
  const big = { size: 33 * 1024 * 1024 };
  expect(
    checkReferenceFile(
      { name: 'b.png', type: 'image/png', size: 33 * 1024 * 1024 },
      capability,
      [],
      uploads,
    ),
  ).toMatch(/limit is 32 MiB/);
  expect(
    checkReferenceFile(
      { name: 'c.png', type: 'image/png', size: 32 * 1024 * 1024 },
      capability,
      [big],
      { ...uploads, import_max_bytes: 40 * 1024 * 1024 },
    ),
  ).toMatch(/total 64 MiB/);
  expect(
    checkReferenceFile(file('a.png'), { enabled: false }, [], uploads),
  ).toBe('Image editing is unavailable.');
});

test('descriptors keep order, hashes and roles; the first reference is the base', () => {
  const refs = editing.generation.request.reference_images.map((d) => ({
    ...d,
    role: undefined,
  }));
  expect(referenceDescriptors(refs).map((d) => [d.id, d.role])).toEqual([
    ['fixture-reference-1', 'base'],
    ['fixture-reference-2', 'reference'],
  ]);
  const swapped = [refs[1], refs[0]];
  expect(referenceSignature(swapped)).not.toBe(referenceSignature(refs));
  // A saved custom role survives restoring and reordering.
  expect(
    referenceDescriptors(editing.generation.request.reference_images)[1].role,
  ).toBe('palette');
  expect(referenceSignature([])).toBe('');
});

test('random or default values keep the source; chosen values apply', () => {
  const [style, light] = createEntries(
    [wire('style', 'a'), wire('light', 'b')],
    GROUP.base,
  );
  const chosen = { ...setValue(style, 'b'), explicit: true };
  const off = { ...chosen, applyToEdit: false };
  expect([
    appliesToEdit(light),
    appliesToEdit(chosen),
    appliesToEdit(off),
  ]).toEqual([false, true, false]);
  const edit = serializeEditEntries([chosen, light, off]);
  expect(edit.map((w) => [w.id, w.value, w.apply_to_edit])).toEqual([
    ['style', 'b', true],
    ['light', 'b', false],
    ['style', 'b', false],
  ]);
  // Text requests never carry the edit flag, even from a restored edit.
  const restored = createEntries(
    [wire('style', 'a', { apply_to_edit: false })],
    GROUP.base,
  );
  expect(serializeTextEntries(restored)[0]).not.toHaveProperty('apply_to_edit');
  expect(withRecordedEdit(restored)[0].applyToEdit).toBe(false);
  expect(
    withRecordedEdit(createEntries([wire('x', 'a')], GROUP.base))[0]
      .applyToEdit,
  ).toBe(true);
});

test('an edit submission may have no controls and adds ordered descriptors', () => {
  const refs = [
    { id: 'r1', sha256: 'a'.repeat(64), description: 'one' },
    { id: 'r2', sha256: 'b'.repeat(64), description: 'two' },
  ];
  const draft = { prompt: ' Change it ', mode: 'image', mustHaveTerms: [] };
  const dynamic = { status: 'idle', anchor: null, metadata: null };
  const edit = buildSubmission({
    draft,
    entries: [],
    dynamic,
    dimensions: '96x64',
    references: refs,
  });
  expect(edit.body).toMatchObject({
    prompt: 'Change it',
    controls: [],
    reference_images: [
      { id: 'r1', sha256: 'a'.repeat(64), description: 'one', role: 'base' },
      {
        id: 'r2',
        sha256: 'b'.repeat(64),
        description: 'two',
        role: 'reference',
      },
    ],
  });
  expect(
    buildSubmission({ draft, entries: [], dynamic, dimensions: '96x64' }).error,
  ).toMatch(/No controls/);
});

test('the multipart form carries the request then files in descriptor order', async () => {
  const a = file('first.png', 3);
  const b = file('second.png', 4);
  const form = buildEditForm({ prompt: 'p', reference_images: [] }, [
    { blob: a, name: 'first.png' },
    { blob: b, name: 'second.png' },
  ]);
  expect([...form.keys()]).toEqual(['request', 'reference_1', 'reference_2']);
  expect(JSON.parse(form.get('request')).prompt).toBe('p');
  expect(form.get('reference_1').name).toBe('first.png');
  expect(form.get('reference_2').size).toBe(4);
});

test('block reasons: unsupported, missing, resolving and reading', () => {
  const ready = { status: REF_STATUS.ready, sha256: 'x', blob: {} };
  expect(referenceBlockReason([], null)).toBeNull();
  expect(referenceBlockReason([ready], null)).toMatch(/cannot edit images/);
  expect(
    referenceBlockReason([ready, { status: REF_STATUS.missing }], capability),
  ).toBe('Attach reference 2 again to edit.');
  expect(
    referenceBlockReason([{ status: REF_STATUS.resolving }], capability),
  ).toMatch(/Finding/);
  expect(
    referenceBlockReason([{ ...ready, converting: true }], capability),
  ).toMatch(/Reading/);
  expect(
    referenceBlockReason([{ ...ready, analyzing: true }], capability),
  ).toBeNull();
  expect(referenceBlockReason([ready], capability)).toBeNull();
});

test('only saved edits restore references', () => {
  const result = editing.generation.complete.result;
  expect(recordReferences(result).map((r) => r.id)).toEqual([
    'fixture-reference-1',
    'fixture-reference-2',
  ]);
  expect(
    recordReferences({ ...result, generation_type: 'text-to-image' }),
  ).toEqual([]);
});

test('the draft kind is an explicit Edit choice, and references always mean Edit', () => {
  expect(draftKind({ mode: 'image', edit: false })).toBe(DRAFT_KIND.text);
  expect(draftKind({ mode: 'asset-image', edit: false })).toBe(
    DRAFT_KIND.asset,
  );
  expect(draftKind({ mode: 'image', edit: true })).toBe(DRAFT_KIND.edit);
  expect(draftKind({ mode: 'asset-image', edit: true })).toBe(DRAFT_KIND.edit);
  expect(draftKind({ mode: 'image', edit: false }, [{ id: 'a' }])).toBe(
    DRAFT_KIND.edit,
  );
});

test('an edit without a reference is blocked; text drafts are not', () => {
  const capability = editingCapability({
    image_editing: editing.capabilities,
  });
  expect(editBlockReason(false, [], capability)).toBeNull();
  expect(editBlockReason(false, [], null)).toBeNull();
  expect(editBlockReason(true, [], capability)).toBe(EDIT_NEEDS_REFERENCE);
  expect(editBlockReason(true, [], null)).toBe(EDIT_UNAVAILABLE);
  const ready = [
    {
      id: 'upload:a',
      status: REF_STATUS.ready,
      blob: new Blob(['x']),
      sha256: 'a'.repeat(64),
    },
  ];
  expect(editBlockReason(true, ready, capability)).toBe(
    referenceBlockReason(ready, capability),
  );
});

test("the selected provider's model facts decide editing; a pending override never borrows the default", () => {
  const lowered = {
    ...editing.capabilities,
    max_references: 3,
    limit_source: 'configured',
  };
  const capabilities = {
    status: 'ready',
    data: { image_editing: editing.capabilities },
  };
  const models = (status, imageEditing) => ({
    status,
    data: status === 'ready' ? { image_editing: imageEditing } : null,
  });
  expect(
    selectedEditingCapability({
      capabilities,
      models: models('ready', lowered),
    }),
  ).toMatchObject({
    enabled: true,
    maxReferences: 3,
    limitSource: 'configured',
  });
  // Without an override the server default is the same provider.
  expect(
    selectedEditingCapability({ capabilities, models: models('loading') }),
  ).toMatchObject({ enabled: true, maxReferences: 10 });
  const checking = selectedEditingCapability(
    { capabilities, models: models('loading') },
    true,
  );
  expect(checking).toMatchObject({ enabled: false, checking: true });
  expect(editBlockReason(true, [], checking)).toBe(EDIT_CHECKING);
  const failed = selectedEditingCapability(
    { capabilities, models: { status: 'error', data: null } },
    true,
  );
  expect(editBlockReason(true, [], failed)).toBe(EDIT_UNKNOWN);
  // An older server whose model facts carry no editing object.
  expect(
    selectedEditingCapability(
      { capabilities, models: { status: 'ready', data: {} } },
      true,
    ),
  ).toMatchObject({ enabled: true, maxReferences: 10 });
  const disabled = selectedEditingCapability({
    capabilities,
    models: models('ready', {
      ...editing.capabilities,
      enabled: false,
      max_references: 0,
    }),
  });
  expect(disabled).toMatchObject({ enabled: false, maxReferences: 0 });
});

test('over the selected limit, every reference stays and the reason counts what to remove', () => {
  const three = editingCapability({
    image_editing: { ...editing.capabilities, max_references: 3 },
  });
  const ready = (n) =>
    Array.from({ length: n }, (_, i) => ({
      id: `r${i}`,
      status: 'ready',
      sha256: 'a'.repeat(64),
      blob: new Blob(['x']),
    }));
  expect(overLimitReason(ready(3), three)).toBeNull();
  const six = ready(6);
  expect(referenceBlockReason(six, three)).toBe(
    'Qwen-Image-2.1 accepts up to 3 references here. Remove 3 to edit.',
  );
  expect(six).toHaveLength(6);
  expect(referenceBlockReason(ready(10), capability)).toBeNull();
  expect(referenceBlockReason(ready(11), capability)).toBe(
    'Qwen-Image-2.1 accepts up to 10 references here. Remove 1 to edit.',
  );
});
