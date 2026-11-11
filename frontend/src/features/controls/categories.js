const TYPES = new Set([
  'single',
  'multi',
  'range',
  'select',
  'radio',
  'checkbox',
  'text',
  'binary',
]);
const LISTED = new Set(['multi', 'checkbox']);
const OPTIONLESS = new Set(['range', 'text', 'binary']);

/** Cleared value for a category type. */
export function emptyValue(category) {
  if (LISTED.has(category.type)) return [];
  if (category.type === 'range') return category.min;
  if (category.type === 'text') return '';
  if (category.type === 'binary') return false;
  return null;
}

const opts = (labels) =>
  labels.map((label) => ({
    id: label.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    label,
  }));

const fixed = (id, label, description, type, labels) => ({
  id,
  label,
  description,
  type,
  origin: 'fixed',
  options: opts(labels),
  value: emptyValue({ type }),
});

export function fixedCategories(mode) {
  if (mode === 'asset-image') {
    return [
      fixed('material', 'Material', 'Primary surface material', 'single', [
        'Wood',
        'Metal',
        'Ceramic',
        'Fabric',
        'Glass',
        'Stone',
      ]),
      fixed('finish', 'Finish', 'Surface treatment', 'single', [
        'Matte',
        'Glossy',
        'Brushed',
        'Weathered',
        'Polished',
      ]),
      fixed('form', 'Form', 'Overall silhouette', 'single', [
        'Compact',
        'Slender',
        'Angular',
        'Rounded',
        'Ornate',
      ]),
      fixed('view', 'View', 'Camera angle on the asset', 'select', [
        'Front',
        'Three-quarter',
        'Side',
        'Top',
        'Isometric',
      ]),
    ];
  }
  return [
    fixed('style', 'Style', 'Rendering approach', 'single', [
      'Photographic',
      'Illustration',
      'Watercolor',
      'Cinematic',
      'Vector',
      'Oil painting',
    ]),
    fixed('color', 'Color', 'Palette emphasis', 'multi', [
      'Warm',
      'Cool',
      'Monochrome',
      'Vivid',
      'Muted earth',
      'Pastel',
    ]),
    fixed('lighting', 'Lighting', 'Light quality and direction', 'select', [
      'Soft daylight',
      'Golden hour',
      'Studio',
      'Dramatic',
      'Moonlit',
      'Neon',
    ]),
    fixed('composition', 'Composition', 'Framing and viewpoint', 'single', [
      'Close-up',
      'Wide shot',
      'Centered',
      'Rule of thirds',
      'Overhead',
      'Low angle',
    ]),
  ];
}

export function normalizeValue(category, value) {
  const ids = new Set((category.options ?? []).map((o) => o.id));
  switch (category.type) {
    case 'multi':
    case 'checkbox':
      return Array.isArray(value) ? value.filter((v) => ids.has(v)) : [];
    case 'text':
      return typeof value === 'string' ? value : '';
    case 'binary':
      return value === true;
    case 'range': {
      const n = Number(value);
      const base = Number.isFinite(n) ? n : category.min;
      return Math.min(category.max, Math.max(category.min, base));
    }
    default:
      return typeof value === 'string' && ids.has(value) ? value : null;
  }
}

/** Validate provider output; throws a recoverable Error on malformed data. */
export function validateCategories(list) {
  if (!Array.isArray(list)) throw new Error('Controls response was malformed.');
  const seen = new Set();
  return list.map((raw) => {
    if (
      !raw ||
      typeof raw.id !== 'string' ||
      !raw.id ||
      typeof raw.label !== 'string' ||
      !TYPES.has(raw.type) ||
      seen.has(raw.id)
    )
      throw new Error('Controls response was malformed.');
    seen.add(raw.id);
    const category = {
      id: raw.id,
      label: raw.label,
      description: typeof raw.description === 'string' ? raw.description : '',
      type: raw.type,
      origin: raw.origin === 'fixed' ? 'fixed' : 'generated',
    };
    if (raw.type === 'range') {
      const [min, max] = [Number(raw.min), Number(raw.max)];
      const step = Number(raw.step ?? 1);
      if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min)
        throw new Error('Controls response was malformed.');
      Object.assign(category, {
        min,
        max,
        step: step > 0 ? step : 1,
        options: [],
      });
    } else if (OPTIONLESS.has(raw.type)) {
      category.options = [];
      for (const key of ['placeholder', 'true_label', 'false_label'])
        if (typeof raw[key] === 'string' && raw[key]) category[key] = raw[key];
    } else {
      if (
        !Array.isArray(raw.options) ||
        raw.options.some((o) => typeof o?.id !== 'string' || !o.label)
      )
        throw new Error('Controls response was malformed.');
      category.options = raw.options.map((o) => ({
        id: o.id,
        label: String(o.label),
      }));
    }
    category.value = normalizeValue(category, raw.value);
    return category;
  });
}

/**
 * Merge a fresh provider category list into the current one. Selections are
 * kept wherever they remain valid; local fixed categories the provider omitted
 * stay available; custom options the user added are carried over.
 */
export function mergeCategories(prev, next) {
  const before = new Map(prev.map((c) => [c.id, c]));
  const merged = next.map((category) => {
    const old = before.get(category.id);
    if (!old || old.type !== category.type) return category;
    if (category.type === 'range') {
      return {
        ...category,
        value: normalizeValue(category, old.value ?? category.value),
      };
    }
    if (category.type === 'text' || category.type === 'binary') {
      const ok =
        typeof old.value === (category.type === 'text' ? 'string' : 'boolean');
      return ok ? { ...category, value: old.value } : category;
    }
    const have = new Set(category.options.map((o) => o.id));
    const custom = old.options.filter(
      (o) => o.id.startsWith('custom:') && !have.has(o.id),
    );
    const grown = { ...category, options: [...category.options, ...custom] };
    const keep = normalizeValue(grown, old.value);
    const empty = Array.isArray(keep) ? keep.length === 0 : keep === null;
    return { ...grown, value: empty ? grown.value : keep };
  });
  const ids = new Set(merged.map((c) => c.id));
  const leftovers = prev.filter((c) => c.origin === 'fixed' && !ids.has(c.id));
  return [...merged, ...leftovers];
}

export function describeValue(category) {
  const label = (id) => category.options.find((o) => o.id === id)?.label ?? id;
  const { type, value } = category;
  if (LISTED.has(type))
    return value?.length ? value.map(label).join(', ') : null;
  if (type === 'range') return String(value);
  if (type === 'text')
    return typeof value === 'string' && value.trim() ? value : null;
  if (type === 'binary') {
    if (typeof value !== 'boolean') return null;
    return value
      ? (category.true_label ?? 'Yes')
      : (category.false_label ?? 'No');
  }
  return value ? label(value) : null;
}

export function resetCategory(category) {
  return { ...category, value: emptyValue(category) };
}
