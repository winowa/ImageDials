/**
 * Pure reconciliation of the generator's history strip.
 *
 * Three sources feed the strip: jobs this client accepted (the ledger), images
 * kept only in this browser (imports) and the authoritative stored list. A job
 * is identified by its temporary job id and, once saved, by its stored
 * identity; a library record need not carry the job id. The ledger remembers
 * the link so the strip keeps one item, one React key and one selection for a
 * job from acceptance to its saved image.
 *
 * Decisions beyond the supplied behavior:
 * - An item never merges through the previous result, the prompt or a title.
 *   Only the job id, or the stored identity the job itself reported, links a
 *   job to a stored record, so a stale snapshot of the image being regenerated
 *   cannot replace the pending item.
 * - A stored record is claimed by one job. A job id match beats a result
 *   identity match; among equals the earlier accepted job wins. A completed job
 *   that loses the claim stays as its own item from its own result.
 * - While a job is not terminal, a stored record carrying its job id is hidden
 *   instead of shown twice; the job's own status stays authoritative.
 * - A failed job stays failed (also after a preview). A stored record that
 *   carries its job id is listed beside it, because the failure may only have
 *   concerned later metadata.
 * - A completed job whose result is no longer listed is dropped: the stored
 *   list is the authority and a deleted image is not brought back.
 * - An imported item and a stored record with the same exact stored identity
 *   are one item at the imported item's position. The more complete record
 *   represents it; on a tie the one with local bytes does. Neither underlying
 *   origin is changed and nothing is deleted.
 */
import { imageKey } from '../../data/records/imageRecord.js';
import { PHASE } from '../../data/api/jobs.js';
import { cloneJson } from '../controls/controls.js';

/** Client key of the item for a job; stable for the item's whole life. */
export const jobKey = (jobId) => `job:${jobId}`;

/** Settled jobs kept to link identities; older ones fall back to the list. */
export const LEDGER_LIMIT = 40;

const EXCERPT_LENGTH = 60;
const PENDING = new Set([
  PHASE.accepted,
  PHASE.running,
  PHASE.preview,
  PHASE.lost,
]);
const SETTLED = new Set([PHASE.complete, PHASE.failed]);

export const emptyLedger = Object.freeze([]);

/** The ledger entry for an accepted job. `body` is the frozen request. */
export const acceptedEntry = ({ jobId, body, previous = null, seq }) =>
  Object.freeze({
    jobId,
    clientKey: jobKey(jobId),
    seq,
    body,
    previous,
    phase: PHASE.accepted,
    stage: null,
    preview: null,
    error: null,
    record: null,
  });

const hasEntry = (ledger, jobId) => ledger.some((e) => e.jobId === jobId);

const trim = (ledger) => {
  if (ledger.length <= LEDGER_LIMIT) return ledger;
  const settled = ledger.filter((e) => SETTLED.has(e.phase));
  const drop = new Set(
    settled.slice(0, ledger.length - LEDGER_LIMIT).map((e) => e.jobId),
  );
  return ledger.filter((e) => !drop.has(e.jobId));
};

/**
 * Ledger transitions. Idempotent: replays change nothing and return the same
 * array, and a settled job never reopens or changes its outcome.
 *  - accepted {jobId, body, previous}
 *  - observed {job}      the job reducer's state (progress, preview, outcome)
 *  - stored {jobId, record} the record a completed job produced
 *  - dismiss {jobId}     a failed item the person removed
 */
export function ledgerReducer(ledger, action) {
  switch (action.type) {
    case 'accepted': {
      if (!action.jobId || hasEntry(ledger, action.jobId)) return ledger;
      const seq = ledger.reduce((max, e) => Math.max(max, e.seq), 0) + 1;
      return trim([...ledger, acceptedEntry({ ...action, seq })]);
    }
    case 'observed': {
      const { job } = action;
      const entry = ledger.find((e) => e.jobId === job?.id);
      // Completion arrives with its record through `stored`, so the item
      // never sits between pending and saved.
      if (!entry || SETTLED.has(entry.phase) || job.phase === PHASE.complete)
        return ledger;
      const next = {
        ...entry,
        phase: job.phase,
        stage: job.stage ?? entry.stage,
        preview: job.preview?.image_url ? job.preview : entry.preview,
        error: job.phase === PHASE.failed ? job.error : null,
      };
      const same = ['phase', 'stage', 'preview', 'error'].every(
        (k) => next[k] === entry[k],
      );
      return same
        ? ledger
        : ledger.map((e) => (e === entry ? Object.freeze(next) : e));
    }
    case 'stored': {
      const entry = ledger.find((e) => e.jobId === action.jobId);
      if (!entry || entry.phase === PHASE.failed || entry.record) return ledger;
      const next = Object.freeze({
        ...entry,
        phase: PHASE.complete,
        record: action.record,
        error: null,
      });
      return ledger.map((e) => (e === entry ? next : e));
    }
    case 'dismiss': {
      const entry = ledger.find((e) => e.jobId === action.jobId);
      return entry && entry.phase === PHASE.failed
        ? ledger.filter((e) => e !== entry)
        : ledger;
    }
    default:
      return ledger;
  }
}

const excerpt = (text) => {
  const clean = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > EXCERPT_LENGTH
    ? `${clean.slice(0, EXCERPT_LENGTH - 1)}…`
    : clean;
};

const pendingViews = new WeakMap();

/**
 * The provisional item of a job that has no saved image: a client-only record
 * carrying the frozen submitted request (original wire controls, provenance,
 * mode, requested size) so choosing it restores exactly what was sent. It has
 * no storage identity, is never listed in the library or cached as a server
 * record, and `client_pending` marks it so nothing shared is ever called for
 * it.
 */
export function pendingRecord(entry) {
  let record = pendingViews.get(entry);
  if (record) return record;
  const { body } = entry;
  record = Object.freeze({
    id: entry.clientKey,
    client_key: entry.clientKey,
    generation_job_id: entry.jobId,
    title: excerpt(body.prompt) || 'Untitled',
    original_prompt: body.prompt,
    prompt: body.prompt,
    selected_controls: body.controls,
    dynamic_controls_metadata: body.dynamic_controls_metadata ?? null,
    additional_controls_metadata: body.additional_controls_metadata ?? [],
    must_have_terms: Object.freeze(cloneJson(body.must_have_terms ?? [])),
    generation_mode: body.generation_mode,
    requested_dimensions: body.dimensions,
    client_pending: Object.freeze({
      jobId: entry.jobId,
      phase: entry.phase,
      stage: entry.stage,
      error: entry.error,
      preview: entry.preview,
      previous: entry.previous,
    }),
  });
  pendingViews.set(entry, record);
  return record;
}

/** A pending or failed item (not yet, or never, a saved image). */
export const isPendingItem = (item) => Boolean(item?.client_pending);

/** Whether a client-pending item can be dismissed (a failed job only). */
export const isDismissable = (item) =>
  item?.client_pending?.phase === PHASE.failed;

const present = (value) =>
  value !== null &&
  value !== undefined &&
  value !== '' &&
  !(Array.isArray(value) && !value.length);

const COMPLETENESS_FIELDS = [
  'title',
  'alt_text',
  'original_prompt',
  'final_prompt',
  'selected_controls',
  'dynamic_controls_metadata',
  'additional_controls_metadata',
  'composition',
  'created_at',
  'model',
  'provider',
  'generation_mode',
  'requested_dimensions',
];

/** How much of a snapshot a record holds; sizes count once. */
export const completeness = (record) =>
  COMPLETENESS_FIELDS.filter((key) => present(record[key])).length +
  (record.width && record.height ? 1 : 0) +
  (present(record.dimensions) ? 1 : 0);

const hasStorage = (r) => Boolean(r.storage_id && r.filename);

/**
 * Whether two records are the same stored image: equal image id, equal
 * storage location, or equal id. A conflicting stronger identity (both have a
 * different image id or storage location) keeps them distinct even when a
 * weaker one overlaps. Prompt and title never count.
 */
export function sameStoredIdentity(a, b) {
  if (a.image_id && b.image_id && a.image_id !== b.image_id) return false;
  if (hasStorage(a) && hasStorage(b) && imageKey(a) !== imageKey(b))
    return false;
  if (a.image_id && b.image_id) return true;
  if (hasStorage(a) && hasStorage(b)) return true;
  return Boolean(a.id) && a.id === b.id;
}

/** Imported items that duplicate a stored record, resolved to one item. */
function dedupeImported(imported, shared) {
  const hidden = new Set();
  const aliases = new Map();
  const taken = new Set();
  const items = imported.map((local) => {
    const match = shared.find(
      (record) => !taken.has(record) && sameStoredIdentity(local, record),
    );
    if (!match) return local;
    taken.add(match);
    hidden.add(match);
    const winner = completeness(match) > completeness(local) ? match : local;
    const loser = winner === local ? match : local;
    aliases.set(winner, [imageKey(loser)]);
    return winner;
  });
  return { items, shared: shared.filter((r) => !hidden.has(r)), aliases };
}

const mergedViews = new WeakMap();

/** The stored record as the item of its job, filling only what it lacks. */
function mergeJob(entry, stored) {
  let byJob = mergedViews.get(stored);
  if (!byJob) {
    byJob = new Map();
    mergedViews.set(stored, byJob);
  }
  const cached = byJob.get(entry.jobId);
  if (cached && cached.entry === entry) return cached.merged;
  const fallback = entry.record ?? {};
  const fill = Object.fromEntries(
    Object.entries(fallback).filter(([key]) => !present(stored[key])),
  );
  const merged = Object.freeze({
    ...stored,
    ...fill,
    generation_job_id: stored.generation_job_id ?? entry.jobId,
    client_key: entry.clientKey,
  });
  byJob.set(entry.jobId, { entry, merged });
  return merged;
}

const storedIds = (record) => [record.id, record.image_id].filter(Boolean);

/** Strength of a link from a job to a stored record: 2 job id, 1 result. */
function linkStrength(entry, record) {
  if (record.generation_job_id === entry.jobId) return 2;
  const result = entry.record;
  if (!result) return 0;
  if (sameStoredIdentity(result, record)) return 1;
  return 0;
}

/**
 * Compose the strip. Returns the items newest first and, for each, the keys a
 * selection may use to refer to it (its stored key, its job key and the key of
 * a duplicate it replaced).
 *
 * @param {object} options
 * @param {readonly object[]} options.ledger accepted jobs, oldest first
 * @param {readonly object[]} options.stored authoritative stored records, in order
 * @param {readonly object[]} [options.imported] items kept only in this browser
 */
export function composeHistory({ ledger, stored, imported = [] }) {
  const aliases = new Map();
  let pool;
  if (imported.length) {
    const deduped = dedupeImported(imported, stored);
    deduped.aliases.forEach((keys, item) => aliases.set(item, keys));
    pool = [...deduped.items, ...deduped.shared];
  } else {
    pool = [...stored];
  }

  // Claim stored records: job id links first, then reported result identities.
  const claims = new Map();
  const claimed = new Set();
  for (const strength of [2, 1]) {
    for (const entry of ledger) {
      if (claims.has(entry.jobId)) continue;
      if (strength === 1 && entry.phase !== PHASE.complete) continue;
      const record = pool.find(
        (r) => !claimed.has(r) && linkStrength(entry, r) === strength,
      );
      if (record) {
        claims.set(entry.jobId, record);
        claimed.add(record);
      }
    }
  }

  const merged = new Map();
  const hidden = new Set();
  const front = [];
  const distinct = [];
  const newestFirst = [...ledger].sort((a, b) => b.seq - a.seq);
  for (const entry of newestFirst) {
    const record = claims.get(entry.jobId);
    if (PENDING.has(entry.phase)) {
      if (record) hidden.add(record);
      front.push(pendingRecord(entry));
    } else if (entry.phase === PHASE.failed) {
      front.push(pendingRecord(entry));
    } else if (record) {
      merged.set(record, mergeJob(entry, record));
    } else if (
      entry.record &&
      [...claimed].some(
        (r) =>
          sameStoredIdentity(entry.record, r) ||
          storedIds(r).some((id) => storedIds(entry.record).includes(id)),
      )
    ) {
      // Its stored identity overlaps one held by another job: remain distinct.
      distinct.push(mergeJob(entry, entry.record));
    }
  }

  const items = [
    ...front,
    ...distinct,
    ...pool.filter((r) => !hidden.has(r)).map((r) => merged.get(r) ?? r),
  ];
  const keys = new Map();
  for (const item of items) {
    const set = new Set([imageKey(item)]);
    if (item.client_key) set.add(item.client_key);
    (aliases.get(item) ?? []).forEach((k) => set.add(k));
    keys.set(item, set);
  }
  // A merged item answers to the keys of the record it replaced.
  merged.forEach((item, record) => {
    aliases.get(record)?.forEach((k) => keys.get(item)?.add(k));
  });
  return { items, keys };
}

/** The item a selection key refers to, or undefined. */
export const findSelected = (composed, key) =>
  key == null
    ? undefined
    : composed.items.find((item) => composed.keys.get(item)?.has(key));
