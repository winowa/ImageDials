/**
 * Pure rules for image references attached to a Create draft: capability
 * reading, file checks, ordered descriptors, the multipart edit request and
 * which controls apply to an edit. Files and object URLs stay in memory; only
 * descriptors (id, sha256, description, role) ever enter a request body.
 */
import { cloneJson, GROUP, isEnabled, TEXT_FLAG } from './controls.js';

const BYTES_PER_MIB = 1024 * 1024;
const FILE_NAME_MAX_CHARS = 80;
/** Types the editing contract accepts when the server lists none. */
export const REFERENCE_TYPES = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/webp',
]);
/** The only transport this client implements. */
export const EDIT_TRANSPORT = 'multipart-generation-v1';
export const ROLE_BASE = 'base';
export const ROLE_REFERENCE = 'reference';
/** Descriptor ids of references taken from a saved image. */
const SAVED_PREFIX = 'image:';

/** Give saved bytes a usable file name/type when a storage response omits MIME. */
export function savedReferenceFile(blob, record, fallbackName = 'image.png') {
  const name = record.filename || fallbackName;
  const inferred = /\.jpe?g$/i.test(name)
    ? 'image/jpeg'
    : /\.webp$/i.test(name)
      ? 'image/webp'
      : 'image/png';
  return new File([blob], name, {
    type: REFERENCE_TYPES.includes(record.content_type)
      ? record.content_type
      : REFERENCE_TYPES.includes(blob.type)
        ? blob.type
        : inferred,
  });
}

export const REF_STATUS = {
  /** Bytes are present and being hashed or described. */
  reading: 'reading',
  /** Bytes and hash are present; the description may still be missing. */
  ready: 'ready',
  /** Restored from a saved edit; the bytes are being looked up. */
  resolving: 'resolving',
  /** Restored from a saved edit; the exact bytes must be attached again. */
  missing: 'missing',
  /** The file could not be read or hashed. */
  error: 'error',
};

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const mib = (bytes) => `${Math.round((bytes / BYTES_PER_MIB) * 10) / 10} MiB`;
export const shortName = (name) =>
  String(name || 'image').slice(0, FILE_NAME_MAX_CHARS);

/**
 * One `image_editing` object as the client uses it, or null when absent. A
 * server without it (older servers) is unsupported; an unknown transport is
 * unsupported too, never guessed. The limit is the selected model's; older
 * servers that publish no model still have their stated limit honored.
 */
export function editingFrom(raw) {
  if (!isObject(raw)) return null;
  const count =
    Number.isInteger(raw.max_references) && raw.max_references > 0
      ? raw.max_references
      : 0;
  const prompting = isObject(raw.prompting) ? raw.prompting : null;
  return {
    enabled:
      raw.enabled === true && raw.transport === EDIT_TRANSPORT && count > 0,
    maxReferences: count,
    model:
      typeof raw.model === 'string' && raw.model
        ? raw.model
        : typeof prompting?.model === 'string'
          ? prompting.model
          : null,
    modelMaxReferences: Number.isInteger(raw.model_max_references)
      ? raw.model_max_references
      : null,
    limitSource: raw.limit_source === 'configured' ? 'configured' : 'model',
    maxImageBytes: Number.isFinite(raw.max_image_bytes)
      ? raw.max_image_bytes
      : 0,
    maxTotalBytes: Number.isFinite(raw.max_total_bytes)
      ? raw.max_total_bytes
      : 0,
    geometry: raw.geometry ?? null,
    prompting,
  };
}

/** The server-default editing capability from `/api/app-capabilities`. */
export const editingCapability = (capabilities) =>
  editingFrom(capabilities?.image_editing);

/** Editing is unknown while the selected provider's facts are being read. */
export const EDIT_CHECKING = 'Checking the selected image model…';
/** The selected provider's facts could not be read. */
export const EDIT_UNKNOWN =
  'The selected image model could not be checked. Reload model details to edit.';

/**
 * The capability of the provider that will actually run this browser's
 * requests. `/api/models` is read with the provider settings header, so its
 * `image_editing` wins. Until it is read (or on an older server without it),
 * the server-default capability applies only when no provider override is
 * active; with one, editing waits rather than borrowing another provider's
 * limit.
 */
export function selectedEditingCapability(discovery, overridden = false) {
  const models = discovery?.models;
  if (models?.status === 'ready' && isObject(models.data?.image_editing))
    return editingFrom(models.data.image_editing);
  const fallback = editingCapability(discovery?.capabilities?.data);
  // The default applies without an override, or on an older server whose
  // model facts carry no editing object at all.
  if (!overridden || models?.status === 'ready' || !fallback) return fallback;
  const checking = models?.status === 'loading';
  return { ...fallback, enabled: false, checking, unknown: !checking };
}

/** Why `refs` exceed the selected model's limit, or null. Nothing is removed. */
export function overLimitReason(refs, capability) {
  const max = capability?.maxReferences ?? 0;
  if (!capability?.enabled || refs.length <= max) return null;
  const extra = refs.length - max;
  const who = capability.model ?? 'The selected image model';
  return `${who} accepts up to ${max} reference${max === 1 ? '' : 's'} here. Remove ${extra} to edit.`;
}

/**
 * Why `file` cannot be attached, or null. Analysis shares the import upload
 * limit, so the smaller of the two applies to each file.
 */
export function checkReferenceFile(file, capability, held, uploads) {
  if (!capability?.enabled) return 'Image editing is unavailable.';
  const name = shortName(file?.name);
  if (held.length >= capability.maxReferences)
    return capability.model
      ? `${capability.model} accepts up to ${capability.maxReferences} reference${capability.maxReferences === 1 ? '' : 's'} here.`
      : `At most ${capability.maxReferences} references can be attached.`;
  if (!file?.size) return `${name} is empty.`;
  const listed = uploads?.image_mime_types;
  const types = Array.isArray(listed) && listed.length ? listed : null;
  const allowed = REFERENCE_TYPES.filter((t) => !types || types.includes(t));
  if (!allowed.includes(file.type))
    return `${name} is not a PNG, JPEG or WebP image.`;
  const limits = [capability.maxImageBytes, uploads?.import_max_bytes].filter(
    (n) => Number.isFinite(n) && n > 0,
  );
  const limit = limits.length ? Math.min(...limits) : 0;
  if (!limit) return 'The upload limits have not been read from the server.';
  if (file.size > limit)
    return `${name} is ${mib(file.size)}; the limit is ${mib(limit)}.`;
  const total = held.reduce((sum, ref) => sum + (ref.size ?? 0), file.size);
  if (capability.maxTotalBytes && total > capability.maxTotalBytes)
    return `References may total ${mib(capability.maxTotalBytes)}; this would be ${mib(total)}.`;
  return null;
}

/** Role by position: the first reference is the base canvas. */
export const roleAt = (index, ref) =>
  ref?.role && ref.role !== ROLE_BASE && ref.role !== ROLE_REFERENCE
    ? ref.role
    : index === 0
      ? ROLE_BASE
      : ROLE_REFERENCE;

/** Ordered id/description/role context, as dynamic controls and analysis take it. */
export const referenceContext = (refs) =>
  refs.map((ref, index) => ({
    id: ref.id,
    description: ref.description ?? '',
    role: roleAt(index, ref),
  }));

/**
 * Identity of the ordered reference set for currentness checks: ids, order,
 * hashes, roles and descriptions. Empty for a text-only draft.
 */
export const referenceSignature = (refs) =>
  refs.length ? JSON.stringify(referenceDescriptors(refs)) : '';

/** Ordered descriptors bound to the original uploaded bytes. */
export const referenceDescriptors = (refs) =>
  refs.map((ref, index) => ({
    id: ref.id,
    sha256: ref.sha256,
    ...(ref.source ? { source: ref.source } : {}),
    description: ref.description ?? '',
    role: roleAt(index, ref),
  }));

/** Every reference has its exact bytes and hash. */
export const referencesReady = (refs) =>
  refs.every(
    (ref) => ref.status === REF_STATUS.ready && ref.blob && ref.sha256,
  );

/** Generation modes offered on Create: text to image, edit, asset image. */
export const DRAFT_KIND = Object.freeze({
  text: 'text',
  edit: 'edit',
  asset: 'asset',
});

/**
 * The draft's generation mode. Edit is the explicit `draft.edit` choice; held
 * references always mean an edit, so a text or asset draft never has any.
 */
export const draftKind = (draft, refs = []) =>
  draft?.edit || refs.length
    ? DRAFT_KIND.edit
    : draft?.mode === 'asset-image'
      ? DRAFT_KIND.asset
      : DRAFT_KIND.text;

export const EDIT_UNAVAILABLE =
  'This server cannot edit images. Choose Text to image to generate from text.';
export const EDIT_NEEDS_REFERENCE = 'Add the image to edit.';

/**
 * Why an edit cannot be submitted, or null. An edit without a reference is
 * blocked; it never falls back to text-to-image generation.
 */
export function editBlockReason(edit, refs, capability) {
  if (!edit && !refs.length) return null;
  if (capability?.checking) return EDIT_CHECKING;
  if (capability?.unknown) return EDIT_UNKNOWN;
  if (!capability?.enabled) return EDIT_UNAVAILABLE;
  if (!refs.length) return EDIT_NEEDS_REFERENCE;
  return referenceBlockReason(refs, capability);
}

/**
 * Why references block a submission, or null. Missing sources are never
 * approximated by text-only generation.
 */
export function referenceBlockReason(refs, capability) {
  if (!refs.length) return null;
  if (capability?.checking) return EDIT_CHECKING;
  if (capability?.unknown) return EDIT_UNKNOWN;
  if (!capability?.enabled) return EDIT_UNAVAILABLE;
  const over = overLimitReason(refs, capability);
  if (over) return over;
  const missing = refs.findIndex(
    (ref) =>
      ref.status === REF_STATUS.missing || ref.status === REF_STATUS.error,
  );
  if (missing >= 0) return `Attach reference ${missing + 1} again to edit.`;
  if (refs.some((ref) => ref.status === REF_STATUS.resolving))
    return 'Finding reference images…';
  if (
    refs.some(
      (ref) =>
        ref.status === REF_STATUS.reading || ref.converting || !ref.sha256,
    )
  )
    return 'Reading reference…';
  return null;
}

/**
 * Whether a control is part of the edit. An explicit setting wins; otherwise
 * only a value a person chose applies, so random or default standard values
 * never restyle the source.
 */
export const appliesToEdit = (entry) =>
  typeof entry.applyToEdit === 'boolean'
    ? entry.applyToEdit
    : entry.explicit === true;

/** A wire without either application flag; the entry's state decides them. */
const withoutFlags = (wire) => {
  if (!Object.hasOwn(wire, 'apply_to_edit') && !Object.hasOwn(wire, TEXT_FLAG))
    return cloneJson(wire);
  const { apply_to_edit: _edit, [TEXT_FLAG]: _text, ...rest } = wire;
  return cloneJson(rest);
};

/**
 * Text-only wires: the edit-only flag is never sent. A control left to the
 * model keeps its value and says so; an enabled one carries no flag, so
 * ordinary requests are unchanged.
 */
export const serializeTextEntries = (entries) =>
  entries.map((entry) =>
    isEnabled(entry)
      ? withoutFlags(entry.wire)
      : { ...withoutFlags(entry.wire), [TEXT_FLAG]: false },
  );

/**
 * Edit wires: every control keeps its values and states whether it applies.
 * Apply to edit alone decides; the text flag is not sent with an edit.
 */
export const serializeEditEntries = (entries) =>
  entries.map((entry) => ({
    ...withoutFlags(entry.wire),
    apply_to_edit: appliesToEdit(entry),
  }));

/** Restored edit records: an omitted flag means the control applied. */
export const withRecordedEdit = (entries) =>
  entries.map((entry) =>
    typeof entry.wire.apply_to_edit === 'boolean'
      ? { ...entry, applyToEdit: entry.wire.apply_to_edit }
      : { ...entry, applyToEdit: true },
  );

/** Counts for the edit summary. */
export function editSummary(entries) {
  const applied = entries.filter(appliesToEdit);
  return {
    applied: applied.length,
    kept: entries.length - applied.length,
    standardApplied: applied.filter((e) => e.group === GROUP.base).length,
  };
}

/**
 * The multipart generation request: the JSON body as `request`, then the
 * original files as `reference_1`…`reference_n` in descriptor order. The
 * browser sets the multipart Content-Type and boundary.
 */
export function buildEditForm(body, files) {
  const form = new FormData();
  form.append('request', JSON.stringify(body));
  files.forEach((file, index) => {
    form.append(`reference_${index + 1}`, file.blob, file.name || 'image');
  });
  return form;
}

/** A saved edit's reference provenance, or an empty list. */
export function recordReferences(record) {
  if (record?.generation_type !== 'image-edit') return [];
  const list = record.reference_images;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (item) =>
      isObject(item) &&
      typeof item.id === 'string' &&
      typeof item.sha256 === 'string',
  );
}

/** Descriptor id for a saved image used as a reference. */
export const savedReferenceId = (record) =>
  `${SAVED_PREFIX}${record.image_id ?? record.id}`.slice(0, 128);

/** The saved image identity a descriptor id names, or null. */
export const savedIdentityOf = (id) =>
  typeof id === 'string' && id.startsWith(SAVED_PREFIX)
    ? id.slice(SAVED_PREFIX.length) || null
    : null;

/** The first reference sets the edit's canvas. */
export const baseDimensions = (refs) => {
  const size = refs[0]?.dimensions;
  return size?.width > 0 && size?.height > 0 ? size : null;
};
