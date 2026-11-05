import { usePrivateLibrary } from './usePrivateLibrary.js';
import { useDraftReferencePersistence } from './useDraftReferencePersistence.js';
import { createPrivateMedia } from './privateMedia.js';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';

import { api, fetchBlob, newKey } from './api.js';
import { preserveError, localDiagnostic } from './diagnostics.js';
import { scopeKeyOf, selectSource, SOURCE } from './cachePolicy.js';
import {
  addCustomOption,
  additionalRequest,
  appendAdditional,
  applyExpansion,
  descriptorSignature,
  hasControlCapacity,
  recordAdditionalMetadata,
  categorySummaries,
  cloneJson,
  controlApplicationSupported,
  createEntries,
  entriesFromRecord,
  expansionRequest,
  GROUP,
  effectiveControlLimit,
  parseControlList,
  resetEntry,
  setValue,
  toggleOption,
  upgradeFixedEntries,
} from './controls.js';
import { providerRequest } from './providerSettings.js';
import { normalizeClientPolicy, withOverrides } from './clientPolicy.js';
import { useCacheStore } from './useCacheStore.js';
import { useDiscovery } from './discovery.js';
import {
  findByIdentity,
  IMPORT_NOT_KEPT_MESSAGE,
  ImportRefusedError,
  useImport,
} from './importFlow.js';
import {
  composeHistory,
  emptyLedger,
  findSelected,
  isDismissable,
  isPendingItem,
  jobKey,
  ledgerReducer,
} from './historyLedger.js';
import {
  describeImage,
  hasSharedMedia,
  imageKey,
  isLocalOnly,
  LOCAL_ORIGIN,
} from './imageRecord.js';
import { isActive, jobPolicyFrom, newJob, PHASE } from './jobs.js';
import { observeJob } from './jobStream.js';
import { useVariationGroup } from './useVariationGroup.js';
import {
  allowedCount,
  canRetry as canRetryGroup,
  DEFAULT_VARIATIONS,
  summarize as summarizeGroup,
  variationCapability,
} from './variationGroups.js';
import { useLibrary } from './library.js';
import { fallbackFor, timingFrom } from './librarySync.js';
import { isNearAnchor } from './promptAnchor.js';
import { matchesControlIdentity } from './controlIdentity.js';
import {
  clearPending,
  hasRetentionClaim,
  markIntent,
  standardSummary,
} from './controlIntent.js';
import { randomizeStandard } from './standardRandom.js';
import {
  planRetention,
  capacityMessage,
  overLimitMessage,
} from './controlRetention.js';
import {
  automaticGenerated,
  pendingStandard,
  settleStandard,
  settleGenerated,
} from './standardSettlement.js';
import { createUrlLedger } from './objectUrls.js';
import { usePrivateHistory } from './privateHistory.js';
import { usePrivateCreate } from './usePrivateCreate.js';
import { createVariantMedia } from './variantMedia.js';
import { readOriginalBytes } from './originalBytes.js';
import {
  appliesToEdit,
  buildEditForm,
  DRAFT_KIND,
  draftKind,
  editBlockReason,
  selectedEditingCapability,
  checkReferenceFile,
  recordReferences,
  referenceContext,
  referenceSignature,
  savedReferenceFile,
  savedReferenceId,
  withRecordedEdit,
} from './references.js';
import { retainedReader } from './retainedReferences.js';
import { useReferences } from './useReferences.js';
import { useRetainedReferences } from './useRetainedReferences.js';
import { regionToolAvailability } from './regionSelection.js';
import { isExactRecord, rememberExact } from './exactRecords.js';
import { CREATE_HISTORY_PAGE_LIMIT } from './libraryWindow.js';
import { useSuggestions } from './suggestions.js';
import { ROUTE, sameTarget, recordIdForEditTarget } from './routes.js';
import { useLocalWatermark } from './localWatermark.js';
import { createSharedPreparedHost } from './sharedPreparedHost.js';
import { useWatermark } from './watermark.js';
import { usePreference } from './preferences.js';
import { requestFraming } from './outputFraming.js';
import {
  buildSubmission,
  DEFAULT_ASPECT,
  libraryRecordFromResult,
  nearestAspect,
  promptKey,
  disabledControlBlock,
  submitBlockReason,
} from './submission.js';

import {
  createDraftHistory,
  referenceSnapshot,
  settledDynamic,
} from './draftHistory.js';

export { ASPECTS, MODES } from './submission.js';

/** Earlier prompts sent as context to control generation. */
const PROMPT_HISTORY_LIMIT = 3;

const CREATE_HISTORY_BINDING = Object.freeze({
  limit: CREATE_HISTORY_PAGE_LIMIT,
});
const HTTP_NOT_FOUND = 404;
const DETAIL_FAILED = "This image's settings could not be loaded.";
const DETAIL_GONE = 'That image is no longer in the library.';
const DETAIL_SUPERSEDED =
  "The draft changed before that image's settings loaded, so it was left as it is.";

/** Keep a region only with the exact source bytes and their oriented geometry. */
function regionMatchesReference(selection, reference) {
  if (!selection) return true;
  if (!reference || reference.sha256 !== selection.source_sha256) return false;
  const { width, height } = reference.dimensions ?? {};
  return (
    width == null ||
    height == null ||
    (width === selection.width && height === selection.height)
  );
}

function regionSubmissionProblem(selection, references, capability) {
  if (!selection) return null;
  const base = references[0];
  const availability = regionToolAvailability(capability, {
    ...base,
    file: base?.blob,
  });
  if (!availability.available)
    return `${availability.reason} Clear the region selection to continue.`;
  if (!base?.blob || base.status !== 'ready')
    return 'Attach the original base image to use this region selection.';
  if (!regionMatchesReference(selection, base))
    return 'The region selection belongs to a different base image. Clear it or select the original base again.';
  return null;
}

/** The server's own providers: no browser override. */
const NO_PROVIDER = Object.freeze({ header: null, id: 'default' });
/**
 * A notice that describes the draft itself (a refused file or a submission it
 * blocked). Undo and redo replace the draft, so they clear only these.
 */
const NOTICE_SCOPE = Object.freeze({ draft: 'draft' });

const blankDraft = {
  prompt: '',
  mode: 'image',
  // Edit is an explicit choice, not a consequence of holding references.
  edit: false,
  aspect: DEFAULT_ASPECT,
  mustHaveTerms: [],
};
const idleDynamic = {
  status: 'idle',
  anchor: null,
  metadata: null,
  error: null,
};
const idleAdditional = { status: 'idle' };

/** Draft fields for a Text, Edit or Asset choice; Edit uses the image pipeline. */
const kindFields = (kind) => ({
  mode: kind === DRAFT_KIND.asset ? 'asset-image' : 'image',
  edit: kind === DRAFT_KIND.edit,
});
const KIND_VALUES = Object.values(DRAFT_KIND);

/**
 * Whether a draft still contains only its initial, unedited base controls.
 * `blank` is the fresh draft for the remembered mode and aspect.
 */
const pristineDraft = (snapshot, blank = blankDraft) =>
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
const additionalIdentityOf = (draft, providerId, entries, refs = '') =>
  JSON.stringify([
    promptKey(draft.prompt, draft.mode),
    providerId,
    descriptorSignature(entries),
    refs,
  ]);

/** Ordered reference context, added to a request only when references exist. */
const withReferenceContext = (body, refs) =>
  refs.length ? { ...body, reference_context: referenceContext(refs) } : body;
const RETRYABLE_STATUSES = new Set([500, 502, 504]);

/** Write the synchronous draft mirror outside render logic. */
const writeRef = (ref, value) => {
  ref.current = value;
  return value;
};

const isRetryable = (error) =>
  error.network || RETRYABLE_STATUSES.has(error.status);
const aborted = (error) => error?.name === 'AbortError';

async function fetchDynamicControls(body, signal, maxAttempts, header) {
  // Each failed attempt keeps the exchange the server returned for it.
  const attempts = [];
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await api.dynamicControls(body, {
        ...providerRequest(header),
        signal,
      });
    } catch (error) {
      if (aborted(error)) throw error;
      if (error?.evidence) attempts.push(error.evidence);
      if (!isRetryable(error) || attempt >= maxAttempts) {
        if (attempts.length && error && typeof error === 'object')
          error.attempts = attempts;
        throw error;
      }
    }
  }
}

const failureNotice = (text, error) => ({
  tone: 'error',
  text,
  error: preserveError(error),
  details: error?.details ?? null,
});

/**
 * Shared generator state.
 *
 * Three pieces keep async results from overwriting newer work:
 * - `rev.draft` counts every draft edit; a submission records the value it saw.
 * - dynamic controls are applied only while the prompt and mode they were
 *   generated for are still current (`promptKey`), and a newer request aborts
 *   the older one.
 * - `rev.pick` counts explicit image selections, so a late result never moves
 *   the image a person chose to look at.
 */
export function useStudio({
  jobPolicy,
  clientPolicy: policyOverrides,
  route = null,
  provider = NO_PROVIDER,
  editLink = null,
} = {}) {
  const discovery = useDiscovery(provider);
  const publishedPolicy = discovery.capabilities.data?.client_policy;
  const policy = useMemo(
    () =>
      withOverrides(normalizeClientPolicy(publishedPolicy), policyOverrides),
    [publishedPolicy, policyOverrides],
  );
  const observerPolicy = jobPolicy ?? jobPolicyFrom(policy);
  const [preferredAspect, savePreferredAspect] = usePreference(
    'create-aspect',
    DEFAULT_ASPECT,
    (value, fallbackValue) =>
      ['2:3', '3:2', '1:1'].includes(value) ? value : fallbackValue,
  );
  // The chosen mode survives reloads and New draft, like the aspect. It is a
  // preference only: restoring it sends nothing and loads no references.
  const [preferredKind, savePreferredKind] = usePreference(
    'create-kind',
    DRAFT_KIND.text,
    (value, fallbackValue) =>
      KIND_VALUES.includes(value) ? value : fallbackValue,
  );
  const sharedLibrary = discovery.capabilities.data?.shared_library;
  const fallback = fallbackFor(route, policy.transport);
  const syncTiming = useMemo(() => timingFrom(policy.transport), [policy]);
  const cache = useCacheStore(policy.cache);
  // Capabilities alone choose the source; until the cache has opened nothing
  // is requested, so the stored list can be shown first.
  const capabilitiesSource = selectSource(discovery.capabilities);
  const scopeKey = useMemo(
    () => scopeKeyOf(discovery.capabilities.data),
    [discovery.capabilities.data],
  );
  const library = useLibrary({
    source: cache.ready ? capabilitiesSource : SOURCE.PENDING,
    scopeKey,
    store: cache.store,
    refreshCapabilities: discovery.reload,
    paged: route === ROUTE.library || route === ROUTE.create,
    surface: route,
    retainWindow: route === ROUTE.create,
    windowBinding: route === ROUTE.create ? CREATE_HISTORY_BINDING : undefined,
    // The shared Gallery reads bounded sessions itself; it gets change ticks.
    sessionSurface: route === ROUTE.gallery,
    sync: {
      enabled: true,
      timing: syncTiming,
      pollMs: sharedLibrary?.polling_enabled === false ? null : fallback.pollMs,
      pauseOnPointer: fallback.pauseOnPointer,
    },
  });
  const {
    insert: insertImage,
    reload: reloadImages,
    remove: deleteImage,
    loadLibraryRecord: loadRecord,
    loadLibraryRecordById: loadRecordById,
  } = library;
  const [draft, setDraft] = useState(() => ({
    ...blankDraft,
    aspect: preferredAspect,
    ...kindFields(preferredKind),
  }));
  const initialMode = useRef(draft.mode);
  const [entries, setEntries] = useState([]);
  const [base, setBase] = useState({ status: 'loading', error: null });
  const [dynamic, setDynamic] = useState(idleDynamic);
  const [regionEdit, setRegionEditState] = useState(null);
  const [regionNotice, setRegionNotice] = useState(null);
  const regionEditRef = useRef(null);
  const regionRestoreInProgress = useRef(false);
  const [regionEditorBase, setRegionEditorBase] = useState(null);
  const setRegionEdit = useCallback((value) => {
    regionEditRef.current = value;
    setRegionEditState(value);
  }, []);
  const [notice, setNotice] = useState(null);
  const [job, setJob] = useState(null);
  const [currentId, setCurrentId] = useState(null);
  const [generationReveal, setGenerationReveal] = useState(null);
  const historyRevealed = useCallback((request) => {
    setGenerationReveal((pending) =>
      pending === request ? { ...pending, consumed: true } : pending,
    );
  }, []);
  // New draft empties the stage; the newest saved image is not the fallback
  // again until a person or a finished job selects an image.
  const [stageCleared, setStageCleared] = useState(true);
  /**
   * What the stage is making: set when a submission starts and cleared when it
   * settles or the person picks an image. While set (and the job has not
   * failed) the stage shows no earlier image.
   */
  const [generating, setGenerating] = useState(null);
  const [ledger, dispatchLedger] = useReducer(ledgerReducer, emptyLedger);
  const [basedOn, setBasedOn] = useState(null);
  const [expansions, setExpansions] = useState({});
  /** More controls: `{ status: idle|loading|error|added, error?, added? }`. */
  const [additional, setAdditional] = useState(idleAdditional);
  /** Opaque metadata of each accepted batch, in order, for the submission. */
  const [additionalMetadata, setAdditionalMetadata] = useState([]);
  const regionCapability = discovery.capabilities.data?.region_editing ?? null;
  /** Generated controls have arrived but their reveal is still being held. */
  const [revealHeld, setRevealHeld] = useState(false);
  const [urls] = useState(createUrlLedger);
  /** Whole-draft undo and redo: snapshots only, nothing persisted. */
  const [draftHistory] = useState(createDraftHistory);
  const [historyState, setHistoryState] = useState(() => draftHistory.state());
  /** The last undo or redo, for the announcement and its motion. */
  const [historyStep, setHistoryStep] = useState(null);
  // The selected provider's model decides editing and its reference limit.
  const providerOverridden = Boolean(provider?.header);
  const editCapability = useMemo(
    () =>
      selectedEditingCapability(
        { models: discovery.models, capabilities: discovery.capabilities },
        providerOverridden,
      ),
    [discovery.models, discovery.capabilities, providerOverridden],
  );
  /** The server honours controls left to the model in text requests. */
  const controlApplication = controlApplicationSupported(
    discovery.capabilities.data,
  );
  /** Grouped variations (E04): null on a server without them. */
  const variationCap = useMemo(
    () => variationCapability(discovery.capabilities.data),
    [discovery.capabilities.data],
  );
  /** Images the next explicit submission asks for; never more than allowed. */
  const [variationChoice, setVariationChoice] = useState(DEFAULT_VARIATIONS);
  const variationCount = allowedCount(variationChoice, variationCap);
  // Originals the person kept in this browser: read only when a restored
  // slot needs one, and only while storage is actually available.
  const keptStore = cache.store?.referenceAssets ?? null;
  const keptDurable = Boolean(keptStore?.durable);
  const readRetained = useMemo(
    () => (keptDurable ? retainedReader(keptStore) : null),
    [keptStore, keptDurable],
  );
  const references = useReferences({
    urls,
    capability: editCapability,
    uploads: discovery.capabilities.data?.uploads,
    readRetained,
    providerScope: provider?.header ?? null,
  });
  const retained = useRetainedReferences({
    store: keptStore,
    ready: cache.ready,
    references,
    capability: editCapability,
  });
  /** The draft's ordered references, current between renders. */
  const refsLive = useRef([]);
  const referenceAddToken = useRef(0);
  /** Moves when a saved image's read for "Use as reference" is superseded. */
  const imageReferenceToken = useRef(0);
  const referenceAddBatch = useRef(null);
  /** The saved image whose original is being read for "Use as reference". */
  const [referenceReading, setReferenceReading] = useState(null);
  // Key of the prompt text last placed by a reference proposal or its Undo.
  const derivedPrompt = useRef(null);
  /**
   * The edit's references while Text to image or Asset image is chosen:
   * snapshot descriptors (no bytes), the proposal and region selection. They
   * come back when Edit is chosen again; undo snapshots carry them too.
   */
  const parked = useRef(null);
  /** The next reference transaction's undo step was already recorded. */
  const transactionRecorded = useRef(false);
  /** How many references wait in the parked edit, for the mode selector. */
  const [parkedDraft, setParkedDraft] = useState(null);
  const parkedCount = parkedDraft?.refs?.length ?? 0;
  // Switching tools keeps each tool's Standard choices, including historical
  // catalogs and opaque saved fields. Undo captures this map with the draft.
  const standardByKind = useRef(new Map());
  const park = useCallback((value) => {
    parked.current = value ?? null;
    setParkedDraft(value ?? null);
  }, []);
  const {
    bind: bindReferences,
    restore: restoreReferences,
    clear: clearReferences,
    add: addReferences,
  } = references;
  const refSignature = references.signature;
  const {
    restoreDraft: restoreDraftReferences,
    park: parkReferences,
    currentProposal,
  } = references;
  const hydratingReferences = useRef(false);
  const referencesReconciled = useRef(false);
  const persistenceReferences = {
    ...references,
    restoreDraft: (...args) => {
      hydratingReferences.current = true;
      try {
        return restoreDraftReferences(...args);
      } finally {
        hydratingReferences.current = false;
      }
    },
  };
  const draftReferencePersistence = useDraftReferencePersistence({
    references: persistenceReferences,
    parked: parkedDraft,
    onRestoreParked: park,
  });
  const clearDraftFiles = draftReferencePersistence.clear;
  useLayoutEffect(() => {
    if (!draftReferencePersistence.hydrated || referencesReconciled.current)
      return;
    referencesReconciled.current = true;
    if (!live.current.draft.edit && references.live.current.length) {
      park(parkReferences());
    } else if (
      live.current.draft.edit &&
      !references.live.current.length &&
      parked.current
    ) {
      const held = parked.current;
      park(null);
      restoreDraftReferences(held.refs, held.proposal, held.sources);
    }
  }, [
    draftReferencePersistence.hydrated,
    park,
    parkReferences,
    restoreDraftReferences,
    references.live,
  ]);

  const publishHistory = useCallback(() => {
    const next = draftHistory.state();
    setHistoryState((prev) =>
      prev.canUndo === next.canUndo &&
      prev.canRedo === next.canRedo &&
      prev.undoLabel === next.undoLabel &&
      prev.redoLabel === next.redoLabel
        ? prev
        : next,
    );
  }, [draftHistory]);

  /**
   * The draft as undo keeps it. Values are shared, not copied; references are
   * kept as identities and descriptions, never bytes; loading or failed
   * prompt work is kept as what had settled.
   */
  const captureDraft = useCallback(() => {
    const now = live.current;
    return {
      draft: {
        ...now.draft,
        mustHaveTerms: [...(now.draft.mustHaveTerms ?? [])],
      },
      entries: now.entries,
      dynamic: settledDynamic(now.dynamic),
      additionalMetadata: now.additionalMetadata,
      regionEdit: regionEditRef.current,
      basedOn: now.basedOn ?? null,
      episode: { ...episode.current },
      derivedPrompt: derivedPrompt.current,
      refs: refsLive.current.map(referenceSnapshot),
      proposal: currentProposal(),
      parked: parked.current,
      standardByKind: new Map(standardByKind.current),
    };
    // live, episode, refsLive and derivedPrompt are refs read when called.
  }, [currentProposal]);

  /** Record the draft before a person's own change. */
  const recordDraft = useCallback(
    (label, options = {}) => {
      draftHistory.record(captureDraft(), { label, ...options });
      publishHistory();
    },
    [draftHistory, captureDraft, publishHistory],
  );
  /** Exact records in memory, apart from the summary rows they belong to. */
  const [exact, setExact] = useState(() => new Map());
  const exactRef = useRef(exact);
  /** The image whose exact record is being read for the draft. */
  const [restoring, setRestoring] = useState(null);
  const pickRun = useRef({ token: 0, controller: null });
  const pinnedKeys = useRef(new Set());
  const [headAttempt, setHeadAttempt] = useState(0);
  const [settledLink, setSettledLink] = useState(null);
  const linkAnchor = useRef(null);
  const restoreRef = useRef(null);
  // The browser-private history serves private-source images and keeps imports
  // in either source. It never touches the shared library.
  const privateSource = library.source === SOURCE.PRIVATE;
  const sharedSource = library.source === SOURCE.SHARED;
  const privateLibraryRoute = privateSource && route === ROUTE.library;
  const privateCreateRoute = privateSource && route === ROUTE.create;
  const privateLibrary = usePrivateLibrary({
    store: cache.store,
    enabled: privateLibraryRoute,
  });
  const privateCreate = usePrivateCreate({
    store: cache.store,
    enabled: privateCreateRoute,
  });
  const {
    repository: privateCreateRepository,
    window: privateCreateWindow,
    load: loadPrivateCreate,
    exact: exactPrivateCreate,
    byKey: lookupPrivateCreate,
    pinRole: pinPrivateCreateRole,
  } = privateCreate;
  const refreshPrivateCreate = useCallback(
    async ({ key, addedAt } = {}) => {
      if (!privateCreateRoute) return null;
      const first = await loadPrivateCreate({ direction: 'first' });
      const contains = (result) =>
        result?.accepted &&
        result.state?.rows?.some(
          (row) => row.key === key && row.addedAt === addedAt,
        );
      if (!key || contains(first)) return first;
      return loadPrivateCreate({
        direction: 'around',
        identity: { key, addedAt },
        before: 0,
        after: 0,
      });
    },
    [privateCreateRoute, loadPrivateCreate],
  );
  const privateHistory = usePrivateHistory({
    store: cache.store,
    urls,
    limits: policy.cache,
    boundedLibrary: privateLibraryRoute,
    boundedCreate: privateCreateRoute,
    onStored: refreshPrivateCreate,
    enabled: Boolean(cache.store) && (privateSource || sharedSource),
  });
  const {
    add: addPrivate,
    remove: removePrivate,
    retry: retryPrivate,
    admissionBlock: privateAdmissionBlock,
    oldestUnsaved: oldestUnsavedPrivate,
  } = privateHistory;
  // One watermark owner. The content is this browser's own; browser-only
  // images are prepared through the private history, shared originals through
  // a host that keeps rebuildable copies in bounded browser storage.
  const localWatermark = useLocalWatermark({
    store: cache.store,
    ready: cache.ready,
  });
  const [sharedHost] = useState(() => createSharedPreparedHost({ fetchBlob }));
  const pagedSurface =
    sharedSource && (route === ROUTE.library || route === ROUTE.create);
  const createWindow = sharedSource && route === ROUTE.create;
  const privateRepository = privateLibrary.repository;
  const loadPrivateLibrary = privateLibrary.load;
  const retainPrivateRecord = useCallback(
    (record) => {
      const handle = privateRepository?.host.handleFor(record);
      return handle
        ? privateRepository.host.retain(handle, 'selected')
        : undefined;
    },
    [privateRepository],
  );
  const reloadLibraryImages = useCallback(
    () =>
      privateCreateRoute
        ? loadPrivateCreate({ direction: 'refresh' })
        : privateLibraryRoute
          ? loadPrivateLibrary({ direction: 'refresh' })
          : reloadImages(),
    [
      privateCreateRoute,
      loadPrivateCreate,
      privateLibraryRoute,
      loadPrivateLibrary,
      reloadImages,
    ],
  );
  const localHost = useMemo(() => {
    const boundedLibrary = privateLibrary.repository?.host;
    const boundedCreate = privateCreateRepository?.host;
    const fallback = privateHistory.watermarkHost;
    if (!boundedLibrary && !boundedCreate) return fallback;
    const hostFor = (value) => {
      if (privateCreateRoute && value?.local_added_at !== undefined)
        return boundedCreate ?? fallback;
      return value?.local_added_at !== undefined || value?.boundedPrivate
        ? (boundedLibrary ?? fallback)
        : fallback;
    };
    return Object.fromEntries(
      [
        'isListed',
        'current',
        'readOriginal',
        'readPrepared',
        'persistenceOf',
        'saveAnalysis',
        'savePrepared',
        'load',
        'retain',
      ]
        .map((method) => [
          method,
          (handle, ...args) => hostFor(handle)[method]?.(handle, ...args),
        ])
        .concat([
          [
            'handleFor',
            (record) => {
              const host = hostFor(record);
              const handle = host.handleFor(record);
              return handle &&
                (host === boundedLibrary || host === boundedCreate)
                ? { ...handle, boundedPrivate: true }
                : handle;
            },
          ],
        ]),
    );
  }, [
    privateLibrary.repository,
    privateCreateRepository,
    privateCreateRoute,
    privateHistory.watermarkHost,
  ]);
  const watermark = useWatermark({
    images: library.images,
    reload: reloadImages,
    replace: library.replace,
    local: localWatermark,
    capabilities: discovery.capabilities.data,
    localHost,
    sharedHost,
    observeSharedBatch: route === ROUTE.library && sharedSource,
    batchCheck: library.libraryWindow.revision,
  });
  const media = useMemo(
    () =>
      cache.store?.durable && sharedSource
        ? createVariantMedia({
            store: cache.store,
            urls,
            fetchBlob,
          })
        : null,
    [cache.store, sharedSource, urls],
  );
  const privateMedia = useMemo(
    () =>
      cache.store ? createPrivateMedia({ store: cache.store, urls }) : null,
    [cache.store, urls],
  );
  const displayMedia = useMemo(
    () => ({
      accepts: (record) =>
        privateMedia?.accepts(record) ||
        Boolean(media && hasSharedMedia(record)),
      peek: (record, kind) =>
        (privateMedia?.accepts(record) ? privateMedia : media)?.peek(
          record,
          kind,
        ),
      lease: (record, kind, options) =>
        (privateMedia?.accepts(record) ? privateMedia : media)?.lease(
          record,
          kind,
          options,
        ) ?? Promise.resolve(null),
      recoverThumbnail: (record, options) =>
        privateMedia?.accepts(record)
          ? (privateMedia.recoverThumbnail?.(record, options) ??
            Promise.resolve(null))
          : Promise.resolve(null),
      capture: (record, ...args) => media?.capture(record, ...args),
      drop: (record, kind) =>
        (privateMedia?.accepts(record) ? privateMedia : media)?.drop(
          record,
          kind,
        ),
      blob: (record, kind) =>
        media?.blob(record, kind) ?? Promise.resolve(null),
    }),
    [privateMedia, media],
  );
  useLayoutEffect(() => {
    sharedHost.bind({
      store: cache.store,
      isListed: (key) =>
        (pagedSurface
          ? [
              ...library.libraryWindow.pages.flatMap((page) => page.images),
              ...library.images.items,
              ...exactRef.current.values(),
            ]
          : library.images.items
        ).some((item) => imageKey(item) === key),
      media,
    });
  });
  const inferenceOff =
    discovery.health.data?.inference_enabled === false ||
    discovery.models.data?.inference_enabled === false;
  const suggestions = useSuggestions(
    draft.mode,
    route === ROUTE.create &&
      discovery.health.status === 'ready' &&
      discovery.models.status === 'ready' &&
      !inferenceOff,
    provider,
  );

  const rev = useRef({ draft: 0, pick: 0 });
  const live = useRef({});
  useLayoutEffect(() => {
    writeRef(live, {
      draft,
      entries,
      dynamic,
      job,
      discovery,
      source: library.source,
      privateItems: privateHistory.items,
      savedImages: createWindow
        ? [
            ...library.images.items,
            ...library.libraryWindow.pages.flatMap((page) => page.images),
            ...exact.values(),
          ]
        : privateCreateRoute
          ? [
              ...privateHistory.items,
              ...privateCreateWindow.rows,
              ...exact.values(),
            ]
          : library.images.items,
      restoreRecord: library.restoreRecord,
      exact,
      policy,
      inferenceOff,
      provider,
      additionalMetadata,
      regionEdit,
      baseStatus: base.status,
      editCapability,
      basedOn,
      variationCount,
      variationCap,
    });
  });
  const selection = useRef({ current: null, currentId: null });
  const alive = useRef(true);
  const staticCache = useRef(new Map());
  const staticReads = useRef(new Map());
  const baseToken = useRef(0);
  const flight = useRef(null);
  const promptHistory = useRef([]);
  const submitting = useRef(false);
  // The prompt episode: its original anchor (null until a prompt exists) and
  // whether standard values still wait for their one random draw.
  const episode = useRef({ anchor: null, pending: true });
  const [scrollRequest, setScrollRequest] = useState(null);
  const submissionKey = useRef(null);
  const trackRun = useRef(0);
  const trackAbort = useRef(null);
  const timers = useRef({ background: null, reconcile: null, reveal: null });
  const expansionRuns = useRef(new Map());
  const additionalRun = useRef(null);
  const cancelImport = useRef(() => {});
  const imageImportPending = useRef(false);

  useEffect(() => {
    alive.current = true;
    const expanding = expansionRuns.current;
    const pending = timers.current;
    return () => {
      alive.current = false;
      trackAbort.current?.abort();
      Object.values(pending).forEach(clearTimeout);
      flight.current?.controller.abort();
      expanding.forEach((controller) => controller.abort());
      additionalRun.current?.controller.abort();
      urls.releaseAll();
    };
  }, [urls]);

  const touch = () => {
    rev.current.draft += 1;
  };

  const publishEntries = useCallback((change) => {
    const next =
      typeof change === 'function' ? change(live.current.entries) : change;
    writeRef(live, { ...live.current, entries: next });
    setEntries(next);
    return next;
  }, []);

  const identityMatches = useCallback(
    (set, current = live.current) =>
      matchesControlIdentity(set, {
        provider: current.provider.id,
        draft: current.draft,
        refs: referenceSignature(refsLive.current),
        policy: current.policy,
      }),
    [],
  );

  // --- Option expansion --------------------------------------------------------

  const cancelExpansion = useCallback((key) => {
    expansionRuns.current.get(key)?.abort();
    expansionRuns.current.delete(key);
    setExpansions(({ [key]: _dropped, ...rest }) => rest);
  }, []);

  /** Controls were replaced wholesale; no expansion may land on the new ones. */
  const cancelAllExpansions = useCallback(() => {
    expansionRuns.current.forEach((controller) => controller.abort());
    expansionRuns.current.clear();
    setExpansions({});
    additionalRun.current?.controller.abort();
    additionalRun.current = null;
    setAdditional(idleAdditional);
  }, []);

  /** The generated controls were replaced or dropped: their additions go too. */
  const replaceAdditionalMetadata = useCallback((metadata = []) => {
    writeRef(live, { ...live.current, additionalMetadata: metadata });
    setAdditionalMetadata(metadata);
  }, []);

  /**
   * Ask the server for more choices for one control, then add only the new
   * ones to the control as it is when the answer arrives: selections and
   * custom options made meanwhile stay, and a control removed or replaced
   * meanwhile is left alone.
   */
  const expand = useCallback(
    async (key) => {
      const entry = live.current.entries.find((e) => e.key === key);
      if (!entry || expansionRuns.current.has(key)) return;
      const controller = new AbortController();
      expansionRuns.current.set(key, controller);
      const settle = (status) => {
        expansionRuns.current.delete(key);
        setExpansions((prev) => ({ ...prev, [key]: status }));
      };
      setExpansions((prev) => ({ ...prev, [key]: { status: 'loading' } }));
      try {
        const enriched = await api.addControlOptions(
          expansionRequest(entry, live.current.entries),
          {
            ...providerRequest(live.current.provider.header),
            signal: controller.signal,
          },
        );
        if (expansionRuns.current.get(key) !== controller || !alive.current)
          return;
        const latest = live.current.entries.find((e) => e.key === key);
        if (!latest) {
          settle(undefined);
          return;
        }
        const { added } = applyExpansion(latest, enriched);
        if (added) {
          recordDraft(`More choices for ${latest.wire?.label ?? 'a control'}`);
          touch();
          publishEntries((prev) =>
            prev.map((e) =>
              e.key === key ? applyExpansion(e, enriched).entry : e,
            ),
          );
        }
        settle(added ? undefined : { status: 'empty' });
      } catch (error) {
        if (aborted(error) || expansionRuns.current.get(key) !== controller)
          return;
        settle({ status: 'error', error });
      }
    },
    [recordDraft, publishEntries],
  );

  // --- More controls ----------------------------------------------------------

  const maxControls =
    discovery.capabilities.data?.control_generation?.max_controls;
  const additionalEnabled =
    discovery.capabilities.data?.control_generation?.additional_controls
      ?.enabled !== false;

  /**
   * Ask the server for more controls for the idea as it is now, then append
   * only the new ones to the list as it is when the answer arrives, so
   * selections made meanwhile stay. The answer is dropped when the idea, mode,
   * provider or descriptor set changed, or when it no longer fits.
   */
  const addControls = useCallback(async () => {
    const start = live.current;
    if (
      additionalRun.current ||
      start.inferenceOff ||
      !start.draft.prompt.trim() ||
      start.dynamic.status === 'loading' ||
      !start.entries.some((e) => e.group === GROUP.generated)
    )
      return;
    const startRefs = refsLive.current;
    const request = withReferenceContext(
      additionalRequest(start.draft, start.entries),
      startRefs,
    );
    const identity = additionalIdentityOf(
      start.draft,
      start.provider.id,
      start.entries,
      referenceSignature(startRefs),
    );
    const controller = new AbortController();
    const run = { controller, identity };
    additionalRun.current = run;
    setAdditional({ status: 'loading' });
    try {
      const response = await api.additionalControls(request, {
        ...providerRequest(start.provider.header),
        signal: controller.signal,
      });
      if (additionalRun.current !== run || !alive.current) return;
      const now = live.current;
      if (
        additionalIdentityOf(
          now.draft,
          now.provider.id,
          now.entries,
          referenceSignature(refsLive.current),
        ) !== identity
      ) {
        additionalRun.current = null;
        setAdditional(idleAdditional);
        return;
      }
      const {
        entries: admitted,
        added,
        metadata,
      } = appendAdditional(
        now.entries,
        {
          ...response,
          controls: automaticGenerated(
            response.controls,
            response.additional_controls_metadata?.suggestion_anchor,
          ),
        },
        maxControls,
      );
      const entries = settleGenerated(admitted, now.entries, {
        editing: Boolean(now.draft.edit),
      });
      additionalRun.current = null;
      if (added) recordDraft('More controls');
      const nextMetadata = [...now.additionalMetadata, cloneJson(metadata)];
      writeRef(live, { ...now, entries, additionalMetadata: nextMetadata });
      touch();
      setEntries(entries);
      setAdditionalMetadata(nextMetadata);
      setAdditional({
        status: 'added',
        added,
        identity: additionalIdentityOf(
          now.draft,
          now.provider.id,
          entries,
          referenceSignature(refsLive.current),
        ),
      });
    } catch (error) {
      if (aborted(error) || additionalRun.current !== run) return;
      additionalRun.current = null;
      setAdditional({
        status: 'error',
        error,
        identity: additionalIdentityOf(
          live.current.draft,
          live.current.provider.id,
          live.current.entries,
          referenceSignature(refsLive.current),
        ),
      });
    }
  }, [maxControls, recordDraft]);

  // The pending batch belongs to one idea, mode, provider and descriptor set.
  const additionalIdentity = additionalIdentityOf(
    draft,
    provider.id,
    entries,
    refSignature,
  );
  useEffect(() => {
    const run = additionalRun.current;
    if (run && run.identity !== additionalIdentity) {
      run.controller.abort();
      additionalRun.current = null;
      setAdditional(idleAdditional);
    } else if (
      !run &&
      (additional.status === 'added' || additional.status === 'error') &&
      additional.identity !== additionalIdentity
    )
      setAdditional(idleAdditional);
  }, [additionalIdentity, additional]);

  // --- Prompt-specific (dynamic) controls ----------------------------------

  const clearTimer = useCallback((name) => {
    clearTimeout(timers.current[name]);
    timers.current[name] = null;
  }, []);

  /** An intentional reset (mode change, restore, new draft): no pending prompt work. */
  const cancelPromptTimers = useCallback(() => {
    clearTimer('background');
    clearTimer('reconcile');
  }, [clearTimer]);

  /** Keep generated controls hidden for `ms` after they arrive (0 shows them now). */
  const holdReveal = useCallback(
    (ms) => {
      clearTimer('reveal');
      setRevealHeld(ms > 0);
      if (ms > 0)
        timers.current.reveal = setTimeout(() => {
          timers.current.reveal = null;
          setRevealHeld(false);
        }, ms);
    },
    [clearTimer],
  );

  /** Whether `anchor` (from `promptKey`) still describes the draft. */
  const nearAnchor = useCallback(
    (anchor, draftNow) =>
      isNearAnchor(
        anchor,
        draftNow.prompt,
        draftNow.mode,
        live.current.policy.controls.similarityMinimumRatio,
      ),
    [],
  );

  /**
   * Clear prompt-specific state only: generated controls, their metadata and
   * any pending expansion. Standard controls, including custom options and
   * selections, are untouched.
   */
  const dropGenerated = useCallback(() => {
    const kept = live.current.entries.filter(
      (e) => e.group !== GROUP.generated,
    );
    // A submission continues before React re-renders, so publish synchronously.
    writeRef(live, { ...live.current, entries: kept, dynamic: idleDynamic });
    cancelAllExpansions();
    replaceAdditionalMetadata();
    holdReveal(0);
    setEntries(kept);
    setDynamic(idleDynamic);
  }, [cancelAllExpansions, replaceAdditionalMetadata, holdReveal]);

  /** Keep catalog values pending until the existing controls call settles. */
  const drawStandard = useCallback(() => {
    const ep = episode.current;
    if (!ep.pending || ep.anchor === null) return;
    const all = live.current.entries;
    if (!all.some((e) => e.group === GROUP.base)) return;
    if (live.current.draft.edit || refsLive.current.length) {
      writeRef(episode, { ...ep, pending: false });
      if (!ep.keepChoices)
        publishEntries(
          all.map((e) =>
            e.group === GROUP.base &&
            (e.explicit || e.applyToEdit !== undefined)
              ? { ...resetEntry(e), explicit: false, applyToEdit: undefined }
              : e,
          ),
        );
      return;
    }
    const pending = pendingStandard(all);
    writeRef(episode, { ...ep, pending: false });
    const settlement = ep.settlement ?? (live.current.inferenceOff ? {} : null);
    publishEntries(settlement ? settleStandard(pending, settlement) : pending);
  }, [publishEntries]);

  const settleStandards = useCallback(
    (response = {}) => {
      const ep = episode.current;
      if (live.current.draft.edit || refsLive.current.length) return;
      const settlement = {
        suggestions: response.standard_selections,
        anchor: response.dynamic_controls_metadata?.suggestion_anchor,
        textFlags: controlApplicationSupported(
          live.current.discovery.capabilities.data,
        ),
      };
      // A late catalog uses this same result; no second draw or request.
      writeRef(episode, { ...ep, settlement: ep.settlement ?? settlement });
      if (
        live.current.entries.some(
          (entry) => entry.group === GROUP.base && entry.pending,
        )
      )
        publishEntries(
          settleStandard(live.current.entries, ep.settlement ?? settlement),
        );
    },
    [publishEntries],
  );

  /**
   * A new prompt episode: generated controls and their metadata, the stage and
   * the standard selections start over. Accepted jobs, their frozen payloads,
   * saved records and custom option catalogs are untouched; a job that finishes
   * later no longer owns the stage.
   */
  const loadBaseRef = useRef(null);
  const beginEpisode = useCallback(() => {
    const d = { ...live.current.draft, mustHaveTerms: [] };
    writeRef(live, { ...live.current, draft: d });
    setDraft(d);
    const key = promptKey(d.prompt, d.mode);
    writeRef(episode, {
      workRevision: (episode.current.workRevision ?? 0) + 1,
      anchor: d.prompt.trim() ? key : null,
      pending: true,
      // The text left the last episode only through a reference proposal or Undo.
      keepChoices: derivedPrompt.current === key,
    });
    touch();
    flight.current?.controller.abort();
    flight.current = null;
    dropGenerated();
    rev.current.pick += 1;
    setCurrentId(null);
    setStageCleared(true);
    setBasedOn(null);
    setNotice(null);
    setJob((j) => (isActive(j) ? j : null));
    drawStandard();
    // A restored snapshot may carry no fixed controls: this episode then loads
    // the current catalog; its one pending draw follows when the controls land.
    const { entries: now, baseStatus } = live.current;
    if (baseStatus !== 'loading' && !now.some((e) => e.group === GROUP.base))
      loadBaseRef.current?.(live.current.draft.mode);
  }, [dropGenerated, drawStandard]);

  /** Start a new episode when the prompt has left the current one. */
  const syncEpisode = useCallback(() => {
    const { anchor } = episode.current;
    const d = live.current.draft;
    if (anchor === null ? !d.prompt.trim() : nearAnchor(anchor, d))
      return false;
    beginEpisode();
    return true;
  }, [beginEpisode, nearAnchor]);

  // Standard controls that load after the episode began get their draw then.
  useEffect(() => {
    drawStandard();
  }, [entries, drawStandard]);

  /**
   * Fetch or reuse controls for the current prompt. A matching in-flight or
   * completed request (the prompt is still near its anchor) is reused; a late
   * response for a different prompt is discarded. Resolves `{ stale: true }`
   * when this request no longer applies.
   */
  const requestDynamic = useCallback(
    ({ force = false } = {}) => {
      // Controls belong to an episode: make sure the prompt has one first.
      syncEpisode();
      const { draft: current, dynamic: loaded } = live.current;
      const key = promptKey(current.prompt, current.mode);
      // Controls also belong to the ordered references they were made for.
      const refs = refsLive.current;
      const refKey = referenceSignature(refs);
      if (!force) {
        if (loaded.status === 'ready' && identityMatches(loaded))
          return Promise.resolve({ stale: false });
        if (flight.current && identityMatches(flight.current))
          return flight.current.promise;
      }
      // The same rule applies when generation starts: controls for an idea
      // this far away are dropped, never merged into the new ones.
      if (loaded.anchor && !nearAnchor(loaded.anchor, current)) dropGenerated();
      flight.current?.controller.abort();
      const controller = new AbortController();
      const record = {
        key,
        provider: live.current.provider.id,
        episodeAnchor: episode.current.anchor,
        refs: refKey,
        controller,
        promise: null,
        startedAt: Date.now(),
      };
      flight.current = record;
      setDynamic((prev) => ({ ...prev, status: 'loading', error: null }));
      const history = promptHistory.current
        .filter((p) => p !== current.prompt.trim())
        .slice(-PROMPT_HISTORY_LIMIT);
      record.promise = (async () => {
        try {
          // Initial catalog admission belongs to this same flight. A delayed
          // catalog must participate in the total before any candidate installs.
          if (
            episode.current.pending &&
            !episode.current.suppressed &&
            !live.current.entries.some((entry) => entry.group === GROUP.base) &&
            live.current.baseStatus === 'loading'
          ) {
            await loadBaseRef.current?.(current.mode);
            if (
              flight.current !== record ||
              !alive.current ||
              !identityMatches(record)
            )
              return { stale: true };
          }
          // Only generated controls are requested; the client keeps its base list.
          const response = await fetchDynamicControls(
            withReferenceContext(
              {
                prompt: current.prompt.trim(),
                controls: [],
                categories: categorySummaries(live.current.entries),
                prompt_history: history,
                generation_mode:
                  current.mode === 'asset-image' ? 'trellis' : 'standard',
              },
              refs,
            ),
            controller.signal,
            live.current.policy.controls.maxAttempts,
            live.current.provider.header,
          );
          const wires = parseControlList(response?.controls);
          if (flight.current !== record || !alive.current)
            return { stale: true };
          flight.current = null;
          if (
            !identityMatches(record) ||
            record.episodeAnchor !== episode.current.anchor
          ) {
            setDynamic((prev) =>
              prev.status === 'loading'
                ? { ...prev, status: prev.anchor ? 'ready' : 'idle' }
                : prev,
            );
            return { stale: true };
          }
          const admission = planRetention(
            live.current.entries,
            automaticGenerated(
              wires,
              response.dynamic_controls_metadata?.suggestion_anchor,
            ),
            {
              limit: effectiveControlLimit(
                live.current.discovery.capabilities.data?.control_generation
                  ?.max_controls,
              ),
              origin: {
                anchor: live.current.dynamic.anchor,
                refs: live.current.dynamic.refs,
              },
            },
          );
          if (!admission.ok) {
            // Standard suggestions settle independently of generated admission.
            settleStandards(response);
            const error = Object.assign(
              new Error(
                admission.refused === 'capacity'
                  ? capacityMessage(admission.count, admission.limit)
                  : admission.message,
              ),
              admission,
            );
            const failed = {
              ...live.current.dynamic,
              status: 'error',
              error,
              // The response the client refused stays inspectable.
              rejected: response.dynamic_controls_metadata ?? null,
              failedIdentity: { key, provider: record.provider, refs: refKey },
            };
            writeRef(live, { ...live.current, dynamic: failed });
            setDynamic(failed);
            return { stale: false, refused: admission.refused, error };
          }
          const entries = settleGenerated(
            admission.entries,
            live.current.entries,
            { editing: Boolean(live.current.draft.edit) },
          );
          const loadedDynamic = {
            status: 'ready',
            provider: record.provider,
            anchor: key,
            refs: refKey,
            metadata: response.dynamic_controls_metadata ?? null,
            error: null,
          };
          writeRef(live, { ...live.current, entries, dynamic: loadedDynamic });
          cancelAllExpansions();
          replaceAdditionalMetadata();
          setEntries(entries);
          setDynamic(loadedDynamic);
          settleStandards(response);
          // Only a reveal during generation is held, and the held time counts
          // from when loading began: submission itself never waits for it.
          holdReveal(
            submitting.current
              ? live.current.policy.controls.revealHoldMs -
                  (Date.now() - record.startedAt)
              : 0,
          );
          return { stale: false };
        } catch (error) {
          if (
            aborted(error) ||
            !alive.current ||
            flight.current !== record ||
            !identityMatches(record) ||
            record.episodeAnchor !== episode.current.anchor
          )
            return { stale: true };
          settleStandards();
          if (flight.current === record) {
            flight.current = null;
            const failed = {
              ...live.current.dynamic,
              status: 'error',
              error,
              rejected: null,
              failedIdentity: { key, provider: record.provider, refs: refKey },
            };
            writeRef(live, { ...live.current, dynamic: failed });
            setDynamic(failed);
          }
          throw error;
        }
      })();
      return record.promise;
    },
    [
      cancelAllExpansions,
      dropGenerated,
      holdReveal,
      nearAnchor,
      replaceAdditionalMetadata,
      syncEpisode,
      identityMatches,
      settleStandards,
    ],
  );

  const regenerateOptions = useCallback(async () => {
    cancelImport.current();
    if (!live.current.draft.prompt.trim()) return;
    try {
      await requestDynamic({ force: true });
    } catch {
      /* The error is shown by the options panel. */
    }
  }, [requestDynamic]);

  /**
   * After a typed edit settles, fetch controls for the idea when standard
   * controls exist and generated ones do not. Never during a submission,
   * which fetches for itself.
   */
  const startBackground = useCallback(() => {
    timers.current.background = null;
    if (alive.current && !submitting.current) syncEpisode();
    const {
      draft: d,
      entries: all,
      dynamic: loaded,
      inferenceOff: off,
    } = live.current;
    if (
      !alive.current ||
      imageImportPending.current ||
      off ||
      submitting.current ||
      !d.prompt.trim() ||
      episode.current.suppressed
    )
      return;
    if (!all.some((e) => e.group === GROUP.base)) return;
    if (editBlockReason(d.edit, refsLive.current, live.current.editCapability))
      return;
    if (loaded.status === 'ready' && identityMatches(loaded)) return;
    if (loaded.failedIdentity && identityMatches(loaded.failedIdentity)) return;
    requestDynamic().catch(() => {
      /* The options panel shows the error; a submission still falls back. */
    });
  }, [requestDynamic, identityMatches, syncEpisode]);

  /** Drop generated controls, and cancel a request, that the prompt has left behind. */
  const reconcileAnchor = useCallback(() => {
    timers.current.reconcile = null;
    if (!alive.current) return;
    // A new episode drops its controls here; the background timer, which
    // outlives this one, fetches the new ones after the full debounce.
    if (!submitting.current && syncEpisode()) return;
    const { draft: d, dynamic: loaded } = live.current;
    if (flight.current && !nearAnchor(flight.current.key, d)) {
      flight.current.controller.abort();
      flight.current = null;
      setDynamic((prev) =>
        prev.status === 'loading'
          ? { ...prev, status: prev.anchor ? 'ready' : 'idle' }
          : prev,
      );
    }
    if (loaded.anchor && !nearAnchor(loaded.anchor, d)) dropGenerated();
  }, [dropGenerated, nearAnchor, syncEpisode]);

  /** Both timers restart on every typed edit and act on the settled prompt. */
  const scheduleBackground = useCallback(() => {
    const { controls } = live.current.policy;
    clearTimer('background');
    timers.current.background = setTimeout(
      startBackground,
      controls.debounceMs,
    );
  }, [clearTimer, startBackground]);
  const scheduleReconcile = useCallback(() => {
    const { controls } = live.current.policy;
    clearTimer('reconcile');
    timers.current.reconcile = setTimeout(
      reconcileAnchor,
      controls.resetDebounceMs,
    );
  }, [clearTimer, reconcileAnchor]);

  // --- Standard (base) controls -------------------------------------------

  const readBase = useCallback(
    async (
      mode,
      { fresh = false, editing = Boolean(live.current.draft.edit) } = {},
    ) => {
      const catalogKey = editing ? 'edit' : mode;
      const cached = staticCache.current.get(catalogKey);
      if (cached) return cached;
      if (fresh || !staticReads.current.has(catalogKey)) {
        const promise = api
          .staticControls(mode, { editing })
          .then((response) => {
            const wires = parseControlList(response?.controls);
            staticCache.current.set(catalogKey, wires);
            return wires;
          })
          .finally(() => {
            if (staticReads.current.get(catalogKey) === promise)
              staticReads.current.delete(catalogKey);
          });
        staticReads.current.set(catalogKey, promise);
      }
      return staticReads.current.get(catalogKey);
    },
    [],
  );

  /** Apply a base-controls read unless a newer load or a restore replaced it. */
  const settleBase = useCallback(
    (mode, token) =>
      readBase(mode).then(
        (wires) => {
          if (!alive.current || baseToken.current !== token) return;
          const fresh = createEntries(cloneJson(wires), GROUP.base);
          publishEntries((prev) => [
            ...fresh,
            ...prev.filter((e) => e.group !== GROUP.base),
          ]);
          drawStandard();
          setBase({ status: 'ready', error: null });
          // Standard controls now exist, so a waiting idea can get its own.
          scheduleBackground();
        },
        (error) => {
          if (alive.current && baseToken.current === token)
            setBase({ status: 'error', error });
        },
      ),
    [readBase, scheduleBackground, publishEntries, drawStandard],
  );

  const loadBase = useCallback(
    (mode) => {
      const token = ++baseToken.current;
      setBase({ status: 'loading', error: null });
      return settleBase(mode, token);
    },
    [settleBase],
  );
  useEffect(() => {
    loadBaseRef.current = loadBase;
  }, [loadBase]);

  useEffect(() => {
    // The initial base status is already "loading".
    settleBase(initialMode.current, ++baseToken.current);
  }, [settleBase]);

  // A different provider choice makes in-flight and loaded prompt work stale.
  // Requests are cancelled and the generated controls' anchor is dropped, so
  // the next request asks the new providers; the draft, standard controls and
  // every selection and custom option stay as they are. An accepted job is
  // followed by its id alone and is not affected.
  const seenProvider = useRef(provider.id);
  useEffect(() => {
    if (seenProvider.current === provider.id) return;
    seenProvider.current = provider.id;
    cancelImport.current();
    writeRef(episode, { ...episode.current, suppressed: false });
    const wasLoading = live.current.dynamic.status === 'loading';
    flight.current?.controller.abort();
    flight.current = null;
    cancelAllExpansions();
    writeRef(live, { ...live.current, dynamic: idleDynamic });
    setDynamic(idleDynamic);
    if (wasLoading || live.current.draft.prompt.trim()) scheduleBackground();
  }, [provider.id, cancelAllExpansions, scheduleBackground]);

  // Adding, removing, reordering or describing a reference makes prompt work
  // for the previous set obsolete: requests stop, and generated controls are
  // marked as for an earlier set until they are refreshed (selections that
  // still fit are kept by the merge).
  const seenRefs = useRef('');
  useEffect(() => {
    if (seenRefs.current === refSignature) return;
    seenRefs.current = refSignature;
    if (episode.current.suppressed) return;
    if (flight.current && flight.current.refs !== refSignature) {
      flight.current.controller.abort();
      flight.current = null;
      setDynamic((prev) =>
        prev.status === 'loading'
          ? { ...prev, status: prev.anchor ? 'ready' : 'idle' }
          : prev,
      );
    }
    cancelAllExpansions();
    scheduleBackground();
  }, [refSignature, cancelAllExpansions, scheduleBackground]);

  // --- Draft edits ---------------------------------------------------------

  /** Put text in the prompt without starting any background work (import, restore). */
  const placePrompt = useCallback((prompt) => {
    touch();
    const next = { ...live.current.draft, prompt };
    writeRef(live, { ...live.current, draft: next });
    setDraft(next);
  }, []);

  /** A typed or chosen idea: controls follow it once it settles. */
  const changePrompt = useCallback(
    (prompt) => {
      writeRef(episode, { ...episode.current, suppressed: false });
      placePrompt(prompt);
      scheduleBackground();
      scheduleReconcile();
    },
    [placePrompt, scheduleBackground, scheduleReconcile],
  );

  /** Typing: consecutive edits within a short pause form one undo step. */
  const setPrompt = useCallback(
    (prompt) => {
      if (prompt === live.current.draft.prompt) return;
      recordDraft('Edit prompt', { coalesce: 'prompt' });
      changePrompt(prompt);
    },
    [recordDraft, changePrompt],
  );

  /** A suggested idea replaces the prompt in one step of its own. */
  const pickSuggestion = useCallback(
    (prompt) => {
      if (prompt === live.current.draft.prompt) return;
      recordDraft('Use idea');
      draftHistory.seal();
      changePrompt(prompt);
    },
    [recordDraft, changePrompt, draftHistory],
  );

  const setAspect = useCallback(
    (aspect) => {
      if (!['2:3', '3:2', '1:1'].includes(aspect)) return;
      if (aspect !== live.current.draft.aspect) recordDraft('Change aspect');
      savePreferredAspect(aspect);
      touch();
      setDraft((d) => ({ ...d, aspect }));
    },
    [savePreferredAspect, recordDraft],
  );

  /**
   * A generation-mode change is an intentional reset of prompt-specific
   * state. The caller records the undo step.
   */
  const applyMode = useCallback(
    (mode) => {
      touch();
      flight.current?.controller.abort();
      flight.current = null;
      submissionKey.current = null;
      cancelAllExpansions();
      replaceAdditionalMetadata();
      cancelImport.current();
      cancelPromptTimers();
      holdReveal(0);
      setRegionEdit(null);
      setRegionNotice(null);
      const { prompt } = live.current.draft;
      writeRef(episode, {
        workRevision: (episode.current.workRevision ?? 0) + 1,
        anchor: prompt.trim() ? promptKey(prompt, mode) : null,
        pending: true,
      });
      const next = { ...live.current.draft, mode };
      writeRef(live, {
        ...live.current,
        draft: next,
        entries: [],
        dynamic: idleDynamic,
      });
      setDraft(next);
      setEntries([]);
      setDynamic(idleDynamic);
      setNotice(null);
      loadBase(mode);
    },
    [
      loadBase,
      cancelAllExpansions,
      replaceAdditionalMetadata,
      cancelPromptTimers,
      holdReveal,
      setRegionEdit,
    ],
  );

  /**
   * The generation pipeline (image or asset image). In an edit it decides
   * which pipeline the edit uses; the references stay attached.
   */
  const setMode = useCallback(
    (mode) => {
      if (live.current.draft.mode === mode) return;
      recordDraft(
        mode === 'asset-image' ? 'Switch to asset image' : 'Switch to image',
      );
      applyMode(mode);
    },
    [applyMode, recordDraft],
  );

  /**
   * Choose Text to image, Edit or Asset image. Leaving Edit parks its
   * references (descriptors, proposal, bytes by id) and region selection, so
   * a text or asset request can never carry them; choosing Edit again puts
   * them back. Edit keeps the current pipeline, so no controls are reset;
   * Text and Asset change the pipeline like a mode change. One undo step.
   */
  const setKind = useCallback(
    (kind, { record = true } = {}) => {
      const now = live.current.draft;
      const from = draftKind(now, refsLive.current);
      if (!Object.values(DRAFT_KIND).includes(kind) || kind === from) return;
      // A mode gesture persists immediately, even while draft files are opening.
      savePreferredKind(kind);
      standardByKind.current.set(
        from,
        live.current.entries.filter((e) => e.group === GROUP.base),
      );
      if (record) {
        recordDraft(
          kind === DRAFT_KIND.edit
            ? 'Switch to edit'
            : kind === DRAFT_KIND.asset
              ? 'Switch to asset image'
              : 'Switch to text to image',
        );
        // A reference still being read belongs to the mode it was asked in.
        imageReferenceToken.current += 1;
        referenceAddToken.current += 1;
        referenceAddBatch.current = null;
        setReferenceReading(null);
      }
      touch();
      setNotice((shown) =>
        shown?.scope === NOTICE_SCOPE.draft ? null : shown,
      );
      if (kind === DRAFT_KIND.edit) {
        const held = parked.current;
        park(null);
        const next = { ...now, edit: true };
        writeRef(live, { ...live.current, draft: next });
        setDraft(next);
        if (held) {
          regionRestoreInProgress.current = true;
          restoreDraftReferences(held.refs, held.proposal, held.sources);
          regionRestoreInProgress.current = false;
          setRegionEdit(held.region ?? null);
          setRegionNotice(null);
        }
        const remembered = standardByKind.current.get(kind);
        baseToken.current += 1;
        publishEntries((entries) => [
          ...(remembered ?? []),
          ...entries.filter((e) => e.group !== GROUP.base),
        ]);
        if (remembered) setBase({ status: 'ready', error: null });
        else loadBase(next.mode);
        return;
      }
      if (from === DRAFT_KIND.edit) {
        const region = regionEditRef.current;
        const taken = parkReferences();
        park(
          taken || region
            ? {
                refs: taken?.refs ?? [],
                proposal: taken?.proposal ?? null,
                sources: taken?.sources ?? new Map(),
                region: region ?? null,
              }
            : null,
        );
        setRegionEdit(null);
        setRegionNotice(null);
        setRegionEditorBase(null);
      }
      const mode = kind === DRAFT_KIND.asset ? 'asset-image' : 'image';
      const next = { ...live.current.draft, edit: false };
      writeRef(live, { ...live.current, draft: next });
      setDraft(next);
      if (mode !== next.mode) applyMode(mode);
      const remembered = standardByKind.current.get(kind);
      baseToken.current += 1;
      publishEntries((entries) => [
        ...(remembered ?? []),
        ...entries.filter((e) => e.group !== GROUP.base),
      ]);
      if (remembered) setBase({ status: 'ready', error: null });
      else loadBase(mode);
    },
    [
      park,
      applyMode,
      recordDraft,
      parkReferences,
      restoreDraftReferences,
      setRegionEdit,
      loadBase,
      publishEntries,
      savePreferredKind,
    ],
  );

  const updateEntry = useCallback(
    (key, change) => {
      touch();
      publishEntries((prev) =>
        prev.map((e) => (e.key === key ? markIntent(change(e)) : e)),
      );
    },
    [publishEntries],
  );

  /**
   * A person's own change: it applies to an edit, and a control left to the
   * model is used again. More options and other automatic changes never
   * turn a control back on.
   */
  const chosen = (entry) => ({
    ...entry,
    explicit: true,
    applyToEdit: true,
    enabled: true,
  });
  /**
   * A choice made right after typing belongs to the prompt it follows: settle a
   * pending episode change first so the new episode cannot clear that choice.
   */
  const settleEpisode = useCallback(() => {
    if (!timers.current.reconcile) return;
    clearTimer('reconcile');
    reconcileAnchor();
  }, [clearTimer, reconcileAnchor]);
  /** Record a control change, named for the control it changes. */
  const recordEntry = useCallback(
    (key, verb, options) => {
      const entry = live.current.entries.find((e) => e.key === key);
      if (!entry) return false;
      recordDraft(verb(entry.wire?.label || 'control'), options);
      return true;
    },
    [recordDraft],
  );
  const editors = useMemo(
    () => ({
      setValue: (key, value) => {
        settleEpisode();
        // A slider drag or held key is one step per control.
        recordEntry(key, (label) => `Change ${label}`, {
          coalesce: `value:${key}`,
        });
        updateEntry(key, (e) => chosen(setValue(e, value)));
      },
      toggleOption: (key, option) => {
        settleEpisode();
        recordEntry(key, (label) => `Change ${label}`);
        updateEntry(key, (e) => chosen(toggleOption(e, option)));
      },
      addCustomOption: (key, text) => {
        settleEpisode();
        recordEntry(key, (label) => `Add a choice to ${label}`);
        const entry = live.current.entries.find((e) => e.key === key);
        if (!entry || addCustomOption(entry, text) === entry) return;
        updateEntry(key, (e) => chosen(addCustomOption(e, text)));
      },
      reset: (key) => {
        settleEpisode();
        recordEntry(key, (label) => `Reset ${label}`);
        updateEntry(key, (e) => ({
          ...resetEntry(e),
          explicit: false,
          applyToEdit: undefined,
        }));
      },
      /** Whether a control changes the edited image or keeps the source. */
      setApplyToEdit: (key, apply) => {
        settleEpisode();
        recordEntry(key, (label) =>
          apply === true ? `Apply ${label}` : `Keep ${label} from the source`,
        );
        updateEntry(key, (e) => ({ ...e, applyToEdit: apply === true }));
      },
      /** Whether a text request uses this control or leaves it to the model. */
      setEnabled: (key, on) => {
        settleEpisode();
        recordEntry(key, (label) =>
          on === true ? `Use ${label}` : `Leave ${label} to the model`,
        );
        updateEntry(key, (e) => ({ ...e, enabled: on === true }));
      },
      keepAllSources: () => {
        recordDraft('Keep everything from the source');
        touch();
        settleEpisode();
        publishEntries((prev) =>
          prev.map((e) => markIntent({ ...e, applyToEdit: false })),
        );
      },
      expand,
      remove: (key) => {
        if (
          !live.current.entries.some(
            (entry) => entry.key === key && entry.group === GROUP.generated,
          )
        )
          return;
        writeRef(episode, {
          ...episode.current,
          workRevision: (episode.current.workRevision ?? 0) + 1,
        });
        recordEntry(key, (label) => `Remove ${label}`);
        cancelExpansion(key);
        flight.current?.controller.abort();
        flight.current = null;
        touch();
        publishEntries((prev) =>
          prev.filter((e) => e.key !== key || e.group === GROUP.base),
        );
      },
      resetBase: () => {
        settleEpisode();
        recordDraft('Reset standard controls');
        touch();
        publishEntries((prev) =>
          prev.map((e) =>
            e.group === GROUP.base
              ? markIntent({
                  ...resetEntry(e),
                  explicit: false,
                  applyToEdit: undefined,
                  enabled: undefined,
                })
              : e,
          ),
        );
      },
    }),
    [
      updateEntry,
      publishEntries,
      expand,
      cancelExpansion,
      settleEpisode,
      recordEntry,
      recordDraft,
    ],
  );

  /**
   * Replace control entries in one undo step, keeping the prompt, references,
   * mode and aspect as they are (presets apply this way). `change` receives
   * the current entries and returns the next list; returning the same list
   * records nothing.
   * @param {string} label the step's name in Undo and Redo
   * @param {(entries: Array<object>) => Array<object>} change
   * @returns {boolean} whether the entries changed
   */
  const applyControlEntries = useCallback(
    (label, change) => {
      settleEpisode();
      const before = live.current.entries;
      const changed = change(before);
      if (!Array.isArray(changed) || changed === before) return false;
      if (
        changed.length === before.length &&
        changed.every((entry, index) => entry === before[index])
      )
        return false;
      const next = changed.map((entry) =>
        entry === before.find((e) => e.key === entry.key)
          ? entry
          : markIntent(entry),
      );
      recordDraft(label);
      touch();
      writeRef(live, { ...live.current, entries: next });
      setEntries(next);
      return true;
    },
    [settleEpisode, recordDraft],
  );

  /** An explicit draw changes values only, never application flags or other tools. */
  const randomizeBase = useCallback(() => {
    if (live.current.draft.edit || refsLive.current.length) return false;
    return applyControlEntries('Randomize standard controls', (entries) =>
      randomizeStandard(entries).map((entry, index) => {
        const before = entries[index];
        // Free text and unknown kinds have no useful random alternative.
        if (
          before.wire.kind === 'text-input' ||
          JSON.stringify(entry.wire.value) === JSON.stringify(before.wire.value)
        )
          return before;
        return {
          ...entry,
          explicit: true,
          enabled: before.enabled,
          applyToEdit: before.applyToEdit,
        };
      }),
    );
  }, [applyControlEntries]);

  // --- Submission and job tracking -----------------------------------------

  const keepExact = useCallback((record) => {
    const next = rememberExact(exactRef.current, record, pinnedKeys.current);
    exactRef.current = next;
    setExact(next);
  }, []);

  /** A person moved on: a selection still being read no longer applies. */
  const cancelPick = useCallback(() => {
    pickRun.current.token += 1;
    pickRun.current.controller?.abort();
    pickRun.current.controller = null;
    setRestoring(null);
    setGenerationReveal((pending) =>
      pending && !pending.consumed ? { ...pending, consumed: true } : pending,
    );
  }, []);

  /**
   * Put back a snapshot's Standard controls when it was taken while they
   * were still loading. The snapshot's own mode decides the catalog; a newer
   * load, restore or mode change wins. No prompt work follows, unlike an
   * ordinary load: undo only brings back what the person had.
   */
  const recoverBase = useCallback(
    (mode) => {
      const token = ++baseToken.current;
      const place = (wires) => {
        const fresh = createEntries(cloneJson(wires), GROUP.base);
        const next = [
          ...fresh,
          ...live.current.entries.filter((e) => e.group !== GROUP.base),
        ];
        writeRef(live, { ...live.current, entries: next });
        setEntries(next);
        setBase({ status: 'ready', error: null });
      };
      const cached = staticCache.current.get(
        live.current.draft.edit ? 'edit' : mode,
      );
      if (cached) {
        place(cached);
        return;
      }
      setBase({ status: 'loading', error: null });
      readBase(mode, { fresh: true }).then(
        (wires) => {
          if (
            alive.current &&
            baseToken.current === token &&
            live.current.draft.mode === mode
          )
            place(wires);
        },
        (error) => {
          if (alive.current && baseToken.current === token)
            setBase({ status: 'error', error });
        },
      );
    },
    [readBase],
  );

  /**
   * Restore editable state only; accepted jobs and saved records keep their
   * owners. A frozen request stays: the same content submitted again reuses
   * its key, files and providers, so it cannot save a second image. Work
   * started for the replaced draft (reads, base attachments, prompt work)
   * can no longer change the restored one, and restoring starts none.
   */
  const restoreDraftSnapshot = useCallback(
    (snapshot) => {
      cancelPick();
      rev.current.pick += 1;
      touch();
      baseToken.current += 1;
      imageReferenceToken.current += 1;
      referenceAddToken.current += 1;
      referenceAddBatch.current = null;
      setReferenceReading(null);
      flight.current?.controller.abort();
      flight.current = null;
      cancelAllExpansions();
      cancelImport.current();
      cancelPromptTimers();
      holdReveal(0);
      const restoredDraft = {
        ...snapshot.draft,
        edit: Boolean(snapshot.draft.edit || snapshot.refs?.length),
        mustHaveTerms: [...(snapshot.draft.mustHaveTerms ?? [])],
      };
      const restoredEntries = snapshot.entries ?? [];
      standardByKind.current = new Map(snapshot.standardByKind ?? []);
      const restoredDynamic = snapshot.dynamic ?? idleDynamic;
      setRegionEdit(snapshot.regionEdit ?? null);
      setRegionNotice(null);
      writeRef(episode, {
        ...snapshot.episode,
        suppressed: true,
        workRevision: (episode.current.workRevision ?? 0) + 1,
      });
      derivedPrompt.current = snapshot.derivedPrompt ?? null;
      replaceAdditionalMetadata(snapshot.additionalMetadata ?? []);
      writeRef(live, {
        ...live.current,
        draft: restoredDraft,
        entries: restoredEntries,
        dynamic: restoredDynamic,
      });
      setDraft(restoredDraft);
      setEntries(restoredEntries);
      setDynamic(restoredDynamic);
      setBasedOn(snapshot.basedOn ?? null);
      // Only what described the replaced draft goes; job and library notices stay.
      setNotice((shown) =>
        shown?.scope === NOTICE_SCOPE.draft ? null : shown,
      );
      if (restoredEntries.some((entry) => entry.group === GROUP.base))
        setBase({ status: 'ready', error: null });
      else recoverBase(restoredDraft.mode);
      // Bytes parked now or in the snapshot fill the same ids again.
      const sources = new Map([
        ...(snapshot.parked?.sources ?? []),
        ...(parked.current?.sources ?? []),
      ]);
      park(snapshot.parked);
      const restoredRefs = restoreDraftReferences(
        snapshot.refs ?? [],
        snapshot.proposal ?? null,
        sources,
      );
      // The restored set is already current: it is not a change that asks
      // for new controls. Bytes found later keep the same signature.
      seenRefs.current = referenceSignature(restoredRefs ?? []);
      publishHistory();
    },
    [
      park,
      cancelPick,
      cancelAllExpansions,
      cancelPromptTimers,
      holdReveal,
      replaceAdditionalMetadata,
      recoverBase,
      restoreDraftReferences,
      publishHistory,
      setRegionEdit,
    ],
  );

  const stepDraftHistory = useCallback(
    (direction) => {
      const step = draftHistory[direction](captureDraft());
      if (!step) return false;
      restoreDraftSnapshot(step.snapshot);
      setHistoryStep({ direction, label: step.label, key: Date.now() });
      publishHistory();
      return true;
    },
    [captureDraft, draftHistory, restoreDraftSnapshot, publishHistory],
  );

  const select = useCallback(
    (id) => {
      cancelPick();
      rev.current.pick += 1;
      setGenerating(null);
      setStageCleared(false);
      setCurrentId(id);
    },
    [cancelPick],
  );

  /** Observe an accepted job to its end; a completed job becomes a saved image. */
  const follow = useCallback(
    async (accepted) => {
      const run = ++trackRun.current;
      // One observer at a time: starting another closes the previous stream.
      trackAbort.current?.abort();
      const controller = new AbortController();
      trackAbort.current = controller;
      const pickAtStart = rev.current.pick;
      const final = await observeJob({
        job: accepted,
        fetchStatus: (id) => api.generationJob(id),
        onUpdate: (next) => {
          setJob(next);
          dispatchLedger({ type: 'observed', job: next });
        },
        isCurrent: () => alive.current && trackRun.current === run,
        signal: controller.signal,
        policy: observerPolicy,
      });
      // A job whose status was lost may still finish: the stage keeps waiting.
      if (final.phase !== PHASE.lost) setGenerating(null);
      if (final.phase !== PHASE.complete) return final.phase;
      const record = libraryRecordFromResult(final.result);
      const key = imageKey(record);
      dispatchLedger({ type: 'stored', jobId: accepted.id, record });
      const toPrivate = live.current.source === SOURCE.PRIVATE;
      if (!toPrivate) keepExact(record);
      if (toPrivate) addPrivate(record, { origin: LOCAL_ORIGIN.GENERATED });
      else insertImage(record);
      // The item the person already has selected is this job's own: it becomes
      // the saved image in place and is not "another" image taking over.
      const selectedHere = selection.current.currentId === jobKey(accepted.id);
      if (rev.current.pick === pickAtStart || selectedHere) {
        setStageCleared(false);
        setCurrentId(key);
        setGenerationReveal({
          key: jobKey(accepted.id),
          selectionKey: key,
          record,
        });
        setBasedOn(key);
      } else {
        // The person chose another image meanwhile; do not take it from them.
        setNotice({
          tone: 'info',
          text: 'A new image finished.',
          actionLabel: 'View',
          onAction: () => {
            select(key);
            setBasedOn(key);
            setNotice(null);
          },
        });
      }
      if (!toPrivate) reloadImages();
      return final.phase;
    },
    [observerPolicy, insertImage, reloadImages, select, addPrivate, keepExact],
  );

  /**
   * A finished child of a variation group becomes an ordinary saved image.
   * The stage moves to the group's first result only while the person has
   * not chosen anything since submitting; a child they selected while it was
   * pending becomes its saved image in place. Later siblings never take the
   * selection or touch the draft.
   */
  const deliverVariation = useCallback(
    (result, slot, group) => {
      const record = libraryRecordFromResult(result);
      const key = imageKey(record);
      dispatchLedger({ type: 'stored', jobId: slot.jobId, record });
      const toPrivate = live.current.source === SOURCE.PRIVATE;
      if (!toPrivate) keepExact(record);
      if (toPrivate) addPrivate(record, { origin: LOCAL_ORIGIN.GENERATED });
      else insertImage(record);
      const selectedHere = selection.current.currentId === jobKey(slot.jobId);
      const first =
        !group.selected &&
        !group.recovered &&
        rev.current.pick === group.pickAtStart;
      if (selectedHere || first) {
        setStageCleared(false);
        setCurrentId(key);
        setGenerationReveal({
          key: jobKey(slot.jobId),
          selectionKey: key,
          record,
        });
      }
      if (first) {
        setBasedOn(key);
        setGenerating(null);
      }
      if (!toPrivate) reloadImages();
      return { selected: first };
    },
    [insertImage, reloadImages, addPrivate, keepExact],
  );

  const settleVariations = useCallback(
    (group) => {
      if (group.recovered) return;
      if (!group.lost) setGenerating(null);
      if (group.selected || group.lost) return;
      // The person chose another image meanwhile: offer, do not take over.
      const done = group.slots.filter((s) => s.job?.phase === PHASE.complete);
      if (!done.length) return;
      const key = imageKey(libraryRecordFromResult(done[0].job.result));
      setNotice({
        tone: 'info',
        text:
          done.length === 1
            ? 'A new image finished.'
            : `${done.length} new images finished.`,
        actionLabel: 'View',
        onAction: () => {
          select(key);
          setBasedOn(key);
          setNotice(null);
        },
      });
    },
    [select],
  );

  const replaceVariationJobs = useCallback((replaced, group) => {
    for (const { previous, jobId } of replaced) {
      // A retried slot's item is replaced by its new attempt. One still shown
      // as pending (its failure was never observed) is settled first.
      if (previous) {
        dispatchLedger({
          type: 'observed',
          job: { id: previous, phase: PHASE.failed, error: null },
        });
        dispatchLedger({ type: 'dismiss', jobId: previous });
      }
      if (group.frozen)
        dispatchLedger({ type: 'accepted', jobId, body: group.frozen.body });
    }
  }, []);

  const variations = useVariationGroup({
    capability: variationCap,
    policy: observerPolicy,
    source:
      library.source === SOURCE.PRIVATE || library.source === SOURCE.SHARED
        ? library.source
        : null,
    setJob,
    admission: (count) =>
      live.current.source === SOURCE.PRIVATE
        ? privateAdmissionBlock('retrying', null, count)
        : null,
    handlers: {
      observed: (next) => dispatchLedger({ type: 'observed', job: next }),
      replaced: replaceVariationJobs,
      delivered: deliverVariation,
      settled: settleVariations,
    },
  });
  const {
    start: startVariations,
    retry: retryGroup,
    resume: resumeGroup,
  } = variations;

  /**
   * Send one frozen request and follow its job. Resolves true while a lost
   * job may still finish. A network failure keeps the frozen request, so a
   * retry repeats it exactly; any other answer releases it.
   */
  const dispatch = useCallback(
    async (frozen, body) => {
      const snapshot = Object.freeze({ revision: rev.current.draft, body });
      setJob({ ...newJob(PHASE.sending), snapshot });
      let accepted;
      try {
        const payload = { ...body, idempotency_key: frozen.key };
        accepted = await api.generateImage(
          frozen.files ? buildEditForm(payload, frozen.files) : payload,
          providerRequest(frozen.providerHeader),
        );
      } catch (error) {
        if (!error.network) submissionKey.current = null;
        const count = body.variation_count ?? 1;
        setJob({
          ...newJob(PHASE.failed),
          snapshot,
          // A refused group started nothing: all of it or none is accepted.
          error:
            error.status === 429 && count > 1
              ? `${error.message} None of the ${count} images were started.`
              : error.message,
          details: error.details,
          diagnostic: preserveError(error).diagnostic,
        });
        return false;
      }
      submissionKey.current = null;
      if (typeof accepted?.generation_job_id !== 'string') {
        setJob({
          ...newJob(PHASE.failed),
          snapshot,
          error: 'The API did not return a job id.',
          diagnostic: localDiagnostic({
            category: 'validation',
            reason: 'The generation response had no job id.',
            data: accepted,
          }),
        });
        return false;
      }
      promptHistory.current = [
        ...promptHistory.current.filter((p) => p !== body.prompt),
        body.prompt,
      ].slice(-PROMPT_HISTORY_LIMIT - 1);
      const initial = {
        ...newJob(PHASE.accepted, accepted.generation_job_id),
        snapshot,
      };
      // The provisional item exists from acceptance, with the exact request
      // and the result it will replace as context.
      const shown = selection.current.current;
      const previous = isPendingItem(shown)
        ? shown.client_pending.previous
        : shown;
      const group = (body.variation_count ?? 1) > 1 ? accepted : null;
      const following = group
        ? startVariations(group, frozen, { pickAtStart: rev.current.pick })
        : null;
      if (following) {
        // Each child is its own provisional item; only the first carries the
        // result it replaces, so the strip does not repeat that picture.
        [...accepted.variation_group.jobs]
          .sort((a, b) => b.index - a.index)
          .forEach((child) =>
            dispatchLedger({
              type: 'accepted',
              jobId: child.generation_job_id,
              body,
              previous: child.index === 0 ? previous : null,
            }),
          );
        return Boolean((await following)?.lost);
      }
      dispatchLedger({
        type: 'accepted',
        jobId: accepted.generation_job_id,
        body,
        previous,
      });
      if (group)
        setNotice({
          tone: 'info',
          text: 'The server accepted one image instead of a group.',
        });
      setJob(initial);
      return (await follow(initial)) === PHASE.lost;
    },
    [follow, startVariations],
  );

  /**
   * The one submission lifecycle (button, Enter, retry and description import).
   * `skipDynamic` sends the standard controls only, without fetching
   * prompt-specific ones; it applies to this submission alone.
   */
  const runSubmission = useCallback(
    async ({
      skipDynamic = false,
      explicit = false,
      singleImage = false,
    } = {}) => {
      const first = live.current;
      if (
        !first.draft.prompt.trim() ||
        submitting.current ||
        isActive(first.job)
      )
        return;
      if (!singleImage) cancelImport.current();
      // An explicit action leaves its error where the person can reach it.
      const reveal = (target) =>
        explicit && setScrollRequest((r) => ({ id: (r?.id ?? 0) + 1, target }));
      const blocked = submitBlockReason({
        discovery: first.discovery,
        draft: first.draft,
      });
      if (blocked) {
        setNotice({ tone: 'error', text: blocked, scope: NOTICE_SCOPE.draft });
        reveal('notice');
        return;
      }
      const limit = effectiveControlLimit(
        first.discovery.capabilities.data?.control_generation?.max_controls,
      );
      if (first.entries.length > limit) {
        setNotice({
          tone: 'error',
          text: overLimitMessage(first.entries.length, limit),
          scope: NOTICE_SCOPE.draft,
        });
        reveal('notice');
        return;
      }
      // Private results need a place to be kept if they cannot be stored. The
      // check precedes every provider call, controls generation included.
      // The count is the one this explicit action authorized; a group
      // reserves a place for every image it asks for.
      const count = singleImage
        ? 1
        : allowedCount(first.variationCount, first.variationCap);
      const poolBlock =
        first.source === SOURCE.PRIVATE
          ? privateAdmissionBlock('generating', null, count)
          : null;
      if (poolBlock) {
        const oldest = oldestUnsavedPrivate();
        setNotice({
          tone: 'error',
          text: poolBlock,
          ...(oldest
            ? {
                actionLabel: 'View',
                onAction: () => {
                  select(oldest);
                  setNotice(null);
                },
              }
            : {}),
        });
        reveal('notice');
        return;
      }
      // References must be exact and complete; there is no text-only
      // fallback, and an edit without one is refused, never sent as text.
      const refBlock = editBlockReason(
        first.draft.edit,
        refsLive.current,
        first.editCapability,
      );
      if (refBlock) {
        setNotice({ tone: 'error', text: refBlock, scope: NOTICE_SCOPE.draft });
        reveal('notice');
        return;
      }
      const requestedRegion = first.regionEdit ?? null;
      const requestedRegionKey = JSON.stringify(requestedRegion);
      const regionBlock = regionSubmissionProblem(
        requestedRegion,
        refsLive.current,
        first.discovery.capabilities.data?.region_editing,
      );
      if (regionBlock) {
        setNotice({
          tone: 'error',
          text: regionBlock,
          scope: NOTICE_SCOPE.draft,
        });
        reveal('notice');
        return;
      }
      // What is submitted is this draft, not a selection still being read.
      cancelPick();
      // A prompt that left its episode starts over before anything is sent.
      syncEpisode();
      const start = live.current;
      let workRevision = episode.current.workRevision ?? 0;
      const { draft: d } = start;
      submitting.current = true;
      let waiting = false;
      try {
        const key = promptKey(d.prompt, d.mode);
        setNotice(null);
        // The earlier image leaves the stage as soon as the person submits.
        // The stage shows what is requested: an edit's framing follows its
        // base, so the provider size nearest the base's shape, not its pixels.
        const framing = requestFraming(
          d,
          refsLive.current,
          start.discovery.models.data,
        );
        setGenerating({
          aspect: framing.aspect,
          mode: d.mode,
          edit: Boolean(d.edit),
          dimensions: framing.dimensions,
        });
        setJob(newJob(skipDynamic ? PHASE.sending : PHASE.preparing));
        reveal('stage');

        // One submission may fetch controls, then render. A bounded failure falls
        // back to the standard controls with a notice.
        for (let pass = 0; !skipDynamic && pass < 2; pass += 1) {
          try {
            const preparation = requestDynamic();
            // Starting this preparation may initialize its own prompt episode.
            // Freeze after that synchronous work, before waiting for a reply;
            // later user changes still invalidate the suspended submission.
            if (pass === 0) workRevision = episode.current.workRevision ?? 0;
            const { stale, refused, error } = await preparation;
            if (
              (episode.current.workRevision ?? 0) !== workRevision ||
              !alive.current
            ) {
              if (alive.current) setJob(null);
              return;
            }
            if (refused && refused !== 'capacity') throw error;
            if (refused === 'capacity') {
              setJob(null);
              setNotice({
                tone: 'error',
                text: error.message,
                error: preserveError(error),
                scope: NOTICE_SCOPE.draft,
              });
              reveal('notice');
              return;
            }
            const now = live.current.draft;
            if (!stale || promptKey(now.prompt, now.mode) !== key) break;
          } catch (error) {
            if (!live.current.entries.length) {
              setJob(null);
              setNotice(
                failureNotice(
                  'No controls are available. Reload the standard controls, then try again.',
                  error,
                ),
              );
              reveal('notice');
              return;
            }
            setNotice({
              tone: 'info',
              text: 'Options for this idea could not be generated. The standard controls are used instead.',
              error: preserveError(error),
              details: error.details ?? error.message,
            });
            break;
          }
        }

        if (
          episode.current.pending &&
          !episode.current.suppressed &&
          !refsLive.current.length &&
          !live.current.entries.some((entry) => entry.group === GROUP.base)
        ) {
          try {
            const wires = await readBase(d.mode);
            if (
              promptKey(live.current.draft.prompt, live.current.draft.mode) ===
                key &&
              !live.current.entries.some((entry) => entry.group === GROUP.base)
            ) {
              publishEntries((entries) => [
                ...createEntries(cloneJson(wires), GROUP.base),
                ...entries,
              ]);
              drawStandard();
            }
          } catch {
            /* Existing no-controls validation reports unreadable catalogs. */
          }
        }
        if (
          (episode.current.workRevision ?? 0) !== workRevision ||
          !alive.current
        ) {
          if (alive.current) setJob(null);
          return;
        }
        settleStandards();
        const after = live.current;
        const refs = refsLive.current;
        const limit = effectiveControlLimit(
          after.discovery.capabilities.data?.control_generation?.max_controls,
        );
        if (after.entries.length > limit) {
          setJob(null);
          setNotice({
            tone: 'error',
            text: overLimitMessage(after.entries.length, limit),
            scope: NOTICE_SCOPE.draft,
          });
          reveal('notice');
          return;
        }
        if (Boolean(after.draft.edit) !== Boolean(d.edit)) {
          setJob(null);
          setNotice({
            tone: 'info',
            text: 'The mode changed while options were prepared. Submit again to use it.',
            scope: NOTICE_SCOPE.draft,
          });
          reveal('notice');
          return;
        }
        const lateBlock = editBlockReason(
          after.draft.edit,
          refs,
          after.editCapability,
        );
        if (lateBlock) {
          setJob(null);
          setNotice({
            tone: 'error',
            text: lateBlock,
            scope: NOTICE_SCOPE.draft,
          });
          reveal('notice');
          return;
        }
        if (promptKey(after.draft.prompt, after.draft.mode) !== key) {
          setJob(null);
          setNotice({
            tone: 'info',
            text: 'The idea changed while options were prepared. Submit again to use it.',
            scope: NOTICE_SCOPE.draft,
          });
          reveal('notice');
          return;
        }
        if (JSON.stringify(after.regionEdit ?? null) !== requestedRegionKey) {
          setJob(null);
          setNotice({
            tone: 'info',
            text: 'The region selection changed while options were prepared. Submit again to use it.',
            scope: NOTICE_SCOPE.draft,
          });
          reveal('notice');
          return;
        }
        const submission = buildSubmission({
          draft: after.draft,
          entries: after.entries,
          dynamic: after.dynamic,
          additionalMetadata: after.additionalMetadata,
          dynamicCurrent:
            after.dynamic.status === 'ready' && identityMatches(after.dynamic),
          // An edit requests the size nearest its base's shape; the draft's
          // aspect stays the preference for text and asset requests.
          dimensions: requestFraming(
            after.draft,
            after.draft.edit ? refs : [],
            after.discovery.models.data,
          ).dimensions,
          // Only an edit sends references; text and asset requests never do.
          references: after.draft.edit ? refs : [],
          regionEdit: after.draft.edit ? requestedRegion : null,
          regionCapability: after.discovery.capabilities.data?.region_editing,
          textFlags: controlApplicationSupported(
            after.discovery.capabilities.data,
          ),
        });
        if (submission.error) {
          setJob(null);
          setNotice({
            tone: 'error',
            text: submission.error,
            scope: NOTICE_SCOPE.draft,
          });
          reveal('notice');
          return;
        }
        // One image keeps the request exactly as before; a group adds only
        // its count, which is also part of what identifies the request.
        const sentCount = allowedCount(
          count,
          variationCapability(after.discovery.capabilities.data),
        );
        const body =
          sentCount > 1
            ? { ...submission.body, variation_count: sentCount }
            : submission.body;
        const fingerprint =
          sentCount > 1 ? JSON.stringify(body) : submission.fingerprint;

        // The same request retried after an ambiguous network failure reuses its
        // key, so it cannot create a second saved image.
        // The provider choice is frozen with the key: a retry of this request
        // goes to the same providers whatever the settings say by then. An
        // edit also freezes its files, in order, with the descriptors.
        if (submissionKey.current?.fingerprint !== fingerprint)
          submissionKey.current = {
            fingerprint,
            key: newKey(),
            providerHeader: live.current.provider.header,
            body,
            files:
              after.draft.edit && refs.length
                ? refs.map((ref) => ({ blob: ref.blob, name: ref.name }))
                : null,
          };
        waiting = await dispatch(submissionKey.current, body);
      } finally {
        submitting.current = false;
        if (!waiting) setGenerating(null);
      }
    },
    [
      dispatch,
      requestDynamic,
      readBase,
      publishEntries,
      drawStandard,
      settleStandards,
      identityMatches,
      syncEpisode,
      privateAdmissionBlock,
      oldestUnsavedPrivate,
      select,
      cancelPick,
    ],
  );

  // Only Generate, Regenerate and Enter pass `explicit`; they may move the page.
  const submit = useCallback(
    (options) => runSubmission({ explicit: options?.explicit === true }),
    [runSubmission],
  );

  /**
   * Retry exactly a group's failed slots (an explicit action). Not while
   * another submission is being sent or any job is still being made.
   */
  const retryVariations = useCallback(async () => {
    const { job: shown } = live.current;
    if (submitting.current || (isActive(shown) && !shown.group)) return;
    submitting.current = true;
    try {
      setNotice(null);
      await retryGroup();
    } finally {
      submitting.current = false;
    }
  }, [retryGroup]);

  /** Check a group's status again after it was lost. Never resubmits. */
  const resumeVariations = useCallback(async () => {
    if (submitting.current) return;
    submitting.current = true;
    try {
      await resumeGroup();
    } finally {
      submitting.current = false;
    }
  }, [resumeGroup]);

  /**
   * Retry after a failure. An edit whose answer was lost in the network is
   * sent again exactly as frozen (key, files, descriptors and providers), so
   * later reference or settings changes cannot alter it. Anything else
   * submits the current draft.
   */
  const retry = useCallback(async () => {
    const frozen = submissionKey.current;
    const { job: failed } = live.current;
    // A group retries its failed slots only, with its own frozen request.
    if (failed?.group) return retryVariations();
    // A network failure is ambiguous for every request, not just image edits.
    // Re-send the original body/key/provider snapshot even if the draft or
    // variation count changed while the answer was missing.
    if (!frozen || failed?.phase !== PHASE.failed || submitting.current)
      return runSubmission();
    submitting.current = true;
    let waiting = false;
    try {
      setNotice(null);
      waiting = await dispatch(frozen, frozen.body);
    } finally {
      submitting.current = false;
      if (!waiting) setGenerating(null);
    }
    return undefined;
  }, [dispatch, runSubmission, retryVariations]);

  /** Resume observing a job whose polling gave up. Never resubmits it. */
  const resumeTracking = useCallback(async () => {
    const { job: lost } = live.current;
    if (lost?.group) {
      await resumeVariations();
      return;
    }
    if (lost?.phase !== PHASE.lost || submitting.current) return;
    submitting.current = true;
    try {
      const resumed = { ...lost, phase: PHASE.running, error: null };
      setJob(resumed);
      await follow(resumed);
    } finally {
      submitting.current = false;
    }
  }, [follow, resumeVariations]);

  // --- Saved images ----------------------------------------------------------

  /** Replace the draft with a saved or imported snapshot and select it. */
  const applyRestore = useCallback(
    (image, label = 'Open image settings') => {
      // An earlier draft can be brought back; an untouched one is not a step.
      if (
        !pristineDraft(captureDraft(), {
          ...blankDraft,
          aspect: preferredAspect,
          ...kindFields(preferredKind),
        })
      )
        recordDraft(label);
      touch();
      flight.current?.controller.abort();
      flight.current = null;
      baseToken.current += 1;
      submissionKey.current = null;
      cancelAllExpansions();
      replaceAdditionalMetadata(recordAdditionalMetadata(image));
      cancelPromptTimers();
      holdReveal(0);
      const mode =
        image.generation_mode === 'trellis' || image.mode === 'asset-image'
          ? 'asset-image'
          : 'image';
      // The saved record is never changed: only this editable draft is brought
      // up to the current catalog, at once when it is known, else when it loads.
      const isEdit =
        recordReferences(image).length > 0 ||
        image.generation_type === 'image-edit';
      const catalog = staticCache.current.get(isEdit ? 'edit' : mode);
      standardByKind.current.clear();
      const plain = catalog
        ? upgradeFixedEntries(entriesFromRecord(image), catalog)
        : entriesFromRecord(image);
      // A saved edit brings back its ordered references and which controls
      // applied; any other snapshot has no references.
      writeRef(episode, { ...episode.current, suppressed: true });
      const recorded = recordReferences(image);
      setRegionEdit(image.region_edit ?? null);
      setRegionNotice(null);
      const restored = isEdit ? withRecordedEdit(plain) : plain;
      // The restored image decides the mode: a saved edit is an edit. Work
      // and parked references of the replaced draft stay in its undo step.
      park(null);
      imageReferenceToken.current += 1;
      setReferenceReading(null);
      if (recorded.length) {
        regionRestoreInProgress.current = true;
        restoreReferences(recorded);
        regionRestoreInProgress.current = false;
      } else clearReferences();
      const size = describeImage(image).requestedSize ??
        describeImage(image).size ?? { width: 0, height: 0 };
      const prompt = image.original_prompt ?? image.prompt ?? '';
      // A restored draft is its own episode: nothing is randomized or cleared.
      writeRef(episode, {
        workRevision: (episode.current.workRevision ?? 0) + 1,
        anchor: promptKey(prompt, mode),
        pending: false,
        suppressed: true,
      });
      const supported =
        live.current.discovery.models.data?.supported_dimensions;
      const aspect = nearestAspect(size.width, size.height, supported);
      const restoredDraft = {
        prompt,
        mode,
        edit: isEdit,
        aspect,
        mustHaveTerms: Array.isArray(image.must_have_terms)
          ? [...image.must_have_terms]
          : [],
      };
      writeRef(live, {
        ...live.current,
        draft: restoredDraft,
        entries: restored,
      });
      setDraft(restoredDraft);
      setEntries(restored);
      setBase(
        restored.some((e) => e.group === GROUP.base)
          ? { status: 'ready', error: null }
          : { status: 'idle', error: null },
      );
      const restoredDynamic = restored.some((e) => e.group === GROUP.generated)
        ? {
            status: 'ready',
            anchor: promptKey(prompt, mode),
            provider: live.current.provider.id,
            refs: referenceSignature(recorded),
            metadata: image.dynamic_controls_metadata ?? null,
            error: null,
          }
        : idleDynamic;
      writeRef(live, { ...live.current, dynamic: restoredDynamic });
      setDynamic(restoredDynamic);
      setNotice(null);
      select(imageKey(image));
      setBasedOn(imageKey(image));
      setJob((j) => (isActive(j) ? j : null));
      if (!catalog) {
        // Merge-only on the CURRENT entries, so edits made meanwhile survive;
        // a newer restore, mode change or new draft moves the base token.
        const token = baseToken.current;
        readBase(mode).then(
          (wires) => {
            if (!alive.current || baseToken.current !== token) return;
            publishEntries((prev) => upgradeFixedEntries(prev, wires));
          },
          () => {}, // The draft stays exactly as saved when the catalog is unreadable.
        );
      }
    },
    [
      park,
      select,
      readBase,
      cancelAllExpansions,
      replaceAdditionalMetadata,
      cancelPromptTimers,
      holdReveal,
      restoreReferences,
      clearReferences,
      publishEntries,
      captureDraft,
      recordDraft,
      setRegionEdit,
      preferredAspect,
      preferredKind,
    ],
  );

  /**
   * Choose an image for the draft. An exact record applies at once and in one
   * step. Anything else is only a reference to one: its record is read first,
   * and the prompt, controls, metadata, mode, size and stage then change
   * together. The newest choice wins and an edit made meanwhile is kept.
   */
  const restoreSelected = useCallback(
    async (image) => {
      if (privateCreateRoute && Number.isFinite(image?.local_added_at)) {
        cancelPick();
        rev.current.pick += 1;
        const run = pickRun.current.token;
        const controller = new AbortController();
        pickRun.current.controller = controller;
        const key = imageKey(image);
        const revision = rev.current.draft;
        setRestoring(key);
        const currentPick = () =>
          alive.current && pickRun.current.token === run;
        try {
          const held = privateHistory.items.find(
            (item) =>
              imageKey(item) === key &&
              item.local_added_at === image.local_added_at &&
              item.local_storage?.state !== 'stored',
          );
          const record = held ?? (await exactPrivateCreate(image));
          if (!currentPick()) return false;
          pickRun.current.controller = null;
          setRestoring(null);
          if (!record) {
            setNotice({ tone: 'info', text: DETAIL_GONE });
            loadPrivateCreate({ direction: 'refresh' });
            return false;
          }
          pinPrivateCreateRole('draft-base', record);
          keepExact(record);
          if (rev.current.draft !== revision) {
            setNotice({ tone: 'info', text: DETAIL_SUPERSEDED });
            return false;
          }
          applyRestore(record);
          return true;
        } catch (error) {
          if (aborted(error) || !currentPick()) return false;
          pickRun.current.controller = null;
          setRestoring(null);
          setNotice({
            ...failureNotice(DETAIL_FAILED, error),
            actionLabel: 'Retry',
            onAction: () => {
              setNotice(null);
              restoreRef.current?.(image);
            },
          });
          return false;
        }
      }
      const held = exactRef.current.get(imageKey(image));
      const ready = isExactRecord(image) ? image : (held ?? null);
      cancelPick();
      if (ready) {
        if (!ready.client_pending && !isLocalOnly(ready)) keepExact(ready);
        applyRestore(ready);
        return true;
      }
      // The choice counts from now, so no automatic restore can replace it.
      rev.current.pick += 1;
      const run = pickRun.current.token;
      const controller = new AbortController();
      pickRun.current.controller = controller;
      const key = imageKey(image);
      const revision = rev.current.draft;
      setRestoring(key);
      const current = () => alive.current && pickRun.current.token === run;
      try {
        const record = await loadRecord(image, {
          signal: controller.signal,
        });
        if (!current()) return false;
        pickRun.current.controller = null;
        setRestoring(null);
        keepExact(record);
        if (rev.current.draft !== revision) {
          setNotice({ tone: 'info', text: DETAIL_SUPERSEDED });
          return false;
        }
        applyRestore(record);
        return true;
      } catch (error) {
        if (aborted(error) || !current()) return false;
        pickRun.current.controller = null;
        setRestoring(null);
        if (error.status === HTTP_NOT_FOUND) {
          setNotice({ tone: 'info', text: DETAIL_GONE });
          reloadImages();
        } else
          setNotice({
            ...failureNotice(DETAIL_FAILED, error),
            actionLabel: 'Retry',
            onAction: () => {
              setNotice(null);
              restoreRef.current?.(image);
            },
          });
        return false;
      }
    },
    [
      applyRestore,
      cancelPick,
      keepExact,
      loadRecord,
      reloadImages,
      privateCreateRoute,
      exactPrivateCreate,
      loadPrivateCreate,
      pinPrivateCreateRole,
      privateHistory.items,
    ],
  );
  useEffect(() => {
    restoreRef.current = restoreSelected;
  }, [restoreSelected]);

  // --- Import (analysis only: nothing is added to the library) ----------------

  /**
   * A snapshot read from an image: select the matching image, else keep the
   * imported file in this browser's history and Library view, never on the server.
   */
  const applyImportedMetadata = useCallback(
    (record, previewUrl, file) => {
      const known =
        findByIdentity(live.current.savedImages, record) ??
        findByIdentity(live.current.privateItems, record);
      if (known) {
        restoreSelected(known);
        if (known.local_origin === LOCAL_ORIGIN.IMPORTED)
          return 'Restored from the imported image already in history.';
        return isLocalOnly(known)
          ? 'Restored from the matching image in this browser.'
          : 'Restored from the matching saved image.';
      }
      const local = addPrivate(record, {
        origin: LOCAL_ORIGIN.IMPORTED,
        blob: file,
        url: previewUrl,
      });
      // The pool filled after the file was admitted to analysis: the draft and
      // history stay as they were and the file on disk is untouched.
      if (!local) throw new ImportRefusedError(IMPORT_NOT_KEPT_MESSAGE);
      applyRestore(local, 'Load image');
      return 'Restored the settings from the image. It is listed in this browser only and is not saved to the shared library.';
    },
    [applyRestore, addPrivate, restoreSelected],
  );

  /** Import supplies a draft prompt. Creating an image remains an explicit action. */
  const applyImportedDescription = useCallback(
    (prompt) => {
      if (prompt !== live.current.draft.prompt) recordDraft('Import prompt');
      draftHistory.seal();
      placePrompt(prompt);
      return 'Prompt filled from the imported image. Create the image when ready.';
    },
    [placePrompt, recordDraft, draftHistory],
  );

  const draftRevision = useCallback(() => rev.current.draft, []);
  const pickRevision = useCallback(() => rev.current.pick, []);
  const providerHeader = useCallback(() => live.current.provider.header, []);
  /** Why this file must not be uploaded, or null: checked before any request. */
  const importBlock = useCallback(
    (file) =>
      live.current.discovery.capabilities.data?.uploads
        ?.image_grounded_controls === true &&
      (submitting.current || isActive(live.current.job))
        ? 'Wait for the active generation before loading an image.'
        : privateAdmissionBlock('importing', file.size),
    [privateAdmissionBlock],
  );
  const importOwnership = useCallback(
    () =>
      JSON.stringify({
        revision: rev.current.draft,
        pick: rev.current.pick,
        provider: live.current.provider.id,
        mode: live.current.draft.mode,
        edit: Boolean(live.current.draft.edit),
        busy: submitting.current || isActive(live.current.job),
      }),
    [],
  );
  const importControlContext = useCallback(
    () =>
      live.current.discovery.capabilities.data?.uploads
        ?.image_grounded_controls === true &&
      live.current.draft.mode === 'image' &&
      !live.current.draft.edit
        ? { provider_id: live.current.provider.id }
        : null,
    [],
  );
  const startImageImport = useCallback(() => {
    if (!importControlContext()) return;
    imageImportPending.current = true;
    writeRef(episode, { ...episode.current, suppressed: true });
    cancelPromptTimers();
    flight.current?.controller.abort();
    flight.current = null;
  }, [cancelPromptTimers, importControlContext]);
  const applyPreparedImport = useCallback(
    (response, { previewUrl, file, controlsOnly, currentOwned }) => {
      imageImportPending.current = false;
      const analysis = response.image_controls;
      if (response.mode === 'metadata') {
        // The embedded snapshot itself is exact; use it rather than a possibly
        // incomplete summary of a matching Library item.
        const known =
          findByIdentity(live.current.savedImages, response.image) ??
          findByIdentity(live.current.privateItems, response.image);
        if (known) {
          applyRestore({
            ...known,
            ...response.image,
            id: known.id,
            image_id: known.image_id,
            image_url: known.image_url,
            storage_id: known.storage_id,
            storage_type: known.storage_type,
            local_origin: known.local_origin,
            local_added_at: known.local_added_at,
          });
          select(imageKey(known));
        } else applyImportedMetadata(response.image, previewUrl, file);
        if (live.current.draft.edit || live.current.draft.mode !== 'image')
          return 'Restored image settings. Review the restored mode before generating.';
      } else {
        if (!controlsOnly && response.prompt)
          applyImportedDescription(response.prompt);
        if (!controlsOnly && !response.prompt)
          return 'Description unavailable. Retry the description or enter a prompt.';
        // Suppress caption-only background defaults even when vision failed.
        writeRef(episode, {
          ...episode.current,
          anchor: promptKey(live.current.draft.prompt, 'image'),
          pending: false,
          suppressed: true,
        });
        if (analysis?.status !== 'ready')
          return 'Image read. Image controls are unavailable.';
        const wires = parseControlList(analysis.controls);
        const incoming = entriesFromRecord({ selected_controls: wires });
        const base = incoming.filter((entry) => entry.group === GROUP.base);
        // Preserve custom option objects and opaque fields from existing catalog
        // entries. Observed values replace untouched defaults; manual intent wins.
        const previous = live.current.entries;
        const mergedBase = base.map((entry) => {
          const old = previous.find(
            (item) => item.group === GROUP.base && item.key === entry.key,
          );
          if (!old) return entry;
          const upgraded = upgradeFixedEntries([old], [entry.wire])[0];
          if (hasRetentionClaim(old)) return upgraded;
          return {
            ...upgraded,
            ...entry,
            custom: upgraded.custom,
            wire: {
              ...upgraded.wire,
              ...entry.wire,
              options: { ...entry.wire.options, ...upgraded.wire.options },
            },
          };
        });
        const admission = planRetention(
          [
            ...mergedBase,
            ...previous.filter((entry) => entry.group !== GROUP.base),
          ],
          wires.filter((wire) => wire.origin !== 'fixed'),
          {
            limit: effectiveControlLimit(
              live.current.discovery.capabilities.data?.control_generation
                ?.max_controls,
            ),
            origin: {
              anchor: live.current.dynamic.anchor,
              refs: live.current.dynamic.refs,
            },
          },
        );
        if (!admission.ok)
          throw new Error(
            admission.message ??
              capacityMessage(admission.count, admission.limit),
          );
        const nextDynamic = {
          status: 'ready',
          provider: live.current.provider.id,
          anchor: promptKey(live.current.draft.prompt, 'image'),
          refs: referenceSignature([]),
          metadata: {
            ...analysis.dynamic_controls_metadata,
            import_source: {
              source_sha256: response.source_sha256,
              prompt_source: response.prompt_source,
              description: response.description?.text ?? null,
              binding: response.binding,
            },
          },
          error: null,
        };
        baseToken.current += 1;
        cancelAllExpansions();
        replaceAdditionalMetadata();
        touch();
        publishEntries(admission.entries);
        writeRef(live, { ...live.current, dynamic: nextDynamic });
        setDynamic(nextDynamic);
        setBase({ status: 'ready', error: null });
      }
      if (response.mode === 'metadata' && live.current.entries.length) {
        const restored = {
          ...live.current.dynamic,
          status: 'ready',
          provider: live.current.provider.id,
          anchor: promptKey(live.current.draft.prompt, live.current.draft.mode),
          refs: referenceSignature([]),
          metadata: {
            ...live.current.dynamic.metadata,
            import_source: {
              source_sha256: response.source_sha256,
              prompt_source: response.prompt_source,
              binding: response.binding,
              description: response.description?.text ?? null,
            },
          },
          error: null,
        };
        writeRef(live, { ...live.current, dynamic: restored });
        setDynamic(restored);
      }
      const blocked = submitBlockReason({
        discovery: live.current.discovery,
        draft: live.current.draft,
      });
      if (
        blocked ||
        !live.current.entries.length ||
        live.current.draft.edit ||
        live.current.draft.mode !== 'image' ||
        submitting.current ||
        isActive(live.current.job)
      )
        return blocked ?? 'Settings restored. Generate when ready.';
      // Event-owned microtask, never an effect: StrictMode and reconnects cannot
      // replay it. Dismissal, edits and newer picks invalidate its ownership.
      queueMicrotask(() => {
        if (alive.current && currentOwned())
          runSubmission({ skipDynamic: true, singleImage: true });
      });
      return 'Generating image…';
    },
    [
      applyImportedMetadata,
      applyRestore,
      select,
      applyImportedDescription,
      cancelAllExpansions,
      replaceAdditionalMetadata,
      publishEntries,
      runSubmission,
    ],
  );
  const importer = useImport({
    urls,
    uploads: discovery.capabilities.data?.uploads,
    canImport: importBlock,
    onMetadata: applyImportedMetadata,
    onDescription: applyImportedDescription,
    getRevision: draftRevision,
    getProviderHeader: providerHeader,
    getOwnership: importOwnership,
    getControlContext: importControlContext,
    canChooseControls: () => !live.current.inferenceOff,
    onStart: startImageImport,
    onEnd: () => {
      imageImportPending.current = false;
    },
    onPrepared: applyPreparedImport,
  });
  useLayoutEffect(() => {
    cancelImport.current = importer.cancelPending;
  });

  /** An explicit choice of a saved or imported image supersedes a pending import. */
  const restore = useCallback(
    (image) => {
      cancelImport.current();
      return restoreSelected(image);
    },
    [restoreSelected],
  );

  const newDraft = useCallback(() => {
    // The mode stays; only the draft's words, controls and images go.
    const fresh = {
      ...blankDraft,
      aspect: preferredAspect,
      ...kindFields(draftKind(live.current.draft, refsLive.current)),
    };
    if (!pristineDraft(captureDraft(), fresh)) recordDraft('New draft');
    void clearDraftFiles();
    cancelPick();
    rev.current.pick += 1;
    touch();
    flight.current?.controller.abort();
    flight.current = null;
    submissionKey.current = null;
    cancelAllExpansions();
    replaceAdditionalMetadata();
    cancelImport.current();
    cancelPromptTimers();
    holdReveal(0);
    setRegionEdit(null);
    setRegionNotice(null);
    // Reads started for the replaced draft add nothing to the new one.
    imageReferenceToken.current += 1;
    referenceAddToken.current += 1;
    referenceAddBatch.current = null;
    setReferenceReading(null);
    park(null);
    standardByKind.current.clear();
    clearReferences();
    writeRef(episode, {
      anchor: null,
      pending: true,
      workRevision: (episode.current.workRevision ?? 0) + 1,
    });
    const next = fresh;
    writeRef(live, {
      ...live.current,
      draft: next,
      entries: [],
      dynamic: idleDynamic,
    });
    setDraft(next);
    setEntries([]);
    setDynamic(idleDynamic);
    setNotice(null);
    setBasedOn(null);
    // A fresh draft asks for one image again until another count is chosen.
    setVariationChoice(DEFAULT_VARIATIONS);
    // Nothing is selected or deleted: history and records stay as they are.
    selection.current = { current: null, currentId: null };
    setCurrentId(null);
    setStageCleared(true);
    setJob((j) => (isActive(j) ? j : null));
    loadBase(next.mode);
  }, [
    park,
    loadBase,
    cancelAllExpansions,
    replaceAdditionalMetadata,
    cancelPromptTimers,
    holdReveal,
    cancelPick,
    clearReferences,
    preferredAspect,
    captureDraft,
    recordDraft,
    setRegionEdit,
    clearDraftFiles,
  ]);

  // --- References from saved images ---------------------------------------

  /** The ORIGINAL bytes of a saved or browser-only image. */
  const readImageOriginal = useCallback(
    (record, signal) =>
      readOriginalBytes(record, {
        signal,
        media: displayMedia,
        readLocal: (item, options) => {
          const handle = localHost.handleFor(item);
          return handle ? localHost.readOriginal(handle, options) : null;
        },
      }),
    [displayMedia, localHost],
  );
  useLayoutEffect(() => {
    bindReferences({
      onChange: (next) => {
        const signature = referenceSignature(next);
        // Holding references is an edit: an added one selects Edit.
        if (
          next.length &&
          !live.current.draft.edit &&
          !hydratingReferences.current
        ) {
          const edited = { ...live.current.draft, edit: true };
          writeRef(live, { ...live.current, draft: edited });
          setDraft(edited);
        }
        if (
          next.length &&
          !episode.current.suppressed &&
          live.current.entries.some((entry) => entry.pending)
        ) {
          publishEntries((entries) => entries.map(clearPending));
        }
        if (flight.current && flight.current.refs !== signature) {
          flight.current.controller.abort();
          flight.current = null;
        }
        const currentRegion = regionEditRef.current;
        if (
          currentRegion &&
          !regionRestoreInProgress.current &&
          !regionMatchesReference(currentRegion, next[0])
        ) {
          setRegionEdit(null);
          setRegionNotice(
            'The base image changed, so the region selection was cleared.',
          );
          setRegionEditorBase(null);
        }
        const editorBase = regionEditorBase;
        if (
          editorBase &&
          !regionRestoreInProgress.current &&
          (!next[0] ||
            next[0].id !== editorBase.id ||
            next[0].sha256 !== editorBase.sha256 ||
            (next[0].dimensions &&
              (next[0].dimensions.width !== editorBase.dimensions?.width ||
                next[0].dimensions.height !== editorBase.dimensions?.height)))
        ) {
          setRegionEditorBase(null);
          setRegionNotice('The base image changed. Reopen the region editor.');
        }
        refsLive.current = next;
      },
      getDraft: () => ({
        prompt: live.current.draft.prompt,
        mode: live.current.draft.mode,
        revision: rev.current.draft,
      }),
      setPrompt: (text) => {
        derivedPrompt.current = promptKey(text, live.current.draft.mode);
        changePrompt(text);
      },
      // A person's change to the references or a suggestion is one step.
      onTransaction: (label) => {
        if (transactionRecorded.current) transactionRecorded.current = false;
        else recordDraft(label);
        writeRef(episode, { ...episode.current, suppressed: false });
      },
      getProviderHeader: () => live.current.provider.header,
      // A saved edit's reference that names a saved image is read again by
      // its identity alone; nothing else is listed or hydrated for it.
      readSaved: async (identity, { signal } = {}) => {
        const record =
          live.current.source === SOURCE.PRIVATE
            ? await lookupPrivateCreate(identity, { signal })
            : await loadRecordById(identity, { signal });
        return record ? readImageOriginal(record, signal) : null;
      },
    });
  });

  /** Attach a saved image's original file as the next reference. */
  const addImageReference = useCallback(
    async (image) => {
      if (!image || image.client_pending) return;
      const key = imageKey(image);
      const token = ++imageReferenceToken.current;
      setReferenceReading(key);
      try {
        const original = await readImageOriginal(image);
        const blob = savedReferenceFile(
          original,
          image,
          describeImage(image).title,
        );
        // Undo, redo or a newer read meanwhile owns the list; a late read
        // adds nothing.
        if (!alive.current || token !== imageReferenceToken.current) return;
        // Use as reference selects Edit within the same undo step, bringing
        // back parked references first so the new one follows them.
        if (!live.current.draft.edit) {
          recordDraft('Add reference');
          transactionRecorded.current = true;
          setKind(DRAFT_KIND.edit, { record: false });
        }
        addReferences([blob], {
          id: savedReferenceId(image),
          name: image.filename ?? describeImage(image).title ?? 'image',
        });
        transactionRecorded.current = false;
      } catch (error) {
        transactionRecorded.current = false;
        if (
          !alive.current ||
          aborted(error) ||
          token !== imageReferenceToken.current
        )
          return;
        setNotice(
          failureNotice('The original image could not be read.', error),
        );
      } finally {
        // Only the current read owns the busy state.
        if (alive.current && token === imageReferenceToken.current)
          setReferenceReading(null);
      }
    },
    [readImageOriginal, addReferences, setKind, recordDraft],
  );

  const openRegionEditor = useCallback(() => {
    const first = refsLive.current[0];
    const available = regionToolAvailability(regionCapability, {
      ...first,
      file: first?.blob,
    });
    if (!available.available || !first?.blob || first.status !== 'ready') {
      setRegionNotice(
        available.reason ?? 'The original base image is not ready yet.',
      );
      return;
    }
    setRegionEditorBase({
      id: first.id,
      sha256: first.sha256,
      dimensions: first.dimensions,
      file: first.blob,
      label: first.name,
    });
    setRegionNotice(null);
    return true;
  }, [regionCapability]);

  const closeRegionEditor = useCallback(() => {
    setRegionEditorBase(null);
  }, []);

  const applyRegionEdit = useCallback(
    (selection) => {
      const expected = regionEditorBase;
      const first = refsLive.current[0];
      if (
        !expected ||
        !first ||
        first.id !== expected.id ||
        !regionMatchesReference(
          {
            source_sha256: expected.sha256,
            width: expected.dimensions?.width,
            height: expected.dimensions?.height,
          },
          first,
        ) ||
        (selection && !regionMatchesReference(selection, first))
      ) {
        setRegionNotice(
          'The base image changed before the selection was applied. Reopen the region editor.',
        );
        closeRegionEditor();
        return;
      }
      const next = selection ? cloneJson(selection) : null;
      if (JSON.stringify(regionEditRef.current) !== JSON.stringify(next)) {
        recordDraft(next ? 'Select image region' : 'Clear region selection');
        setRegionEdit(next);
      }
      setRegionNotice(null);
      closeRegionEditor();
    },
    [closeRegionEditor, recordDraft, setRegionEdit, regionEditorBase],
  );

  const clearRegionEdit = useCallback(() => {
    if (regionEditRef.current) {
      recordDraft('Clear region selection');
      setRegionEdit(null);
    }
    setRegionNotice(null);
    closeRegionEditor();
  }, [closeRegionEditor, recordDraft, setRegionEdit]);

  /**
   * Delete one saved image by record. On failure the image and context stay,
   * and the reason is returned so the caller can show it where the action was.
   * @returns {Promise<string|null>} an error message, or null when deleted
   */
  const removeImage = useCallback(
    async (image) => {
      if (isPendingItem(image)) {
        if (!isDismissable(image)) return 'This image is still being created.';
        dispatchLedger({ type: 'dismiss', jobId: image.client_pending.jobId });
        setCurrentId((cur) => (cur === imageKey(image) ? null : cur));
        return null;
      }
      const key = imageKey(image);
      // Private and imported images are removed from this browser only. The
      // server is never asked to delete them, whatever their storage identity.
      const failure = isLocalOnly(image)
        ? image.local_added_at !== undefined
          ? await privateRepository.remove(image)
          : await removePrivate(image)
        : await deleteImage(image);
      if (failure) return failure;
      if (image.local_added_at !== undefined)
        loadPrivateLibrary({ direction: 'refresh' });
      if (!isLocalOnly(image)) sharedHost.purge(key);
      if (exactRef.current.has(key)) {
        const next = new Map(exactRef.current);
        next.delete(key);
        exactRef.current = next;
        setExact(next);
      }
      setCurrentId((cur) => (cur === key ? null : cur));
      setBasedOn((cur) => (cur === key ? null : cur));
      return null;
    },
    [
      deleteImage,
      removePrivate,
      sharedHost,
      privateRepository,
      loadPrivateLibrary,
    ],
  );

  // Private source: one browser list of generated and imported images.
  // Shared source: the server list remains separate from browser-only imports.
  const images = useMemo(
    () =>
      privateSource
        ? {
            ...library.images,
            items: privateCreateRoute
              ? [...privateHistory.items, ...privateCreateWindow.rows]
              : privateHistory.items,
            status:
              privateHistory.status === 'ready' &&
              (!privateCreateRoute || privateCreateWindow.seq !== null)
                ? 'ready'
                : 'loading',
            error: null,
            watermarkSettings: null,
            watermarkBackfill: null,
            cacheWarning: privateHistory.notice,
          }
        : library.images,
    [
      privateSource,
      privateCreateRoute,
      library.images,
      privateCreateWindow.rows,
      privateCreateWindow.seq,
      privateHistory.items,
      privateHistory.status,
      privateHistory.notice,
    ],
  );
  const importedImages = useMemo(
    () =>
      privateHistory.items.filter(
        (item) => item.local_origin === LOCAL_ORIGIN.IMPORTED,
      ),
    [privateHistory.items],
  );
  // Library is also the removal location for imports in shared mode. Reuse the
  // exact-identity merge without adding provisional jobs or writing to the server.
  const libraryImages = useMemo(() => {
    if (privateLibraryRoute)
      return {
        ...images,
        items: [],
        imported: privateHistory.items.filter(
          (item) => item.local_storage?.state !== 'stored',
        ),
        window: privateLibrary.window,
        paged: true,
        onFirstPage: !privateLibrary.window.pages[0]?.previous_cursor,
      };
    if (route === ROUTE.library && sharedSource) {
      const window = library.libraryWindow;
      const page = window.pages[window.activeIndex] ?? null;
      // A stale cursor returning to the head has no exact position but no
      // previous page either.
      const onFirstPage =
        page?.position === 0 ||
        (page?.position === null &&
          page.previous_cursor === null &&
          page.count > 0);
      return {
        ...images,
        items: page?.images ?? [],
        imported: importedImages,
        window,
        paged: true,
        onFirstPage,
      };
    }
    if (privateSource || importedImages.length === 0) return images;
    return {
      ...images,
      items: composeHistory({
        ledger: emptyLedger,
        stored: images.items,
        imported: importedImages,
      }).items,
    };
  }, [
    route,
    sharedSource,
    privateSource,
    images,
    importedImages,
    library.libraryWindow,
    privateLibraryRoute,
    privateLibrary.window,
    privateHistory.items,
  ]);
  // Create history: bounded summary rows, each represented by its exact record
  // once one is held. A summary is never merged into or taken for a record.
  const windowPages = library.libraryWindow.pages;
  const windowAtHead = windowPages[0]?.previous_cursor === null;
  const windowRows = useMemo(() => {
    if (!createWindow) return [];
    const seen = new Set();
    const rows = [];
    for (const page of windowPages)
      for (const row of page.images) {
        const key = imageKey(row);
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(exact.get(key) ?? row);
      }
    return rows;
  }, [createWindow, windowPages, exact]);
  const historyReveal =
    generationReveal &&
    generationReveal.selectionKey === currentId &&
    !stageCleared
      ? generationReveal
      : null;
  const composed = useMemo(() => {
    // A selected completion may be outside the loaded catalog window. Keep
    // its exact row available without replacing or scanning that window.
    const withCompletion = (rows) =>
      historyReveal &&
      !rows.some((row) => imageKey(row) === historyReveal.selectionKey)
        ? [historyReveal.record, ...rows]
        : rows;
    if (privateSource)
      return composeHistory({
        ledger,
        stored: withCompletion(
          privateCreateRoute
            ? [...privateHistory.items, ...privateCreateWindow.rows]
            : privateHistory.items,
        ),
      });
    if (createWindow) {
      // A just-saved image leads the head of the catalog until a read lists it.
      const listed = new Set(windowRows.map(imageKey));
      const fresh = windowAtHead
        ? library.images.items.filter((item) => !listed.has(imageKey(item)))
        : [];
      return composeHistory({
        ledger,
        stored: withCompletion([...fresh, ...windowRows]),
        imported: importedImages,
      });
    }
    return composeHistory({
      ledger,
      stored: library.restoreRecord
        ? [library.restoreRecord, ...library.images.items]
        : library.images.items,
      imported: importedImages,
    });
  }, [
    privateSource,
    privateCreateRoute,
    privateCreateWindow.rows,
    createWindow,
    windowAtHead,
    windowRows,
    historyReveal,
    ledger,
    privateHistory.items,
    library.images.items,
    library.restoreRecord,
    importedImages,
  ]);
  const history = composed.items;

  // The newest image is the stage's default. Paging away from the head does not
  // change which image that is.
  const [lastHead, setLastHead] = useState(null);
  const privateWindowAtHead = privateCreateWindow.previous === null;
  const createHistoryWindow = createWindow || privateCreateRoute;
  if (
    createHistoryWindow &&
    (createWindow
      ? windowPages.length > 0 && windowAtHead
      : privateCreateWindow.seq !== null && privateWindowAtHead)
  ) {
    const newest = createWindow
      ? (library.images.items[0] ?? windowPages[0].images[0] ?? null)
      : (privateHistory.items[0] ?? privateCreateWindow.rows[0] ?? null);
    if (newest !== lastHead) setLastHead(newest);
  }
  const headRow = createHistoryWindow ? lastHead : null;
  const headKey = headRow ? imageKey(headRow) : null;
  const linkHeld =
    createHistoryWindow &&
    Boolean(editLink?.target) &&
    settledLink !== editLink.id;
  const needsHead =
    draftReferencePersistence.hydrated &&
    createHistoryWindow &&
    !linkHeld &&
    !currentId &&
    !stageCleared;

  const current = useMemo(() => {
    if (stageCleared) return null;
    const selected = findSelected(composed, currentId);
    if (selected && isExactRecord(selected)) return selected;
    if (currentId) return exact.get(currentId) ?? null;
    if (createHistoryWindow)
      return headKey ? (exact.get(headKey) ?? null) : null;
    return images.items[0] ?? null;
  }, [
    composed,
    createHistoryWindow,
    exact,
    headKey,
    images.items,
    currentId,
    stageCleared,
  ]);
  const addReferenceFiles = useCallback(
    async (files) => {
      const incoming = Array.from(files ?? []);
      if (!incoming.length) return;
      const pending = referenceAddBatch.current;
      if (
        pending &&
        !refsLive.current.length &&
        pending.baseKey === imageKey(current) &&
        pending.pickRevision === rev.current.pick &&
        pending.currentId === currentId
      ) {
        // Separate chooser/drop gestures share the pending base read. Validate
        // the whole new gesture before appending, so a refused one keeps prior files.
        const held = [{ size: 0 }, ...pending.files];
        for (const file of incoming) {
          const reason = checkReferenceFile(
            file,
            editCapability,
            held,
            discovery.capabilities.data?.uploads,
          );
          if (reason) {
            setNotice({
              tone: 'error',
              text: reason,
              scope: NOTICE_SCOPE.draft,
            });
            return;
          }
          held.push(file);
        }
        pending.files.push(...incoming);
        return;
      }
      const token = ++referenceAddToken.current;
      const pickRevision = rev.current.pick;
      const startingSignature = refSignature;
      if (refsLive.current.length) {
        addReferences(incoming);
        return;
      }
      const base = current;
      if (!base || isPendingItem(base)) {
        addReferences(incoming);
        return;
      }
      const batch = {
        baseKey: imageKey(base),
        currentId,
        pickRevision,
        files: incoming,
      };
      referenceAddBatch.current = batch;
      try {
        const original = await readImageOriginal(base);
        if (!original) throw new Error('Original bytes are unavailable.');
        const named = savedReferenceFile(
          original,
          base,
          describeImage(base).title || 'base-image',
        );
        // Undo, redo or another selection replaced this gesture's draft: its
        // base and any refusal of it no longer apply.
        const superseded = () =>
          !alive.current ||
          token !== referenceAddToken.current ||
          pickRevision !== rev.current.pick;
        if (superseded()) return;
        const combined = [named, ...batch.files];
        const held = [];
        for (const file of combined) {
          const reason = checkReferenceFile(
            file,
            editCapability,
            held,
            discovery.capabilities.data?.uploads,
          );
          if (reason) {
            setNotice({
              tone: 'error',
              text: reason,
              scope: NOTICE_SCOPE.draft,
            });
            return;
          }
          held.push({ size: file.size });
        }
        // If the selection or reference list changed while bytes were read,
        // let the newer action own the list and do not insert a stale base.
        if (
          !alive.current ||
          refsLive.current.length ||
          token !== referenceAddToken.current ||
          pickRevision !== rev.current.pick ||
          startingSignature !== referenceSignature(refsLive.current) ||
          selection.current.currentId !== currentId ||
          imageKey(selection.current.current) !== imageKey(base)
        )
          return;
        addReferences(combined, [
          { id: savedReferenceId(base), name: named.name },
          ...batch.files.map(() => ({})),
        ]);
      } catch (error) {
        if (
          alive.current &&
          token === referenceAddToken.current &&
          pickRevision === rev.current.pick
        )
          setNotice(
            failureNotice(
              'The current image could not be added as the base reference.',
              error,
            ),
          );
      } finally {
        if (referenceAddBatch.current === batch)
          referenceAddBatch.current = null;
      }
    },
    [
      addReferences,
      current,
      currentId,
      discovery.capabilities.data,
      editCapability,
      readImageOriginal,
      refSignature,
    ],
  );
  useLayoutEffect(() => {
    selection.current = { current, currentId };
    pinnedKeys.current = new Set(
      [current && imageKey(current), currentId, basedOn, headKey].filter(
        Boolean,
      ),
    );
  });
  useLayoutEffect(() => {
    if (!privateCreateRoute) {
      pinPrivateCreateRole('selected', null);
      pinPrivateCreateRole('draft-base', null);
      return;
    }
    pinPrivateCreateRole('selected', current);
    const draftBase = [
      current,
      ...privateCreateWindow.rows,
      ...privateHistory.items,
      ...exact.values(),
    ].find((record) => record && imageKey(record) === basedOn);
    pinPrivateCreateRole('draft-base', draftBase ?? null);
  }, [
    privateCreateRoute,
    pinPrivateCreateRole,
    privateCreateWindow.rows,
    privateHistory.items,
    exact,
    current,
    basedOn,
  ]);

  // Open Create history once the edit link (if any) has said where to open it.
  const loadWindow = library.loadLibraryWindow;
  const refreshHistory = useRef(null);
  useLayoutEffect(() => {
    refreshHistory.current = windowPages.length
      ? { direction: 'refresh', binding: CREATE_HISTORY_BINDING }
      : { direction: 'first', binding: CREATE_HISTORY_BINDING };
  });
  useEffect(() => {
    if ((!createWindow && !privateCreateRoute) || linkHeld) return;
    const around = linkAnchor.current;
    linkAnchor.current = null;
    if (privateCreateRoute)
      loadPrivateCreate(
        around && typeof around === 'object'
          ? { direction: 'around', identity: around }
          : { direction: 'first' },
      );
    else
      loadWindow(
        around
          ? { direction: 'around', around, binding: CREATE_HISTORY_BINDING }
          : refreshHistory.current,
      );
  }, [
    createWindow,
    privateCreateRoute,
    loadPrivateCreate,
    linkHeld,
    scopeKey,
    loadWindow,
  ]);

  // A missing/deleted selection may fall back to the head only after its exact
  // record loads. Fresh drafts remain cleared and do not use this fallback.
  const headHeld = headKey !== null && exact.has(headKey);
  useEffect(() => {
    if (!needsHead || !headRow || headHeld) return undefined;
    if (privateCreateRoute) {
      const held = privateHistory.items.find(
        (item) =>
          imageKey(item) === imageKey(headRow) &&
          item.local_added_at === headRow.local_added_at &&
          item.local_storage?.state !== 'stored',
      );
      if (held) {
        keepExact(held);
        return undefined;
      }
      const controller = new AbortController();
      exactPrivateCreate(headRow).then(
        (record) => {
          if (controller.signal.aborted) return;
          if (record) keepExact(record);
          else loadPrivateCreate({ direction: 'refresh' });
        },
        () => {},
      );
      return () => controller.abort();
    }
    if (isLocalOnly(headRow)) return undefined;
    if (isExactRecord(headRow)) {
      keepExact(headRow);
      return undefined;
    }
    const controller = new AbortController();
    loadRecord(headRow, { signal: controller.signal }).then(
      keepExact,
      (error) => {
        if (aborted(error) || controller.signal.aborted) return;
        if (error.status === HTTP_NOT_FOUND) {
          reloadImages();
          return;
        }
        setNotice({
          ...failureNotice(DETAIL_FAILED, error),
          actionLabel: 'Retry',
          onAction: () => {
            setNotice(null);
            setHeadAttempt((n) => n + 1);
          },
        });
      },
    );
    return () => controller.abort();
  }, [
    needsHead,
    privateCreateRoute,
    exactPrivateCreate,
    loadPrivateCreate,
    privateHistory.items,
    headRow,
    headHeld,
    headAttempt,
    loadRecord,
    keepExact,
    reloadImages,
  ]);

  // The image on stage follows analysis and prepared-file results, and a catalog
  // change re-reads it conditionally. It leaves the stage only if it is gone.
  const replaced = library.replacedRecord;
  useEffect(() => {
    if (replaced && createWindow && isExactRecord(replaced))
      keepExact(replaced);
  }, [replaced, createWindow, keepExact]);
  const stageRevision = createWindow ? library.libraryWindow.revision : null;
  const seenRevision = useRef(null);
  useEffect(() => {
    if (stageRevision === null) return undefined;
    const previous = seenRevision.current;
    seenRevision.current = stageRevision;
    const shown = selection.current.current;
    if (
      previous === null ||
      previous === stageRevision ||
      !shown ||
      shown.client_pending ||
      isLocalOnly(shown)
    )
      return undefined;
    const controller = new AbortController();
    const key = imageKey(shown);
    loadRecord(shown, { signal: controller.signal }).then(
      (record) => {
        if (exactRef.current.has(key)) keepExact(record);
      },
      (error) => {
        if (error.status !== HTTP_NOT_FOUND || controller.signal.aborted)
          return;
        const next = new Map(exactRef.current);
        next.delete(key);
        exactRef.current = next;
        setExact(next);
        setCurrentId((id) => (id === key ? null : id));
      },
    );
    return () => controller.abort();
  }, [stageRevision, loadRecord, keepExact]);

  /** Everything an edit link may look at before it decides. */
  const loadEditRecord = useCallback(
    (target, item, { signal } = {}) => {
      const { restoreRecord, exact: held, source } = live.current;
      const known = [restoreRecord, ...held.values()].find(
        (record) => record && sameTarget(record, target),
      );
      if (known) {
        if (source === SOURCE.PRIVATE && Number.isFinite(known.local_added_at))
          linkAnchor.current = {
            key: imageKey(known),
            addedAt: known.local_added_at,
          };
        return Promise.resolve(known);
      }
      if (source === SOURCE.PRIVATE) {
        const identity = recordIdForEditTarget(target);
        if (!identity) return Promise.resolve(null);
        return lookupPrivateCreate(identity, { signal }).then((record) => {
          if (signal?.aborted || !record || !sameTarget(record, target))
            return null;
          linkAnchor.current = {
            key: imageKey(record),
            addedAt: record.local_added_at,
          };
          return record;
        });
      }
      if (item) return loadRecord(item, { signal });
      if (source !== SOURCE.SHARED) return Promise.resolve(null);
      const identity = recordIdForEditTarget(target);
      if (!identity) return Promise.resolve(null);
      return loadRecordById(identity, { signal }).then((record) =>
        sameTarget(record, target) ? record : null,
      );
    },
    [loadRecord, loadRecordById, lookupPrivateCreate],
  );
  const finishEditLink = useCallback(
    (id, anchor = null) => {
      if (!(privateSource && typeof linkAnchor.current === 'object' && anchor))
        linkAnchor.current = anchor;
      setSettledLink(id);
    },
    [privateSource],
  );

  const edge = (intent) =>
    loadWindow({ ...intent, binding: CREATE_HISTORY_BINDING });
  const lastWindowPage = windowPages[windowPages.length - 1];

  /** Edit is chosen (holding references always means it is). */
  const editKind = Boolean(draft.edit) || references.refs.length > 0;
  const currentKind = draftKind(draft, references.refs);
  // Whatever mode is showing is the one a reload or New draft starts in.
  useEffect(() => {
    if (draftReferencePersistence.hydrated)
      savePreferredKind(draftKind(live.current.draft, refsLive.current));
  }, [currentKind, savePreferredKind, draftReferencePersistence.hydrated]);
  const regionBaseRef = references.refs[0] ?? null;
  const regionAvailability = regionToolAvailability(regionCapability, {
    ...regionBaseRef,
    file: regionBaseRef?.blob,
  });
  const regionAvailable =
    regionAvailability.available &&
    Boolean(regionBaseRef?.blob) &&
    regionBaseRef.status === 'ready';

  return {
    draft,
    entries,
    base,
    dynamic,
    additionalMetadata,
    standardSummary: standardSummary(entries),
    retainedEntries: entries.filter((entry) => entry.retained),
    controlLimit: effectiveControlLimit(maxControls),
    capacityError: dynamic.error?.refused === 'capacity' ? dynamic.error : null,
    dynamicStale:
      dynamic.status === 'ready' &&
      !matchesControlIdentity(dynamic, {
        provider: provider.id,
        draft,
        refs: refSignature,
        policy,
      }),
    revealHeld,
    job,
    notice,
    images,
    libraryImages,
    libraryWindow: library.libraryWindow,
    libraryScopeKey: privateLibraryRoute ? 'private-library' : scopeKey,
    loadLibraryWindow: privateLibraryRoute
      ? privateLibrary.load
      : library.loadLibraryWindow,
    retainPrivateRecord,
    loadLibraryRecord: library.loadLibraryRecord,
    libraryChangeTick: library.changeTick,
    refreshCapabilities: discovery.reload,
    rememberRecordForRestore: library.rememberRecordForRestore,
    libraryReplacedRecord: privateLibraryRoute
      ? privateLibrary.replacedRecord
      : library.replacedRecord,
    importedImages,
    media: displayMedia,
    clientPolicy: policy,
    source: library.source,
    privateNotice: privateCreateRoute
      ? (privateCreate.pinError ?? privateHistory.notice)
      : privateSource
        ? privateHistory.notice
        : null,
    retryStorage: retryPrivate,
    watermark,
    history,
    historyReveal: historyReveal?.consumed ? null : historyReveal,
    historyRevealed,
    historyCompletionPinned: Boolean(
      historyReveal &&
      (createWindow
        ? !windowAtHead &&
          !windowRows.some(
            (row) => imageKey(row) === historyReveal.selectionKey,
          )
        : privateCreateRoute &&
          !privateWindowAtHead &&
          !privateCreateWindow.rows.some(
            (row) => imageKey(row) === historyReveal.selectionKey,
          )),
    ),
    // Every list that feeds the strip has been read once, and the image shown
    // by default has the exact record its restore needs.
    historyReady: createWindow
      ? windowPages.length > 0 &&
        privateHistory.status !== 'loading' &&
        (!needsHead || !headKey || headHeld)
      : privateCreateRoute
        ? privateCreateWindow.seq !== null &&
          privateHistory.status !== 'loading' &&
          (!needsHead || !headKey || headHeld)
        : images.status === 'ready' && privateHistory.status !== 'loading',
    // An edit link may be resolved once the source is known and its browser-only
    // images are readable. A failed library read does not hold it back.
    editReady:
      draftReferencePersistence.hydrated &&
      (sharedSource || privateSource) &&
      privateHistory.status !== 'loading',
    loadEditRecord,
    finishEditLink,
    restoring,
    stageWaiting: Boolean(
      createHistoryWindow &&
      !current &&
      !stageCleared &&
      !generating &&
      (linkHeld ||
        restoring ||
        (needsHead &&
          !(createWindow
            ? library.libraryWindow.error
            : privateCreateWindow.error) &&
          (createWindow
            ? windowPages.length === 0 || (headKey && !headHeld)
            : privateCreateWindow.seq === null || (headKey && !headHeld)))),
    ),
    historyWindow: createWindow
      ? {
          error: library.libraryWindow.error,
          retry: () =>
            edge({ direction: windowPages.length ? 'refresh' : 'first' }),
          busy: library.libraryWindow.pending !== null,
          hasEarlier: Boolean(windowPages[0]?.previous_cursor),
          hasLater: Boolean(lastWindowPage?.next_cursor),
          loadEarlier: () => edge({ direction: 'backward' }),
          loadLater: () => edge({ direction: 'forward' }),
          loadFirst: () => edge({ direction: 'first' }),
          loadLast: () => edge({ direction: 'last' }),
        }
      : privateCreateRoute
        ? {
            error: privateCreateWindow.error,
            retry: () =>
              loadPrivateCreate({
                direction:
                  privateCreateWindow.seq === null ? 'first' : 'refresh',
              }),
            busy: privateCreateWindow.pending !== null,
            hasEarlier: Boolean(privateCreateWindow.previous),
            hasLater: Boolean(privateCreateWindow.next),
            loadEarlier: () => loadPrivateCreate({ direction: 'newer' }),
            loadLater: () => loadPrivateCreate({ direction: 'older' }),
            loadFirst: () => loadPrivateCreate({ direction: 'first' }),
            loadLast: () => loadPrivateCreate({ direction: 'last' }),
          }
        : null,
    settingsImages: pagedSurface
      ? [...library.images.items, ...windowPages.flatMap((page) => page.images)]
      : images.items,
    draftRevision,
    pickRevision,
    generating,
    current,
    basedOn,
    historyState,
    historyStep,
    undoDraft: () => stepDraftHistory('undo'),
    redoDraft: () => stepDraftHistory('redo'),
    discovery,
    blockReason:
      (entries.length > effectiveControlLimit(maxControls)
        ? overLimitMessage(entries.length, effectiveControlLimit(maxControls))
        : dynamic.error?.refused === 'capacity'
          ? dynamic.error.message
          : null) ??
      submitBlockReason({ discovery, draft }) ??
      editBlockReason(editKind, references.refs, editCapability) ??
      regionSubmissionProblem(regionEdit, references.refs, regionCapability) ??
      (editKind
        ? null
        : disabledControlBlock(entries, { textFlags: controlApplication })) ??
      (privateSource && (privateHistory.unsavedCount || variationCount > 1)
        ? privateAdmissionBlock('generating', null, variationCount)
        : null),
    dismissNotice: () => setNotice(null),
    editCapability,
    draftReferencePersistence,
    regionEdit: {
      selection: regionEdit,
      notice: regionNotice,
      availability: {
        ...regionAvailability,
        available: regionAvailable,
        ...(regionAvailable || regionAvailability.reason
          ? {}
          : { reason: 'The original base image is not ready yet.' }),
      },
      open: Boolean(regionEditorBase),
      base: regionEditorBase,
      capability: regionCapability,
      urls,
      openEditor: openRegionEditor,
      closeEditor: closeRegionEditor,
      apply: applyRegionEdit,
      clear: clearRegionEdit,
    },
    references,
    retained,
    urls,
    addReferenceFiles,
    editing: editKind,
    kind: draftKind(draft, references.refs),
    setKind,
    parkedReferences: parkedCount,
    // Text requests may leave a Standard control to the model.
    textToggle: controlApplication && !editKind,
    addImageReference,
    referenceReading,
    retry,
    variations: {
      capability: variationCap,
      count: variationCount,
      setCount: setVariationChoice,
      // Counts this browser can keep now (private history reserves a place
      // for each image before anything is sent).
      blockFor: (count) =>
        privateSource && (privateHistory.unsavedCount || count > 1)
          ? privateAdmissionBlock('generating', null, count)
          : null,
      group: variations.group,
      summary: variations.group ? summarizeGroup(variations.group) : null,
      canRetry:
        canRetryGroup(variations.group, variationCap) && !variations.retrying,
      retrying: variations.retrying,
      retryError: variations.retryError,
      dismissRetryError: variations.dismissRetryError,
      retry: retryVariations,
      resume: resumeVariations,
    },
    appliesToEdit,
    setPrompt,
    setMode,
    setAspect,
    ...editors,
    applyControlEntries,
    randomizeBase,
    // Named Standard control presets kept in this browser (E05).
    controlPresets: {
      store: cache.store?.controlPresets ?? null,
      ready: cache.ready,
    },
    // Favorites and collections (E06): the same cache owner, no other DB.
    imageAnnotations: {
      store: cache.store?.imageAnnotations ?? null,
      ready: cache.ready,
      readPrivateDetail: cache.store?.readPrivateDetail ?? null,
    },
    expansions,
    additional,
    canAddControls:
      additionalEnabled &&
      !inferenceOff &&
      draft.prompt.trim() !== '' &&
      dynamic.status !== 'loading' &&
      !revealHeld &&
      hasControlCapacity(entries, maxControls),
    controlsFull: !hasControlCapacity(entries, maxControls),
    addControls,
    suggestions,
    inferenceOff,
    pickSuggestion,
    importState: importer.state,
    importImage: importer.importFile,
    retryImport: importer.retry,
    retryImportDescription: importer.retryDescription,
    retryImportControls: importer.retryControls,
    useImportDescription: applyImportedDescription,
    dismissImport: importer.dismiss,
    regenerateOptions,
    reloadBase: () => loadBase(live.current.draft.mode),
    submit,
    scrollRequest,
    resumeTracking,
    restore,
    newDraft,
    removeImage,
    select,
    reloadImages: reloadLibraryImages,
  };
}
