import { appliesToEdit } from './references.js';

/** Browser-private Standard control values; never a saved prompt or job. */
import {
  cloneJson,
  GROUP,
  isChoiceKind,
  isKnownKind,
  isMultiChoice,
  isSingleChoice,
  optionEntries,
  selectedOptionKeys,
  validateWire,
} from './controls.js';

export const PRESET_LIMITS = Object.freeze({
  count: 32,
  bytes: 256 * 1024,
  name: 60,
  controls: 32,
  custom: 64,
  text: 4096,
});
const modes = new Set(['image', 'asset-image']);
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const bounded = (v, n) => typeof v === 'string' && Array.from(v).length <= n;
const identity = (v) => bounded(v, 120) && v.trim().length > 0;

/** Allowlist values before persistence, including data loaded from storage. */
export function normalizePreset(input) {
  if (
    !object(input) ||
    !bounded(input.name, PRESET_LIMITS.name) ||
    !input.name.trim() ||
    !modes.has(input.mode) ||
    !Array.isArray(input.controls) ||
    !input.controls.length ||
    input.controls.length > PRESET_LIMITS.controls
  )
    throw new Error('The control preset is invalid.');
  const seen = new Set();
  const controls = input.controls.map((item) => {
    if (
      !object(item) ||
      !identity(item.id) ||
      seen.has(item.id) ||
      !isKnownKind(item.kind) ||
      !Array.isArray(item.custom) ||
      item.custom.length > PRESET_LIMITS.custom ||
      (item.applyToEdit !== undefined &&
        typeof item.applyToEdit !== 'boolean') ||
      (item.enabled !== undefined && typeof item.enabled !== 'boolean')
    )
      throw new Error('A preset control is invalid.');
    seen.add(item.id);
    const customKeys = new Set();
    const custom = item.custom.map((option) => {
      if (
        !object(option) ||
        !identity(option.key) ||
        !bounded(option.label, 60) ||
        !option.label.trim() ||
        customKeys.has(option.key)
      )
        throw new Error('A custom preset choice is invalid.');
      customKeys.add(option.key);
      return { key: option.key, label: option.label };
    });
    const value = item.value;
    if (
      value !== null &&
      !['boolean', 'number', 'string'].includes(typeof value) &&
      !Array.isArray(value)
    )
      throw new Error('A preset value is invalid.');
    if (
      (typeof value === 'string' && !bounded(value, PRESET_LIMITS.text)) ||
      (Array.isArray(value) &&
        (value.length > PRESET_LIMITS.custom ||
          value.some((v) => !identity(v)))) ||
      (item.kind !== 'slider' && validateWire({ kind: item.kind, value })) ||
      (item.kind === 'slider' &&
        (typeof value !== 'number' || !Number.isFinite(value)))
    )
      throw new Error('A preset value is invalid.');
    return {
      id: item.id,
      kind: item.kind,
      value: cloneJson(value),
      custom,
      ...(typeof item.applyToEdit === 'boolean'
        ? { applyToEdit: item.applyToEdit }
        : {}),
      ...(typeof item.enabled === 'boolean' ? { enabled: item.enabled } : {}),
    };
  });
  return { name: input.name.trim(), mode: input.mode, controls };
}

/** Only fixed-group controls with stable IDs can be a portable preset. */
export function capturePreset({ name, mode, entries, editing = false }) {
  const skipped = [];
  const controls = entries.flatMap((entry) => {
    if (entry.group !== GROUP.base) return [];
    if (!identity(entry.wire.id) || !isKnownKind(entry.wire.kind)) {
      skipped.push(entry.wire.label);
      return [];
    }
    const options = new Map(optionEntries(entry.wire).map((o) => [o.key, o]));
    return [
      {
        id: entry.wire.id,
        kind: entry.wire.kind,
        value: entry.wire.value,
        custom: (entry.custom ?? []).flatMap((key) =>
          options.has(key) ? [{ key, label: options.get(key).label }] : [],
        ),
        ...(editing || typeof entry.applyToEdit === 'boolean'
          ? { applyToEdit: editing ? appliesToEdit(entry) : entry.applyToEdit }
          : {}),
        enabled:
          typeof entry.enabled === 'boolean'
            ? entry.enabled
            : entry.wire.apply_to_generation !== false,
      },
    ];
  });
  return { preset: normalizePreset({ name, mode, controls }), skipped };
}

/**
 * Apply to the caller's current entries, never to a draft or saved record.
 * Unknown/missing controls and unavailable choices are reported, not guessed.
 */
export function applyPreset(input, { mode, entries, editing = false }) {
  const preset = normalizePreset(input);
  if (preset.mode !== mode)
    return { entries, applied: 0, skipped: [], reason: 'mode' };
  const remaining = new Map(preset.controls.map((c) => [c.id, c]));
  const skipped = [];
  let applied = 0;
  const next = entries.map((entry) => {
    if (entry.group !== GROUP.base) return entry;
    const saved = remaining.get(entry.wire.id);
    if (!saved) return entry;
    remaining.delete(saved.id);
    const { kind } = entry.wire;
    if (
      kind !== saved.kind &&
      !(isChoiceKind(kind) && isChoiceKind(saved.kind))
    ) {
      skipped.push({ id: saved.id, reason: 'kind' });
      return entry;
    }
    let value = cloneJson(saved.value);
    if (isMultiChoice(kind) && isSingleChoice(saved.kind))
      value = value === null ? [] : [value];
    if (isSingleChoice(kind) && isMultiChoice(saved.kind)) {
      if (value.length > 1) {
        skipped.push({ id: saved.id, reason: 'kind' });
        return entry;
      }
      value = value[0] ?? null;
    }
    const options = { ...entry.wire.options };
    const custom = [...(entry.custom ?? [])];
    for (const option of saved.custom) {
      if (!Object.hasOwn(options, option.key)) {
        Object.defineProperty(options, option.key, {
          value: option.label,
          enumerable: true,
          writable: true,
          configurable: true,
        });
        custom.push(option.key);
      } else if (
        optionEntries({ options }).find((o) => o.key === option.key)?.label !==
        option.label
      ) {
        skipped.push({ id: saved.id, reason: 'custom-conflict' });
        return entry;
      }
    }
    const wire = { ...entry.wire, value };
    if (isChoiceKind(kind)) {
      wire.options = options;
      if (
        selectedOptionKeys(wire).some((key) => !Object.hasOwn(options, key))
      ) {
        skipped.push({ id: saved.id, reason: 'choice' });
        return entry;
      }
    }
    if (validateWire(wire)) {
      skipped.push({ id: saved.id, reason: 'value' });
      return entry;
    }
    applied += 1;
    const updated = {
      ...entry,
      wire,
      custom,
      explicit: true,
      enabled: saved.enabled ?? true,
      applyToEdit:
        saved.applyToEdit ?? (editing ? (saved.enabled ?? true) : true),
    };
    return JSON.stringify(updated) === JSON.stringify(entry) ? entry : updated;
  });
  for (const id of remaining.keys()) skipped.push({ id, reason: 'missing' });
  return {
    entries: next.every((entry, index) => entry === entries[index])
      ? entries
      : next,
    applied,
    skipped,
  };
}
