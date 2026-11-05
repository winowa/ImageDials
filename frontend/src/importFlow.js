/**
 * Import analysis: bounded file checks, matching an imported snapshot with a
 * saved image, and the import state machine. Analysis never writes to the
 * library; an imported image is previewed from a local object URL only.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { api, newKey } from './api.js';
import {
  preserveError,
  httpDiagnostic,
  localDiagnostic,
} from './diagnostics.js';
import { providerRequest } from './providerSettings.js';

const BYTES_PER_MIB = 1024 * 1024;
/** Longest edge of file names shown in messages. */
const FILE_NAME_MAX_CHARS = 80;

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const IMPORT_PHASE = {
  idle: 'idle',
  analyzing: 'analyzing',
  /** Analysis finished and its result was applied. */
  done: 'done',
  /** The draft was edited while analysis ran, so its result was not applied. */
  superseded: 'superseded',
  error: 'error',
};

export const idleImport = Object.freeze({
  phase: IMPORT_PHASE.idle,
  fileName: null,
  previewUrl: null,
  message: null,
  description: null,
  descriptionStatus: null,
  metadataNotice: null,
  choosingControls: false,
  progress: null,
  error: null,
});

const noImportBlock = () => null;

/** Thrown by `onMetadata` when the image could not be kept; nothing was changed. */
export class ImportRefusedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImportRefusedError';
  }
}
export const IMPORT_NOT_KEPT_MESSAGE =
  'The image could not be kept in this browser, so it was not imported. Remove one from the Library first.';

const mib = (bytes) => `${Math.round((bytes / BYTES_PER_MIB) * 10) / 10} MiB`;
const shortName = (file) =>
  (file.name || 'image').slice(0, FILE_NAME_MAX_CHARS);

/**
 * Message for a file that must not be sent, or null. The limits come from the
 * server's capabilities; until they are available nothing is sent, so a file
 * is never uploaded against limits this client does not know.
 * @param {File} file
 * @param {{import_max_bytes?: number, image_mime_types?: string[]}} [uploads]
 */
export function checkImportFile(file, uploads) {
  const types = uploads?.image_mime_types;
  const limit = uploads?.import_max_bytes;
  if (!Array.isArray(types) || !types.length || !Number.isFinite(limit))
    return 'The upload limits have not been read from the server, so the image was not sent. Try again when the app is connected.';
  if (!file.size) return `${shortName(file)} is empty.`;
  if (!types.includes(file.type))
    return `${shortName(file)} is not a supported image type (${types.join(', ')}).`;
  if (file.size > limit)
    return `${shortName(file)} is ${mib(file.size)}; the limit is ${mib(limit)}.`;
  return null;
}

/** The saved image an imported snapshot came from, by identity, or undefined. */
export const findByIdentity = (items, record) =>
  items.find(
    (item) =>
      (record.id && item.id === record.id) ||
      (record.image_id && item.image_id === record.image_id),
  );

const failure = (file, error) => ({
  progress: null,
  phase: IMPORT_PHASE.error,
  fileName: shortName(file),
  message: error.message,
  error: preserveError(error),
});

/**
 * Import state: one analysis at a time, a newer one replaces an older one, and
 * every object URL is released when nothing shows it. The two outcomes are
 * applied by the owner through `onMetadata` and `onDescription`. Import only
 * changes the draft; image generation remains an explicit action.
 *
 * @param {object} options
 * @param {ReturnType<import('./objectUrls.js').createUrlLedger>} options.urls
 * @param {object} [options.uploads] capabilities.uploads
 * @param {(file: File) => string|null} [options.canImport] why the file must
 *   not be uploaded (a message) or null. It runs after the file checks and
 *   before the preview, the draft check or any request, so a refusal changes
 *   nothing and sends nothing.
 * @param {(record: object, url: string, file: File) => string} options.onMetadata
 *   applies a snapshot; the private history retains `url` (and keeps `file`)
 *   when it adds the image. Returns the status message.
 * @param {(prompt: string) => string} options.onDescription places the active
 *   prompt in the draft; returns the status message.
 * @param {() => number} options.getRevision counts draft edits. A result is
 *   applied only if the count is what it was when the import began: a manual
 *   edit supersedes a pending analysis and keeps the draft as it is.
 */
export function useImport({
  urls,
  uploads,
  canImport = noImportBlock,
  onMetadata,
  onDescription,
  getRevision,
  getProviderHeader = () => null,
  getOwnership = getRevision,
  getControlContext = () => null,
  onPrepared,
  canChooseControls = () => true,
  onStart = () => {},
  onEnd = () => {},
}) {
  const [state, setState] = useState(idleImport);
  const run = useRef({
    token: 0,
    controller: null,
    previewUrl: null,
    file: null,
  });

  useEffect(
    () => () => {
      run.current.token += 1;
      run.current.controller?.abort();
    },
    [],
  );

  const showPreview = useCallback(
    (url) => {
      const { previewUrl } = run.current;
      if (previewUrl) urls.release(previewUrl);
      run.current.previewUrl = url;
    },
    [urls],
  );

  /** Abort any analysis and clear the preview. */
  const dismiss = useCallback(() => {
    run.current.token += 1;
    run.current.controller?.abort();
    run.current.controller = null;
    showPreview(null);
    onEnd();
    setState(idleImport);
  }, [showPreview, onEnd]);

  /** Abort an analysis still running (the person moved on); a finished one stays. */
  const cancelPending = useCallback(() => {
    if (run.current.controller) dismiss();
    else {
      run.current.token += 1;
      setState((prev) => (prev.progress ? { ...prev, progress: null } : prev));
    }
  }, [dismiss]);

  const importFile = useCallback(
    async (file, { descriptionOnly = false, controlsOnly = false } = {}) => {
      if ((controlsOnly || descriptionOnly) && run.current.controller) return;
      if (!controlsOnly && !descriptionOnly) {
        run.current.token += 1;
        run.current.controller?.abort();
        run.current.controller = null;
        onEnd();
      }
      run.current.file = file;
      const problem = checkImportFile(file, uploads);
      if (problem) {
        // Rejected before sending: the previous preview and draft stay.
        setState((prev) => ({
          ...prev,
          ...failure(file, new Error(problem)),
          previewUrl: prev.previewUrl,
        }));
        return;
      }
      const refusal = descriptionOnly ? null : canImport(file);
      if (refusal) {
        setState((prev) => ({
          ...prev,
          ...failure(file, new Error(refusal)),
          previewUrl: prev.previewUrl,
        }));
        return;
      }
      if (controlsOnly && !run.current.response) {
        setState((prev) => ({
          ...prev,
          ...failure(
            file,
            new Error('Load the image again before retrying its controls.'),
          ),
          controlsWarning: null,
        }));
        return;
      }
      if (controlsOnly && run.current.appliedOwnership !== getOwnership()) {
        setState((prev) => ({
          ...prev,
          controlsWarning: {
            message:
              'The draft changed. Load the image again to choose controls.',
          },
        }));
        return;
      }
      if (!descriptionOnly && !controlsOnly) run.current.response = null;
      const token = ++run.current.token;
      const startRevision = getRevision();
      const ownership = getOwnership();
      run.current.ownership = ownership;
      const controlContext = getControlContext();
      const context = controlContext
        ? {
            ...controlContext,
            revision: startRevision,
            request_id: newKey(),
            action: controlsOnly ? 'retry-controls' : 'description-only',
          }
        : undefined;
      const chooseControls = canChooseControls();
      const provider = providerRequest(getProviderHeader());
      const progress = context
        ? {
            step: controlsOnly ? 'controls' : 'analysis',
            descriptionOnly,
            requestId: context.request_id,
            restored: false,
          }
        : null;
      if (!descriptionOnly) onStart();
      run.current.controller?.abort();
      const controller = new AbortController();
      run.current.controller = controller;
      const previewUrl =
        descriptionOnly || controlsOnly
          ? run.current.previewUrl
          : urls.acquire(file);
      if (descriptionOnly || controlsOnly)
        setState((prev) => ({
          ...prev,
          phase: IMPORT_PHASE.analyzing,
          error: null,
          controlsWarning: null,
          choosingControls: Boolean(context && controlsOnly),
          progress,
        }));
      else {
        showPreview(previewUrl);
        setState({
          ...idleImport,
          phase: IMPORT_PHASE.analyzing,
          fileName: shortName(file),
          previewUrl,
          choosingControls: Boolean(context && controlsOnly),
          progress,
        });
      }
      const current = () => run.current.token === token;
      const settle = (next) => setState({ ...next, previewUrl });
      try {
        // The choice at the moment of the upload applies to this analysis only.
        let response = await api.importAnalysis(file, {
          ...provider,
          signal: controller.signal,
          context,
        });
        if (!current()) return;
        const matches = (answer, binding) =>
          answer.binding &&
          JSON.stringify(answer.binding) === JSON.stringify(binding) &&
          /^[a-f0-9]{64}$/.test(answer.source_sha256 ?? '');
        if (context && !descriptionOnly && !controlsOnly) {
          setState((prev) => ({
            ...prev,
            description: response.description?.text ?? null,
            descriptionStatus: response.description ?? null,
          }));
          if (!matches(response, context))
            throw new Error(
              'The image controls do not match this import request.',
            );
          // No second upload/model call may outlive the original draft/provider.
          if (getRevision() !== startRevision || getOwnership() !== ownership) {
            showPreview(null);
            setState({ ...idleImport, phase: IMPORT_PHASE.superseded });
            return;
          }
          if (response.mode === 'metadata') {
            response = { ...response, image_controls: { status: 'restored' } };
          } else if (!chooseControls) {
            response = {
              ...response,
              image_controls: {
                status: 'unavailable',
                message: 'Inference is disabled',
              },
            };
          } else {
            const first = response;
            const binding = { ...context, action: 'retry-controls' };
            setState((prev) => ({
              ...prev,
              choosingControls: true,
              progress: { ...progress, step: 'controls' },
            }));
            let choices;
            try {
              choices = await api.importAnalysis(file, {
                ...provider,
                signal: controller.signal,
                context: binding,
              });
            } catch (error) {
              if (error?.name === 'AbortError' || !current()) return;
              // Keep the description when the controls transport fails.
              choices = {
                binding,
                source_sha256: first.source_sha256,
                image_controls: { status: 'error', ...preserveError(error) },
              };
            }
            if (!current()) return;
            if (!matches(choices, binding))
              throw new Error(
                'The image controls do not match this import request.',
              );
            if (choices.source_sha256 !== first.source_sha256)
              throw new Error('The source image changed. Load it again.');
            response = { ...first, image_controls: choices.image_controls };
          }
        }
        if (controlsOnly && run.current.response) {
          if (response.source_sha256 !== run.current.response.source_sha256)
            throw new Error('The source image changed. Load it again.');
          response = {
            ...response,
            prompt: run.current.response.prompt,
            prompt_source: run.current.response.prompt_source,
            description: run.current.response.description,
          };
        }
        const description = isObject(response?.description)
          ? response.description
          : null;
        const prompt =
          typeof response?.prompt === 'string' ? response.prompt.trim() : '';
        const contentState = {
          description:
            description?.text ||
            (response?.mode === 'description' ? prompt : null),
          descriptionStatus: description,
          metadataNotice:
            typeof response?.metadata_notice === 'string'
              ? response.metadata_notice
              : null,
        };
        // A description retry belongs to the existing import panel, never to
        // the editable draft. Even edits made before this click must survive.
        if (descriptionOnly) {
          setState((prev) => ({
            ...prev,
            phase: IMPORT_PHASE.done,
            progress: null,
            error: null,
            ...contentState,
          }));
          return;
        }
        if (getRevision() !== startRevision || getOwnership() !== ownership) {
          showPreview(null);
          setState({
            ...idleImport,
            phase: IMPORT_PHASE.superseded,
            fileName: shortName(file),
            message:
              'The draft changed while the image was being read, so its result was not applied.',
            ...contentState,
          });
          return;
        }
        if (context && onPrepared) {
          run.current.response = response;
          if (!controlsOnly) setState((prev) => ({ ...prev, ...contentState }));
          if (
            !response.binding ||
            JSON.stringify(response.binding) !== JSON.stringify(context) ||
            !/^[a-f0-9]{64}$/.test(response.source_sha256 ?? '')
          )
            throw new Error(
              'The image controls do not match this import request.',
            );
          const currentOwned = () =>
            current() &&
            !controller.signal.aborted &&
            getOwnership() === run.current.appliedOwnership;
          // Validation/application is synchronous: never delay to show a spinner.
          setState((prev) => ({
            ...prev,
            progress: {
              ...progress,
              step: 'options',
              restored: response.mode === 'metadata',
            },
          }));
          run.current.controller = null;
          const message = onPrepared(response, {
            previewUrl,
            file,
            controlsOnly,
            currentOwned,
          });
          run.current.appliedOwnership = getOwnership();
          run.current.response = response;
          const warning = ['ready', 'restored'].includes(
            response.image_controls?.status,
          )
            ? null
            : (response.image_controls ?? {
                message:
                  'Image controls are unavailable. Retry image controls.',
              });
          if (warning?.details) {
            const failure = warning.details.failure;
            warning.diagnostic = failure?.http_status
              ? {
                  ...httpDiagnostic({
                    method: 'POST',
                    path: null,
                    response: { status: failure.http_status },
                    text: failure.body,
                  }),
                  data: warning.details,
                }
              : localDiagnostic({
                  category: 'image-controls',
                  reason: warning.message,
                  data: warning.details,
                });
          }
          setState((prev) => ({
            ...prev,
            phase: IMPORT_PHASE.done,
            fileName: shortName(file),
            previewUrl,
            message,
            progress:
              message === 'Generating image…'
                ? {
                    ...progress,
                    step: 'generation',
                    revision: getRevision(),
                    restored: response.mode === 'metadata',
                  }
                : null,
            controlsWarning: warning,
            ...(!controlsOnly ? contentState : {}),
          }));
          run.current.controller = null;
          return;
        }
        if (response?.mode === 'metadata' && isObject(response.image)) {
          const message = onMetadata(response.image, previewUrl, file);
          // The history holds its own reference when it keeps the image.
          showPreview(null);
          setState({
            ...idleImport,
            phase: IMPORT_PHASE.done,
            fileName: shortName(file),
            message,
            ...contentState,
          });
        } else if (
          ['description', 'comfyui'].includes(response?.mode) &&
          prompt
        ) {
          settle({
            ...idleImport,
            phase: IMPORT_PHASE.done,
            fileName: shortName(file),
            message: onDescription(prompt),
            ...contentState,
          });
        } else {
          settle(
            failure(file, new Error('The image analysis was not understood.')),
          );
        }
      } catch (error) {
        if (error?.name === 'AbortError' || !current()) return;
        run.current.controller = null;
        if (descriptionOnly) {
          setState((prev) => ({
            ...prev,
            phase: IMPORT_PHASE.done,
            progress: null,
            descriptionStatus: { status: 'error', ...preserveError(error) },
          }));
          return;
        }
        if (error instanceof ImportRefusedError) {
          showPreview(null);
          setState({ ...failure(file, error), previewUrl: null });
          return;
        }
        if (context && [400, 413, 415, 422].includes(error.status)) {
          settle(failure(file, error));
          return;
        }
        if (controlsOnly) {
          run.current.appliedOwnership = getOwnership();
          setState((prev) => ({
            ...prev,
            phase: IMPORT_PHASE.done,
            progress: null,
            controlsWarning: preserveError(error),
          }));
          return;
        }
        setState((prev) => ({
          ...prev,
          ...failure(file, error),
          controlsWarning: null,
          previewUrl,
        }));
      } finally {
        if (current()) {
          run.current.controller = null;
          onEnd();
        }
      }
    },
    [
      uploads,
      canImport,
      urls,
      showPreview,
      onMetadata,
      onDescription,
      getRevision,
      getProviderHeader,
      getOwnership,
      getControlContext,
      onPrepared,
      canChooseControls,
      onStart,
      onEnd,
    ],
  );

  const retry = useCallback(() => {
    if (run.current.file) return importFile(run.current.file);
    return undefined;
  }, [importFile]);

  const retryDescription = useCallback(() => {
    if (run.current.file)
      return importFile(run.current.file, { descriptionOnly: true });
    return undefined;
  }, [importFile]);

  const retryControls = useCallback(() => {
    if (run.current.file)
      return importFile(run.current.file, { controlsOnly: true });
    return undefined;
  }, [importFile]);

  // Draft edits terminate the visual pipeline immediately. The existing guards
  // still reject late transport answers; no effect ever starts import work.
  useLayoutEffect(() => {
    if (
      state.progress &&
      run.current.controller &&
      run.current.ownership !== getOwnership()
    ) {
      run.current.token += 1;
      run.current.controller.abort();
      run.current.controller = null;
      showPreview(null);
      onEnd();
      setState((prev) => ({
        ...prev,
        previewUrl: null,
        progress: null,
        phase: IMPORT_PHASE.superseded,
        message:
          'The draft changed while the image was being read, so its result was not applied.',
      }));
    }
  }, [state.progress, getOwnership, getRevision, showPreview, onEnd]);

  return {
    state:
      state.progress?.step === 'generation' &&
      state.progress.revision !== getRevision()
        ? { ...state, progress: null }
        : state,
    importFile,
    dismiss,
    cancelPending,
    retry,
    retryDescription,
    retryControls,
  };
}
