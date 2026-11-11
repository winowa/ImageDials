/**
 * Lossless adapters between wire Control objects and the editable control list.
 *
 * An entry is `{ key, group, wire, initial, custom }`. `wire` is the Control
 * exactly as received, with only `value` (and user-added `options`) changed, so
 * unknown fields and kinds survive editing, submission and restoration. `key`
 * is an internal identity that never depends on the display label.
 */
import { originClassOf } from './selectionProvenance.js';

export const KIND = {
  slider: 'slider',
  single: 'single-select',
  dropdown: 'dropdown',
  radio: 'radio',
  multi: 'multi-select',
  checkbox: 'checkbox',
  text: 'text-input',
  binary: 'binary',
};

export const GROUP = { base: 'base', generated: 'generated' };

const SINGLE_CHOICE = new Set([KIND.single, KIND.dropdown, KIND.radio]);
const MULTI_CHOICE = new Set([KIND.multi, KIND.checkbox]);
const KNOWN_KINDS = new Set(Object.values(KIND));

/** Slider bounds the wire contract assumes when a control omits them. */
export const SLIDER_DEFAULTS = { min: 0, max: 100, step: 1 };
/** Longest custom option text a person can add. */
export const CUSTOM_OPTION_MAX_CHARS = 60;

/** Internal category `type` to wire `kind`, for records saved before wire controls. */
const KIND_BY_CATEGORY_TYPE = {
  range: KIND.slider,
  single: KIND.single,
  multi: KIND.multi,
  select: KIND.dropdown,
  radio: KIND.radio,
  checkbox: KIND.checkbox,
  text: KIND.text,
  binary: KIND.binary,
};

export const isKnownKind = (kind) => KNOWN_KINDS.has(kind);
export const isSingleChoice = (kind) => SINGLE_CHOICE.has(kind);
export const isMultiChoice = (kind) => MULTI_CHOICE.has(kind);
export const isChoiceKind = (kind) =>
  SINGLE_CHOICE.has(kind) || MULTI_CHOICE.has(kind);

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isFiniteNumber = (value) =>
  typeof value === 'number' && Number.isFinite(value);

/** Deep copy for JSON-shaped data; wire controls are always JSON. */
export const cloneJson = (value) =>
  value === undefined ? value : JSON.parse(JSON.stringify(value));

export function sliderBounds(wire) {
  return {
    min: wire.min ?? SLIDER_DEFAULTS.min,
    max: wire.max ?? SLIDER_DEFAULTS.max,
    step: wire.step ?? SLIDER_DEFAULTS.step,
  };
}

/**
 * Option maps hold display strings or objects ({ value?, label?, description? }).
 * @returns {{key: string, label: string, description: string|null}[]}
 */
export function optionEntries(wire) {
  if (!isObject(wire.options)) return [];
  return Object.entries(wire.options).map(([key, option]) => {
    if (!isObject(option))
      return { key, label: String(option), description: null };
    const named = [option.label, option.name, option.value].find(
      (candidate) => typeof candidate === 'string' && candidate,
    );
    return {
      key,
      label:
        named ?? (isFiniteNumber(option.value) ? String(option.value) : key),
      description:
        typeof option.description === 'string' && option.description
          ? option.description
          : null,
    };
  });
}

export function selectedOptionKeys(wire) {
  if (isMultiChoice(wire.kind))
    return Array.isArray(wire.value)
      ? wire.value.filter((v) => typeof v === 'string')
      : [];
  return typeof wire.value === 'string' ? [wire.value] : [];
}

function uniqueKey(base, used) {
  let key = base;
  for (let n = 2; used.has(key); n += 1) key = `${base}#${n}`;
  used.add(key);
  return key;
}

/** The text request's flag for a control left to the model. */
export const TEXT_FLAG = 'apply_to_generation';

/** Whether a control instructs a text-to-image request (the default). */
export const isEnabled = (entry) => entry.enabled !== false;

/**
 * The server's optional-control support, or false. An older server ignores
 * the text flag and would still use a value shown as off, so the choice is
 * offered only when the server names it.
 */
export function controlApplicationSupported(capabilities) {
  const raw = capabilities?.control_application;
  return isObject(raw) && raw.enabled === true && raw.text_flag === TEXT_FLAG;
}

/**
 * Identity from the server's `id` when present, else from kind and label. A
 * restored `apply_to_generation: false` becomes the entry's own off state;
 * the flag is written again only when the draft is sent.
 */
export function createEntry(wire, group, used = new Set()) {
  const own =
    typeof wire.id === 'string' && wire.id
      ? wire.id
      : `${wire.kind}:${wire.label}`;
  let plain = wire;
  let off = false;
  if (isObject(wire) && Object.hasOwn(wire, TEXT_FLAG)) {
    const { [TEXT_FLAG]: flag, ...rest } = wire;
    plain = rest;
    off = flag === false;
  }
  return {
    key: uniqueKey(`${group}:${own}`, used),
    group,
    wire: plain,
    initial: cloneJson(plain.value),
    custom: [],
    intentClass: 'automatic',
    ...(off ? { enabled: false } : {}),
  };
}

export function createEntries(wires, group) {
  const used = new Set();
  return wires.map((wire) => createEntry(wire, group, used));
}

/** Controls from a response must be an array of objects with a string kind and label. */
export function parseControlList(list) {
  if (!Array.isArray(list))
    throw new Error('The controls response was malformed.');
  for (const wire of list) {
    if (
      !isObject(wire) ||
      typeof wire.kind !== 'string' ||
      typeof wire.label !== 'string'
    )
      throw new Error('A control in the response was malformed.');
  }
  return list;
}

const withWire = (entry, patch) => ({
  ...entry,
  wire: { ...entry.wire, ...patch },
});

export const setValue = (entry, value) => withWire(entry, { value });

export function resetEntry(entry) {
  return setValue(entry, cloneJson(entry.initial));
}

/** Toggle one option; single choices deselect to null, multi choices to a shorter list. */
export function toggleOption(entry, optionKey) {
  if (isMultiChoice(entry.wire.kind)) {
    const selected = selectedOptionKeys(entry.wire);
    return setValue(
      entry,
      selected.includes(optionKey)
        ? selected.filter((k) => k !== optionKey)
        : [...selected, optionKey],
    );
  }
  return setValue(entry, entry.wire.value === optionKey ? null : optionKey);
}

/** Add a person-written option and select it; an existing equal option is reused. */
export function addCustomOption(entry, text) {
  const label = text.trim().slice(0, CUSTOM_OPTION_MAX_CHARS);
  if (!label || !isChoiceKind(entry.wire.kind)) return entry;
  const existing = optionEntries(entry.wire).find(
    (o) => o.key === label || o.label === label,
  );
  const key = existing?.key ?? label;
  const options = existing
    ? entry.wire.options
    : {
        ...(isObject(entry.wire.options) ? entry.wire.options : {}),
        [key]: label,
      };
  const next = {
    ...entry,
    custom: existing ? entry.custom : [...entry.custom, key],
    wire: { ...entry.wire, options },
  };
  return isMultiChoice(entry.wire.kind)
    ? setValue(next, [...new Set([...selectedOptionKeys(entry.wire), key])])
    : setValue(next, key);
}

/**
 * Clear what a person has chosen. Sliders and two-state controls have no
 * unset value on the wire, so they keep theirs (this is NOT clearing them);
 * callers that need a neutral state start from the server's own controls.
 */
export function clearSelection(entry) {
  const { kind } = entry.wire;
  if (isMultiChoice(kind)) return setValue(entry, []);
  if (isSingleChoice(kind)) return setValue(entry, null);
  if (kind === KIND.text) return setValue(entry, '');
  return entry;
}

/** Most category summaries a request carries (the server's own limit). */
export const CATEGORY_CONTEXT_MAX = 30;

/**
 * Value-free descriptors of every current category, so generation and
 * expansion avoid repeating a visual category. Only id, label, kind and
 * description are sent: never options, values or other metadata.
 */
export function categorySummaries(entries) {
  return entries.slice(0, CATEGORY_CONTEXT_MAX).map(({ wire }) => {
    const summary = { label: wire.label, kind: wire.kind };
    if (typeof wire.id === 'string' && wire.id) summary.id = wire.id;
    if (typeof wire.description === 'string' && wire.description)
      summary.description = wire.description;
    return summary;
  });
}

/**
 * The expansion request: the complete target Control (its options are needed
 * for de-duplication, and unknown fields survive) plus summaries of all
 * current categories as context.
 */
export const expansionRequest = (entry, entries) => ({
  control: cloneJson(entry.wire),
  categories: categorySummaries(entries),
});

/**
 * The More controls request: the idea, the mode and value-free descriptors of
 * every current control (no selections or option lists). The server's default
 * batch size applies.
 */
export const additionalRequest = ({ prompt, mode }, entries) => ({
  prompt: prompt.trim(),
  generation_mode: mode === 'asset-image' ? 'trellis' : 'standard',
  categories: categorySummaries(entries),
});

/** Identity of the descriptor set a More controls answer was requested for. */
export const descriptorSignature = (entries) =>
  JSON.stringify(categorySummaries(entries));

/**
 * The total control limit that applies to a draft: the server's own 30, or a
 * published integer from 1 to 29 that narrows it. An absent, non-integer,
 * zero, negative or larger value never raises or removes the limit.
 */
export const effectiveControlLimit = (published) =>
  Number.isInteger(published) &&
  published >= 1 &&
  published < CATEGORY_CONTEXT_MAX
    ? published
    : CATEGORY_CONTEXT_MAX;

/** Whether another batch fits under the total control limit. */
export const hasControlCapacity = (entries, maxControls) =>
  entries.length < effectiveControlLimit(maxControls);

/**
 * Append a More controls answer to the CURRENT entries: nothing existing is
 * touched. Throws when the answer is malformed, reuses an ID or label already
 * in the list, or would pass the total limit, so the caller can refuse it whole.
 */
export function appendAdditional(entries, response, maxControls) {
  const wires = parseControlList(response?.controls);
  const metadata = response?.additional_controls_metadata;
  if (!wires.length || !isObject(metadata))
    throw new Error('The additional controls response was malformed.');
  if (entries.length + wires.length > effectiveControlLimit(maxControls))
    throw new Error('The additional controls no longer fit the control limit.');
  const normal = (text) => text.normalize('NFC').trim().toLowerCase();
  const ids = new Set(
    entries.flatMap(({ wire }) => (wire.id ? [normal(String(wire.id))] : [])),
  );
  const labels = new Set(entries.map(({ wire }) => normal(wire.label)));
  for (const wire of wires) {
    const id = wire.id ? normal(String(wire.id)) : null;
    const label = normal(wire.label);
    if ((id && ids.has(id)) || labels.has(label))
      throw new Error('The additional controls repeated an existing control.');
    if (id) ids.add(id);
    labels.add(label);
  }
  const used = new Set(entries.map((e) => e.key));
  return {
    entries: [
      ...entries,
      ...wires.map((wire) => createEntry(wire, GROUP.generated, used)),
    ],
    added: wires.length,
    metadata,
  };
}

/** The additive provenance list of a saved record (only objects are kept). */
export const recordAdditionalMetadata = (record) =>
  Array.isArray(record?.additional_controls_metadata)
    ? record.additional_controls_metadata.filter(isObject)
    : [];

const optionLabel = (key, option) =>
  optionEntries({ options: { [key]: option } })[0].label;

/**
 * Fold the enriched Control returned by option expansion into `entry` AS IT IS
 * NOW. The person may have selected, typed or added choices while the request
 * ran, so nothing they hold is replaced: the current value, existing options,
 * custom options and every field already present stay; only options with a new
 * key and a new label, and fields the server newly adds, come from the response.
 * @returns {{entry: object, added: number}}
 */
export function applyExpansion(entry, enriched) {
  const { wire } = entry;
  if (
    !isObject(enriched) ||
    enriched.kind !== wire.kind ||
    !isObject(enriched.options) ||
    (enriched.id !== undefined &&
      wire.id !== undefined &&
      enriched.id !== wire.id)
  )
    throw new Error('The option expansion response was malformed.');
  const options = isObject(wire.options) ? wire.options : {};
  const labels = new Set(
    Object.entries(options).map(([k, o]) => optionLabel(k, o)),
  );
  const added = Object.entries(enriched.options).filter(
    ([key, option]) =>
      !(key in options) && !labels.has(optionLabel(key, option)),
  );
  const extra = Object.entries(enriched).filter(([key]) => !(key in wire));
  if (!added.length && !extra.length) return { entry, added: 0 };
  return {
    entry: {
      ...entry,
      wire: {
        ...wire,
        ...Object.fromEntries(extra),
        options: { ...options, ...Object.fromEntries(added) },
      },
    },
    added: added.length,
  };
}

/** Message for an invalid known-kind value, or null. Unknown kinds always pass. */
export function validateWire(wire) {
  const { kind, value } = wire;
  if (kind === KIND.slider) {
    const { min, max, step } = sliderBounds(wire);
    if (![min, max, step, value].every(isFiniteNumber))
      return 'needs a numeric value and numeric bounds';
    if (min >= max || step <= 0) return 'has invalid slider bounds';
    if (value < min || value > max) return `must be between ${min} and ${max}`;
  } else if (kind === KIND.binary) {
    if (typeof value !== 'boolean') return 'must be on or off';
  } else if (kind === KIND.text) {
    if (typeof value !== 'string') return 'must be text';
  } else if (isMultiChoice(kind)) {
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string'))
      return 'must be a list of choices';
  } else if (isSingleChoice(kind)) {
    if (value !== null && typeof value !== 'string')
      return 'must be one choice or none';
  }
  return null;
}

/** @returns {{key: string, label: string, message: string}[]} */
export function validateEntries(entries) {
  return entries.flatMap((entry) => {
    const message = validateWire(entry.wire);
    return message
      ? [{ key: entry.key, label: entry.wire.label, message }]
      : [];
  });
}

/** Original wire controls, copied so later edits cannot change a submission. */
export const serializeEntries = (entries) =>
  entries.map((entry) => cloneJson(entry.wire));

/** Selected value as display text; false, zero and text are values, not absences. */
export function describeControl(wire) {
  const { kind, value } = wire;
  if (isChoiceKind(kind)) {
    const labels = new Map(optionEntries(wire).map((o) => [o.key, o.label]));
    const chosen = selectedOptionKeys(wire).map((k) => labels.get(k) ?? k);
    return chosen.length ? chosen.join(', ') : null;
  }
  if (kind === KIND.slider) return isFiniteNumber(value) ? String(value) : null;
  if (kind === KIND.text)
    return typeof value === 'string' && value.trim() ? value : null;
  if (kind === KIND.binary) {
    if (typeof value !== 'boolean') return null;
    return value ? (wire.trueLabel ?? 'Yes') : (wire.falseLabel ?? 'No');
  }
  return null;
}

/** Merge a regenerated generated-group list, keeping selections that remain valid. */
export function mergeGenerated(previous, incomingWires) {
  const before = new Map(
    previous.filter((e) => e.group === GROUP.generated).map((e) => [e.key, e]),
  );
  const used = new Set(
    previous.filter((e) => e.group !== GROUP.generated).map((e) => e.key),
  );
  return incomingWires.map((wire) => {
    const entry = createEntry(wire, GROUP.generated, used);
    const old = before.get(entry.key);
    if (!old || old.wire.kind !== wire.kind) return entry;
    const merged = carryOver(entry, old);
    // A person's own choice, and whether it applies to an edit, carry over.
    return old.explicit || typeof old.applyToEdit === 'boolean'
      ? { ...merged, explicit: old.explicit, applyToEdit: old.applyToEdit }
      : merged;
  });
}

function carryOver(fresh, old) {
  const { kind } = fresh.wire;
  let entry = fresh;
  if (isChoiceKind(kind)) {
    for (const key of old.custom) {
      if (!(key in (entry.wire.options ?? {})))
        entry = addCustomOption(entry, old.wire.options?.[key] ?? key);
    }
    entry = setValue(entry, fresh.wire.value);
    const keys = new Set(optionEntries(entry.wire).map((o) => o.key));
    const oldKeys = selectedOptionKeys(old.wire);
    if (isMultiChoice(kind))
      return setValue(
        entry,
        oldKeys.filter((k) => keys.has(k)),
      );
    if (old.wire.value === null || keys.has(old.wire.value))
      return setValue(entry, old.wire.value);
    return entry;
  }
  const keep =
    (kind === KIND.text && typeof old.wire.value === 'string') ||
    (kind === KIND.binary && typeof old.wire.value === 'boolean') ||
    (kind === KIND.slider &&
      validateWire({ ...fresh.wire, value: old.wire.value }) === null);
  return keep ? setValue(fresh, old.wire.value) : fresh;
}

/** Wire control for a record saved with the earlier internal category shape. */
export function wireFromCategory(category) {
  const {
    type,
    options,
    true_label: trueLabel,
    false_label: falseLabel,
    ...rest
  } = category;
  const wire = { ...rest, kind: KIND_BY_CATEGORY_TYPE[type] ?? type };
  wire.options = Object.fromEntries(
    (Array.isArray(options) ? options : []).map((o) => [o.id, o.label]),
  );
  if (trueLabel !== undefined) wire.trueLabel = trueLabel;
  if (falseLabel !== undefined) wire.falseLabel = falseLabel;
  return wire;
}

const nonEmptyList = (list) =>
  Array.isArray(list) && list.length ? list : null;

/**
 * The original wire controls of a saved record. A completed job carries them in
 * `original_selected_controls` (its `selected_controls` are resolved); library
 * records carry originals in `selected_controls`; older records hold categories.
 */
export function recordControls(record) {
  // A record that names its originals never falls back to resolved values.
  const original = Array.isArray(record?.original_selected_controls)
    ? record.original_selected_controls
    : nonEmptyList(record?.selected_controls);
  if (original?.length) return original.filter(isObject);
  const categories = nonEmptyList(record?.categories);
  return categories ? categories.filter(isObject).map(wireFromCategory) : [];
}

/**
 * Draft entries restored from a record; fixed controls form the base group.
 * Each entry's origin class is what its wire PROVES (a known provenance
 * record); a saved boolean flag never proves a click, so a wire without
 * provenance restores as legacy/unknown and is never claimed as manual.
 */
export function entriesFromRecord(record) {
  const used = new Set();
  return recordControls(record).map((wire) => ({
    ...createEntry(
      wire,
      wire.origin === 'fixed' ? GROUP.base : GROUP.generated,
      used,
    ),
    intentClass: originClassOf(wire),
  }));
}

const toMultiValue = (value) =>
  Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];

/**
 * Bring ONE restored fixed control up to the current server catalog entry.
 * Only a single-choice control that the catalog now offers as multi-select
 * changes kind (scalar to one-item list, null to []); options the catalog has
 * and the control lacks are appended after the ones it already has. Value,
 * custom options and unknown fields are kept, and the input is not mutated.
 */
function upgradeFixedEntry(entry, catalogWire) {
  const { wire } = entry;
  const ownOptions = isObject(wire.options) ? wire.options : {};
  const labels = new Set(
    Object.entries(ownOptions).map(([k, o]) => optionLabel(k, o)),
  );
  const missing = Object.entries(catalogWire.options ?? {}).filter(
    ([key, option]) =>
      !(key in ownOptions) && !labels.has(optionLabel(key, option)),
  );
  const toMulti =
    isMultiChoice(catalogWire.kind) &&
    isSingleChoice(wire.kind) &&
    (wire.value === null || typeof wire.value === 'string');
  if (!missing.length && !toMulti) return entry;
  const patch = {};
  if (missing.length)
    patch.options = { ...ownOptions, ...Object.fromEntries(missing) };
  if (toMulti) {
    patch.kind = catalogWire.kind;
    patch.value = toMultiValue(wire.value);
  }
  return {
    ...entry,
    wire: { ...wire, ...patch },
    initial: toMulti ? toMultiValue(entry.initial) : entry.initial,
  };
}

/**
 * Upgrade the known fixed controls of an editable draft to the current catalog.
 * A control qualifies only by its stable `id` and `origin: "fixed"` (never its
 * label); generated, custom and unknown controls are returned untouched.
 */
export function upgradeFixedEntries(entries, catalogWires) {
  const catalog = new Map(
    catalogWires
      .filter((wire) => typeof wire.id === 'string' && wire.id)
      .map((wire) => [wire.id, wire]),
  );
  return entries.map((entry) => {
    const { wire } = entry;
    if (entry.group !== GROUP.base || wire.origin !== 'fixed') return entry;
    const current = catalog.get(wire.id);
    return current && isKnownKind(wire.kind)
      ? upgradeFixedEntry(entry, current)
      : entry;
  });
}

/** Short label/value pairs for result and library summaries. */
export function selectionSummary(record) {
  const used = new Set();
  return recordControls(record).flatMap((wire) => {
    const value =
      wire.apply_to_generation === false
        ? 'Model decides'
        : describeControl(wire);
    return value === null
      ? []
      : [
          {
            key: uniqueKey(`${wire.id ?? wire.label}`, used),
            label: wire.label,
            value,
            // An edit control that kept the source was saved but not applied.
            ...(wire.apply_to_edit === false ? { kept: true } : {}),
          },
        ];
  });
}
