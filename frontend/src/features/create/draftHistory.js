/**
 * Whole-draft undo and redo for Create.
 *
 * The history holds snapshots of draft state, not commands: undo puts back
 * the snapshot taken before a transaction and keeps the state it replaced for
 * redo. Snapshots share the draft's immutable values (prompt, control entry
 * objects, metadata) and describe references by id and checksum only, so no
 * entry copies image bytes; the reference owner finds bytes again on restore.
 *
 * Only a person's own transactions are recorded. Work that follows one by
 * itself (controls generated for a new idea, the one standard draw, a
 * reference's prompt proposal) changes the current state without an entry,
 * so undoing the transaction undoes its consequences too.
 */

/** Undo steps kept; the oldest is dropped beyond this. */
export const DRAFT_HISTORY_LIMIT = 100;
/** Edits with the same coalescing key this close together form one step. */
export const DRAFT_COALESCE_MS = 1000;

const sameList = (a = [], b = []) =>
  a === b || (a.length === b.length && a.every((item, i) => item === b[i]));

const sameRefs = (a = [], b = []) =>
  a.length === b.length &&
  a.every(
    (ref, i) =>
      ref.id === b[i].id &&
      ref.sha256 === b[i].sha256 &&
      ref.description === b[i].description &&
      ref.filename === b[i].filename &&
      ref.role === b[i].role &&
      ref.dimensions === b[i].dimensions,
  );

/**
 * Whether two snapshots describe the same draft. Entry objects and metadata
 * are compared by identity: every edit replaces the object it changes.
 */
export function sameSnapshot(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const da = a.draft;
  const db = b.draft;
  return (
    da.prompt === db.prompt &&
    da.mode === db.mode &&
    Boolean(da.edit) === Boolean(db.edit) &&
    da.aspect === db.aspect &&
    sameList(da.mustHaveTerms, db.mustHaveTerms) &&
    sameList(a.entries, b.entries) &&
    sameList(a.additionalMetadata, b.additionalMetadata) &&
    a.regionEdit === b.regionEdit &&
    sameRefs(a.refs, b.refs) &&
    (a.parked ?? null) === (b.parked ?? null) &&
    (a.dynamic?.anchor ?? null) === (b.dynamic?.anchor ?? null) &&
    (a.dynamic?.refs ?? '') === (b.dynamic?.refs ?? '') &&
    a.dynamic?.provider === b.dynamic?.provider &&
    a.episode?.suppressed === b.episode?.suppressed &&
    (a.dynamic?.metadata ?? null) === (b.dynamic?.metadata ?? null) &&
    a.episode?.anchor === b.episode?.anchor &&
    a.episode?.pending === b.episode?.pending &&
    a.episode?.keepChoices === b.episode?.keepChoices &&
    (a.derivedPrompt ?? null) === (b.derivedPrompt ?? null) &&
    a.proposal === b.proposal &&
    a.basedOn === b.basedOn
  );
}

/**
 * A bounded undo/redo stack of snapshots.
 *
 * @param {{limit?: number, coalesceMs?: number, now?: () => number,
 *   equals?: (a: object, b: object) => boolean}} [options]
 */
export function createDraftHistory({
  limit = DRAFT_HISTORY_LIMIT,
  coalesceMs = DRAFT_COALESCE_MS,
  now = Date.now,
  equals = sameSnapshot,
} = {}) {
  let undoStack = [];
  let redoStack = [];
  // The open coalescing group: its key and the time of its latest edit.
  let open = null;

  const trim = () => {
    if (undoStack.length > limit) undoStack = undoStack.slice(-limit);
  };

  return {
    /**
     * Record the state before a transaction. With `coalesce`, an edit with
     * the same key within `coalesceMs` of the previous one joins that step.
     * Any record clears redo.
     * @returns {boolean} whether a new step was added
     */
    record(before, { label, coalesce = null } = {}) {
      const at = now();
      redoStack = [];
      if (
        coalesce &&
        open?.key === coalesce &&
        at - open.at <= coalesceMs &&
        undoStack.length
      ) {
        open.at = at;
        return false;
      }
      undoStack.push({ snapshot: before, label: label ?? 'Edit' });
      trim();
      open = coalesce ? { key: coalesce, at } : null;
      return true;
    },

    /** Close the open coalescing group: the next edit starts a new step. */
    seal() {
      open = null;
    },

    /**
     * Step back from `current`. Steps that would change nothing (an edit that
     * set a value it already had) are skipped.
     * @returns {{snapshot: object, label: string}|null}
     */
    undo(current) {
      open = null;
      while (undoStack.length) {
        const step = undoStack.pop();
        if (equals(step.snapshot, current)) continue;
        redoStack.push({ snapshot: current, label: step.label });
        return step;
      }
      return null;
    },

    /** Step forward again from `current`. */
    redo(current) {
      open = null;
      while (redoStack.length) {
        const step = redoStack.pop();
        if (equals(step.snapshot, current)) continue;
        undoStack.push({ snapshot: current, label: step.label });
        trim();
        return step;
      }
      return null;
    },

    clear() {
      undoStack = [];
      redoStack = [];
      open = null;
    },

    /** What the controls show: availability and the step each would take. */
    state() {
      return {
        canUndo: undoStack.length > 0,
        canRedo: redoStack.length > 0,
        undoLabel: undoStack.at(-1)?.label ?? null,
        redoLabel: redoStack.at(-1)?.label ?? null,
        size: undoStack.length + redoStack.length,
      };
    },
  };
}

/**
 * Generated-control state as a snapshot keeps it: a request still loading or
 * failed is not restorable, so the snapshot keeps what was settled.
 */
export function settledDynamic(dynamic) {
  if (!dynamic || dynamic.status === 'ready' || dynamic.status === 'idle')
    return dynamic;
  return {
    ...dynamic,
    status: dynamic.anchor ? 'ready' : 'idle',
    error: null,
  };
}

/** A reference as a snapshot keeps it: identity and description, no bytes. */
export const referenceSnapshot = (ref) => ({
  id: ref.id,
  sha256: ref.sha256 ?? null,
  filename: ref.name ?? null,
  description: typeof ref.description === 'string' ? ref.description : '',
  role: typeof ref.role === 'string' ? ref.role : undefined,
  dimensions: ref.dimensions ?? null,
  ...(ref.source ? { source: ref.source } : {}),
});

/** Platform shortcut text for the Undo and Redo actions. */
export function shortcutLabels(platform = globalThis.navigator) {
  const name = platform?.userAgentData?.platform ?? platform?.platform ?? '';
  const apple = /mac|iphone|ipad|ipod/i.test(name);
  return apple
    ? { undo: '⌘Z', redo: '⇧⌘Z', apple: true }
    : { undo: 'Ctrl+Z', redo: 'Ctrl+Y', apple: false };
}

/**
 * Which history action a key press asks for, or null. Native text undo wins
 * inside editable fields, and an open modal dialog keeps its own keys.
 */
export function historyShortcut(event, { apple = false } = {}) {
  if (event.defaultPrevented || event.isComposing || event.altKey) return null;
  const primary = apple
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
  if (!primary) return null;
  const key = event.key?.toLowerCase();
  let action = null;
  if (key === 'z') action = event.shiftKey ? 'redo' : 'undo';
  else if (key === 'y' && !apple && !event.shiftKey) action = 'redo';
  if (!action) return null;
  if (editableTarget(event.target)) return null;
  if (event.target?.closest?.('[aria-modal="true"], [role="dialog"]'))
    return null;
  return action;
}

const TEXT_INPUTS = new Set([
  'text',
  'search',
  'email',
  'url',
  'tel',
  'password',
  'number',
  'date',
  'datetime-local',
  'month',
  'time',
  'week',
]);

/** Whether a node keeps its own text undo. */
export function editableTarget(node) {
  if (!node || node.nodeType !== 1) return false;
  if (node.isContentEditable) return true;
  const tag = node.tagName;
  if (tag === 'TEXTAREA') return !node.readOnly && !node.disabled;
  if (tag === 'INPUT')
    return (
      TEXT_INPUTS.has((node.type || 'text').toLowerCase()) &&
      !node.readOnly &&
      !node.disabled
    );
  return false;
}
