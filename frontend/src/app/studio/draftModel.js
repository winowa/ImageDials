import { DEFAULT_ASPECT, promptKey } from '../../features/create/submission.js';
import {
  DRAFT_KIND,
  referenceContext,
} from '../../features/references/references.js';
import {
  GROUP,
  descriptorSignature,
} from '../../features/controls/controls.js';

/** The server's own providers: no browser override. */
export const NO_PROVIDER = Object.freeze({ header: null, id: 'default' });
/**
 * A notice that describes the draft itself (a refused file or a submission it
 * blocked). Undo and redo replace the draft, so they clear only these.
 */
export const NOTICE_SCOPE = Object.freeze({ draft: 'draft' });

export const blankDraft = {
  prompt: '',
  mode: 'image',
  // Edit is an explicit choice, not a consequence of holding references.
  edit: false,
  aspect: DEFAULT_ASPECT,
  mustHaveTerms: [],
};
export const idleDynamic = {
  status: 'idle',
  anchor: null,
  metadata: null,
  error: null,
};
export const idleAdditional = { status: 'idle' };

/** Draft fields for a Text, Edit or Asset choice; Edit uses the image pipeline. */
export const kindFields = (kind) => ({
  mode: kind === DRAFT_KIND.asset ? 'asset-image' : 'image',
  edit: kind === DRAFT_KIND.edit,
});
export const KIND_VALUES = Object.values(DRAFT_KIND);

/**
 * Whether a draft still contains only its initial, unedited base controls.
 * `blank` is the fresh draft for the remembered mode and aspect.
 */
export const pristineDraft = (snapshot, blank = blankDraft) =>
  Boolean(
    snapshot &&
    !snapshot.draft.prompt.trim() &&
    snapshot.draft.mode === blank.mode &&
    Boolean(snapshot.draft.edit) === Boolean(blank.edit) &&
    !snapshot.parked &&
    snapshot.draft.aspect === blank.aspect &&
    !snapshot.draft.mustHaveTerms?.length &&
    !snapshot.refs?.length &&
    !snapshot.basedOn &&
    !(snapshot.entries ?? []).some(
      (entry) =>
        entry.group !== GROUP.base ||
        entry.explicit ||
        entry.applyToEdit !== undefined,
    ) &&
    !snapshot.additionalMetadata?.length,
  );

/** What a More controls answer is for: idea, mode, provider and descriptor set. */
export const additionalIdentityOf = (draft, providerId, entries, refs = '') =>
  JSON.stringify([
    promptKey(draft.prompt, draft.mode),
    providerId,
    descriptorSignature(entries),
    refs,
  ]);

/** Ordered reference context, added to a request only when references exist. */
export const withReferenceContext = (body, refs) =>
  refs.length ? { ...body, reference_context: referenceContext(refs) } : body;
/** Write the synchronous draft mirror outside render logic. */
export const writeRef = (ref, value) => {
  ref.current = value;
  return value;
};
