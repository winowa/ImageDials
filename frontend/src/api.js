/**
 * The one HTTP client for the browser. It owns URL construction, JSON handling,
 * error normalisation and aborts. Paths are relative so the dev proxy or a
 * reverse proxy decides where the API lives.
 */

/** Wire spelling of the UI modes. */
import {
  attachDiagnostic,
  boundedValue,
  captureBody,
  redactText,
  httpDiagnostic,
  networkDiagnostic,
} from './diagnostics.js';

export const GENERATION_MODE = { image: 'standard', 'asset-image': 'trellis' };

export const ENDPOINTS = {
  health: '/healthz',
  capabilities: '/api/app-capabilities',
  models: '/api/models',
  browserDefaults: '/api/browser-settings/defaults',
  validateBrowserWatermark: '/api/browser-settings/watermark/validate',
  staticControls: '/api/controls/static',
  dynamicControls: '/api/controls/dynamic',
  generateImage: '/api/generate-image',
  promptSuggestions: '/api/prompt-suggestions',
  addControlOptions: '/api/add-control-options',
  additionalControls: '/api/controls/additional',
  importAnalysis: '/api/images/import-analysis',
  referenceAnalysis: '/api/images/reference-analysis',
  referencePrompt: '/api/images/reference-prompt',
  generationJob: (id) => `/api/generation-jobs/${encodeURIComponent(id)}`,
  generationEvents: (id) =>
    `/api/generation-jobs/${encodeURIComponent(id)}/events`,
  /** Latest status of each child of a variation group; never creates work. */
  generationGroup: (id) => `/api/generation-groups/${encodeURIComponent(id)}`,
  library: '/api/images/library',
  libraryPage: '/api/images/library/page',
  libraryRecord: (imageId) =>
    `/api/images/library/record/${encodeURIComponent(imageId)}`,
  /** Server-sent change stream: an invalidation signal, not event choices. */
  libraryEvents: '/api/images/library/events',
  /** Bounded event names and exact counts for the Gallery's event chooser. */
  libraryEventFacets: '/api/images/library/event-facets',
  gallerySessions: '/api/images/library/shuffle-sessions',
  gallerySession: (id) =>
    `/api/images/library/shuffle-sessions/${encodeURIComponent(id)}`,
  renewGallerySession: (id) =>
    `/api/images/library/shuffle-sessions/${encodeURIComponent(id)}/renew`,
  libraryFile: (storageId, filename) =>
    `/api/images/library/file/${encodeURIComponent(storageId)}/${encodeURIComponent(filename)}`,
  watermarkSettings: '/api/watermark/settings',
  watermarkAnalysis: '/api/images/library/watermark',
  watermarkBackfill: '/api/images/library/watermarks/backfill',
  watermarkBackfillStatus: '/api/images/library/watermarks/status',
  /** Browser-only analysis of uploaded bytes; nothing is stored server-side. */
  watermarkAnalyzeImage: '/api/watermark/analyze-image',
  watermarkMetadata: '/api/watermark/embed-metadata',
  printReady: '/api/images/library/print-ready',
};

export const HTTP_NOT_MODIFIED = 304;

/** Longest raw error body kept for the technical-details disclosure. */
const ERROR_DETAILS_MAX_CHARS = 600;
/** Longest plain-text error body shown as the message itself. */
const ERROR_MESSAGE_MAX_CHARS = 200;
const UNAVAILABLE_STATUSES = new Set([502, 503, 504]);
export const PROVIDER_OVERRIDE_HEADER = 'X-ImageDials-Provider-Overrides';
const MAX_PROVIDER_HEADER_BYTES = 6144;

/** Encode only explicit browser overrides; omitting a field restores its default. */
export function encodeProviderOverrides(overrides) {
  const bytes = new TextEncoder().encode(JSON.stringify(overrides));
  const encoded = btoa(
    Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''),
  );
  if (encoded.length > MAX_PROVIDER_HEADER_BYTES)
    throw new Error('Provider settings exceed the request size limit.');
  return encoded;
}

export class ApiError extends Error {
  /**
   * @param {string} message concise, user-facing text
   * @param {{status?: number, network?: boolean, details?: string|null}} [info]
   */
  constructor(
    message,
    {
      status = 0,
      network = false,
      details = null,
      retryAfterSeconds = null,
      evidence = null,
    } = {},
  ) {
    super(redactText(message));
    this.name = 'ApiError';
    this.status = status;
    this.network = network;
    this.details =
      typeof details === 'string' ? captureBody(details).text : details;
    /** The request and response a failed model call kept, when the server sent them. */
    this.evidence = boundedValue(evidence) ?? null;
    /** A 429/503 `Retry-After` in seconds, when the server sent one. */
    this.retryAfterSeconds = retryAfterSeconds;
  }

  /** The service could not be reached or is not serving (as opposed to rejecting). */
  get unavailable() {
    return this.network || UNAVAILABLE_STATUSES.has(this.status);
  }
}

function detailText(data) {
  const detail = data?.detail ?? data?.error ?? data?.message;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail))
    return detail.map((d) => d?.msg ?? String(d)).join('; ');
  return null;
}

/** Errors may be JSON, plain text, an HTML error page or a network failure. */
function errorFromBody(status, text) {
  let message = null;
  let evidence = null;
  let body = redactText(text);
  try {
    const data = JSON.parse(body);
    message = detailText(data)?.slice(0, ERROR_MESSAGE_MAX_CHARS) ?? null;
    const kept = data?.evidence;
    if (kept && typeof kept === 'object' && !Array.isArray(kept)) {
      // Kept exchanges are inspected in full elsewhere, not as clipped details.
      evidence = kept;
      body = JSON.stringify({ ...data, evidence: undefined });
    }
  } catch {
    /* Not JSON. */
  }
  const trimmed = body.trim();
  const isHtml = /^<(!doctype|html)/i.test(trimmed);
  if (!message && trimmed && !isHtml) {
    message = trimmed.slice(0, ERROR_MESSAGE_MAX_CHARS);
  }
  return new ApiError(message ?? `Request failed (${status}).`, {
    status,
    details: trimmed ? trimmed.slice(0, ERROR_DETAILS_MAX_CHARS) : null,
    evidence,
  });
}

/** Whole seconds from a `Retry-After` header; an HTTP date or junk is null. */
function retryAfterSeconds(headers) {
  const value = headers?.get?.('Retry-After');
  if (value === null || value === undefined || !/^\s*\d+\s*$/.test(value))
    return null;
  return Number(value);
}

/** A query string from defined, non-empty values; camelCase names mapped. */
function queryOf(params, names = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    query.set(names[key] ?? key, String(value));
  }
  const serialized = query.toString();
  return serialized ? `?${serialized}` : '';
}

const EVENT_NAME = { eventName: 'event_name' };

/** A conditional GET with the shape every bounded read returns. */
async function conditionalRead(path, { etag, signal } = {}) {
  const result = await exchange(path, {
    signal,
    headers: etag ? { 'If-None-Match': etag } : undefined,
  });
  return {
    status: result.status,
    notModified: result.notModified,
    etag: result.etag,
    data: result.data,
  };
}

/**
 * One HTTP exchange. A 304 is a normal outcome (`notModified`), not an error.
 * @param {string} path
 * @param {{method?: string, body?: unknown, signal?: AbortSignal, headers?: Record<string, string>}} [options]
 * @returns {Promise<{status: number, notModified: boolean, etag: string|null, data: unknown}>}
 */
async function exchange(
  path,
  {
    method = 'GET',
    body,
    signal,
    headers,
    keepalive,
    captureResponse = false,
  } = {},
) {
  let response;
  try {
    const init = { method, signal, headers: { ...headers } };
    // Lets a release outlive a closing page; only set when asked for.
    if (keepalive) init.keepalive = true;
    if (body instanceof FormData) {
      // The browser supplies the multipart boundary header.
      init.body = body;
    } else if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    response = await fetch(path, init);
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw attachDiagnostic(
      new ApiError('The API is unreachable.', { network: true }),
      networkDiagnostic({ method, path, phase: 'request', cause: error }),
    );
  }
  const etag = response.headers.get('ETag');
  if (response.status === HTTP_NOT_MODIFIED)
    return { status: response.status, notModified: true, etag, data: null };
  let text;
  try {
    text = await response.text();
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw attachDiagnostic(
      new ApiError('The API connection dropped mid-response.', {
        network: true,
      }),
      networkDiagnostic({
        method,
        path,
        phase: 'response',
        cause: error,
        response,
      }),
    );
  }
  if (!response.ok) {
    const error = errorFromBody(response.status, text);
    error.retryAfterSeconds = retryAfterSeconds(response.headers);
    // The exact body is captured here, before parsing reduced it to a message.
    throw attachDiagnostic(
      error,
      httpDiagnostic({ method, path, response, text }),
    );
  }
  const result = {
    status: response.status,
    notModified: false,
    etag,
    diagnostic: captureResponse
      ? httpDiagnostic({
          method,
          path,
          response,
          text,
          category: 'unreadable-response',
        })
      : undefined,
  };
  if (response.status === 204 || !text) return { ...result, data: null };
  try {
    return { ...result, data: JSON.parse(text) };
  } catch {
    throw attachDiagnostic(
      new ApiError('The API returned an unreadable response.', {
        status: response.status,
        details: captureBody(text).text.slice(0, ERROR_DETAILS_MAX_CHARS),
      }),
      httpDiagnostic({
        method,
        path,
        response,
        text,
        category: 'unreadable-response',
      }),
    );
  }
}

/**
 * @param {string} path
 * @param {{method?: string, body?: unknown, signal?: AbortSignal}} [options]
 */
export async function request(path, options) {
  return (await exchange(path, options)).data;
}

export const api = {
  health: (options) => request(ENDPOINTS.health, options),
  capabilities: (options) => request(ENDPOINTS.capabilities, options),
  models: (options) => request(ENDPOINTS.models, options),
  browserDefaults: (options) => request(ENDPOINTS.browserDefaults, options),
  validateBrowserWatermark: (body, options) =>
    request(ENDPOINTS.validateBrowserWatermark, {
      ...options,
      method: 'POST',
      body,
    }),
  staticControls: (mode, { editing = false, ...options } = {}) =>
    request(
      `${ENDPOINTS.staticControls}?generation_mode=${GENERATION_MODE[mode] ?? 'standard'}${editing ? '&image_edit=true' : ''}`,
      options,
    ),
  dynamicControls: (body, options) =>
    request(ENDPOINTS.dynamicControls, { ...options, method: 'POST', body }),
  /** Five LLM-written idea strings for a mode: `{ suggestions, provider }`. */
  promptSuggestions: (mode, options) =>
    request(
      `${ENDPOINTS.promptSuggestions}?generation_mode=${GENERATION_MODE[mode] ?? 'standard'}`,
      options,
    ),
  /**
   * Send `{ control, categories }` (a bare Control is the legacy shape the
   * server still accepts); the response is the enriched Control itself.
   */
  addControlOptions: (body, options) =>
    request(ENDPOINTS.addControlOptions, {
      ...options,
      method: 'POST',
      body,
    }),
  /**
   * New-only controls for the current idea: send `{ prompt, generation_mode,
   * categories, count? }`; the response is `{ controls,
   * additional_controls_metadata }`.
   */
  additionalControls: (body, options) =>
    request(ENDPOINTS.additionalControls, { ...options, method: 'POST', body }),
  /**
   * Analyze an image without saving it: `{ mode: 'metadata', image }` or
   * `{ mode: 'description', prompt, provider }`.
   * @param {File} file
   */
  importAnalysis: (file, { context, ...options } = {}) => {
    const form = new FormData();
    form.append('image', file);
    if (context) form.append('context', JSON.stringify(context));
    return request(ENDPOINTS.importAnalysis, {
      ...options,
      method: 'POST',
      body: form,
    });
  },
  /**
   * Read one reference image for internal metadata. Never proposes edit text
   * and creates no image or job. `context` is
   * `{ prompt, generation_mode, revision, reference_images }`.
   * @param {Blob} image original bytes
   */
  referenceAnalysis: (image, context, { name = 'image', ...options } = {}) => {
    const form = new FormData();
    form.append('image', image, name);
    form.append('context', JSON.stringify(context));
    return request(ENDPOINTS.referenceAnalysis, {
      ...options,
      method: 'POST',
      body: form,
    });
  },
  /** Compose only a prompt from frozen, ordered reference bytes. Never renders. */
  referencePrompt: (context, { references, ...options } = {}) => {
    const form = new FormData();
    form.append('context', JSON.stringify(context));
    for (const [index, ref] of (references ?? []).entries())
      form.append(`reference_${index + 1}`, ref.blob, ref.name || 'reference');
    return request(ENDPOINTS.referencePrompt, {
      ...options,
      method: 'POST',
      body: form,
    });
  },
  /**
   * Checksum-only check of a file's exact bytes, for browsers that cannot hash
   * (plain HTTP). Describes nothing, proposes nothing and stores nothing.
   * @param {Blob} image original bytes
   */
  inspectReference: (image, { name = 'image', ...options } = {}) => {
    const form = new FormData();
    form.append('image', image, name);
    return request(`${ENDPOINTS.referenceAnalysis}?inspect_only=true`, {
      ...options,
      method: 'POST',
      body: form,
    });
  },
  /** JSON for text generation; a FormData body for reference editing. */
  generateImage: (body, options) =>
    request(ENDPOINTS.generateImage, { ...options, method: 'POST', body }),
  generationJob: (id, options) => request(ENDPOINTS.generationJob(id), options),
  /** A variation group's status at `path` (the capability's status URL). */
  generationGroup: (path, options) => request(path, options),
  /**
   * The canonical saved-image list. Pass the last `etag` to receive
   * `notModified` instead of the unchanged list.
   * @param {{etag?: string|null, signal?: AbortSignal}} [options]
   */
  library: async ({ etag, signal } = {}) => {
    const result = await exchange(ENDPOINTS.library, {
      signal,
      headers: etag ? { 'If-None-Match': etag } : undefined,
    });
    return {
      notModified: result.notModified,
      etag: result.etag,
      library: result.data,
    };
  },
  /** Read one bounded summary page; summary rows are not full saved records. */
  libraryPage: async (params = {}, { etag, signal } = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      const name = key === 'eventName' ? 'event_name' : key;
      query.set(name, String(value));
    }
    const serialized = query.toString();
    const suffix = serialized ? `?${serialized}` : '';
    const result = await exchange(`${ENDPOINTS.libraryPage}${suffix}`, {
      signal,
      headers: etag ? { 'If-None-Match': etag } : undefined,
    });
    return {
      notModified: result.notModified,
      etag: result.etag,
      page: result.data,
    };
  },
  /** Read exact full provenance for a selected shared image, independently conditional. */
  libraryRecord: async (imageId, { eventName, etag, signal } = {}) => {
    const query = new URLSearchParams();
    if (eventName) query.set('event_name', eventName);
    const serialized = query.toString();
    const suffix = serialized ? `?${serialized}` : '';
    const result = await exchange(
      `${ENDPOINTS.libraryRecord(imageId)}${suffix}`,
      {
        signal,
        headers: etag ? { 'If-None-Match': etag } : undefined,
      },
    );
    return {
      notModified: result.notModified,
      etag: result.etag,
      record: result.data,
    };
  },
  /**
   * One bounded page of event names with exact counts, plus the selected
   * scope's orientation counts and total. `q` searches names literally.
   * @param {{limit?: number, cursor?: string|null, q?: string, eventName?: string|null}} params
   */
  libraryEventFacets: async (params = {}, options = {}) => {
    const result = await conditionalRead(
      `${ENDPOINTS.libraryEventFacets}${queryOf(params, EVENT_NAME)}`,
      options,
    );
    return {
      notModified: result.notModified,
      etag: result.etag,
      facets: result.data,
    };
  },
  /**
   * Ask for one shuffled snapshot. The answer (202) is `building`; read it
   * until it is ready. `firstImageId` anchors rank zero when it is a member.
   * @param {{eventName?: string|null, orientations?: string[]|null, firstImageId?: string|null}} body
   */
  createGallerySession: (
    { eventName, orientations, firstImageId } = {},
    options,
  ) => {
    const body = {};
    if (eventName) body.event_name = eventName;
    if (Array.isArray(orientations)) body.orientations = orientations;
    if (firstImageId) body.first_image_id = firstImageId;
    return request(ENDPOINTS.gallerySessions, {
      ...options,
      method: 'POST',
      body,
    });
  },
  /**
   * One bounded page of a session in ascending rank order, or its building or
   * failed status. `status` 202 means it is still building.
   * @param {string} id
   * @param {{rank?: number, direction?: 'forward'|'backward', limit?: number, eventName?: string|null}} params
   */
  readGallerySession: async (id, params = {}, options = {}) => {
    const result = await conditionalRead(
      `${ENDPOINTS.gallerySession(id)}${queryOf(params, EVENT_NAME)}`,
      options,
    );
    return {
      status: result.status,
      notModified: result.notModified,
      etag: result.etag,
      session: result.data,
    };
  },
  /** Extend an active session's lease; the server decides the duration. */
  renewGallerySession: (id, { eventName } = {}, options) =>
    request(
      `${ENDPOINTS.renewGallerySession(id)}${queryOf({ eventName }, EVENT_NAME)}`,
      { ...options, method: 'POST' },
    ),
  /** Release one session's membership. It never deletes an image. */
  releaseGallerySession: (id, { eventName, keepalive = false } = {}) =>
    request(
      `${ENDPOINTS.gallerySession(id)}${queryOf({ eventName }, EVENT_NAME)}`,
      {
        method: 'DELETE',
        keepalive,
      },
    ),
  /** Shared watermark content plus the server's rendering policy and limits. */
  watermarkSettings: (options) => request(ENDPOINTS.watermarkSettings, options),
  /**
   * Save text `{type, text}` or SVG `{type, svg_markup, svg_recolor}`; the
   * response is the complete normalised settings.
   */
  saveWatermarkSettings: (body, options) =>
    request(ENDPOINTS.watermarkSettings, { ...options, method: 'PUT', body }),
  /**
   * Deterministic placement analysis for one saved image. An analysis that is
   * still current is returned as `existing` unless `force` is set.
   * @returns {Promise<{status: string, print_watermark: object, image: object}>}
   */
  analyzeWatermark: ({ storage_id, filename, force = false }, options) =>
    request(ENDPOINTS.watermarkAnalysis, {
      ...options,
      method: 'POST',
      body: { storage_id, filename, force },
    }),
  /**
   * Analyze image bytes that exist only in this browser. The upload is
   * discarded by the server; `force` regenerates its cached analysis.
   * @param {Blob} image PNG, JPEG or WebP bytes
   * @returns {Promise<{print_watermark: object, print_watermark_key: string,
   *   source_sha256: string, dimensions: object, watermark_settings: object,
   *   storage: 'transient'}>}
   */
  analyzeWatermarkImage: (
    image,
    { force = false, watermarkSettings, previousAnalysis, ...options } = {},
  ) => {
    const form = new FormData();
    form.append('image', image, 'image');
    if (previousAnalysis !== undefined)
      form.append('previous_analysis', JSON.stringify(previousAnalysis));
    if (watermarkSettings !== undefined)
      form.append('watermark_settings', JSON.stringify(watermarkSettings));
    return request(
      force
        ? `${ENDPOINTS.watermarkAnalyzeImage}?force=true`
        : ENDPOINTS.watermarkAnalyzeImage,
      { ...options, method: 'POST', body: form },
    );
  },
  /** Add source and watermark provenance to a separate rendered PNG, without saving server state. */
  embedWatermarkMetadata: (file, metadata, options) => {
    const form = new FormData();
    form.append('file', file, 'watermarked.png');
    form.append('metadata', JSON.stringify(metadata));
    return fetchBlob(ENDPOINTS.watermarkMetadata, {
      ...options,
      method: 'POST',
      body: form,
    });
  },
  /**
   * Queue analysis (not prepared files) for the library; 409 while one runs.
   * `asyncPreparation` asks for the fast 202 admission whose total is unknown
   * until analysis starts; omit it for the legacy exact-count 200 response.
   */
  queueWatermarkBackfill: (
    { force = false, asyncPreparation = false } = {},
    options,
  ) =>
    request(ENDPOINTS.watermarkBackfill, {
      ...options,
      method: 'POST',
      body: asyncPreparation ? { force, async_preparation: true } : { force },
    }),
  /**
   * Bounded progress of the shared analysis batch (never the library list).
   * Pass the last `etag`; an unchanged status answers `notModified`.
   * @returns {Promise<{notModified: boolean, etag: string|null, backfill: object|null}>}
   */
  watermarkBackfillStatus: async ({ etag, signal } = {}) => {
    const result = await exchange(ENDPOINTS.watermarkBackfillStatus, {
      signal,
      headers: etag ? { 'If-None-Match': etag } : undefined,
      captureResponse: true,
    });
    if (result.notModified)
      return {
        notModified: true,
        etag: result.etag ?? etag ?? null,
        backfill: null,
      };
    const backfill = result.data?.watermark_backfill;
    if (
      !Object.hasOwn(result.data ?? {}, 'watermark_backfill') ||
      (backfill !== null &&
        (typeof backfill !== 'object' ||
          Array.isArray(backfill) ||
          typeof backfill.id !== 'string' ||
          !backfill.id ||
          !['queued', 'running', 'complete', 'failed'].includes(
            backfill.status,
          )))
    )
      throw attachDiagnostic(
        new ApiError('The analysis status was unreadable.', {
          status: result.status,
        }),
        {
          ...result.diagnostic,
          reason:
            'The response did not have the expected analysis status shape.',
        },
      );
    return { notModified: false, etag: result.etag, backfill };
  },
  /**
   * Upload the browser-rendered source-size PNG for the current key.
   * @param {{storage_id: string, filename: string, watermark_key: string, file: Blob}} upload
   * @returns {Promise<{image: object}>}
   */
  uploadPrintReady: (upload, options) => {
    const form = new FormData();
    form.append('storage_id', upload.storage_id);
    form.append('filename', upload.filename);
    form.append('watermark_key', upload.watermark_key);
    form.append('file', upload.file, 'print-ready.png');
    return request(ENDPOINTS.printReady, {
      ...options,
      method: 'POST',
      body: form,
    });
  },
  /** Delete by exact storage identity. */
  deleteLibraryImage: ({ storage_id, filename }) =>
    request(ENDPOINTS.library, {
      method: 'DELETE',
      body: { storage_id, filename },
    }),
};

/**
 * Read a binary response (an original or a prepared PNG). Failures are
 * normalised like JSON exchanges, so a missing file is an `ApiError` with its
 * status.
 * @param {string} path
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<Blob>}
 */
export async function fetchBlob(path, { signal, ...options } = {}) {
  let response;
  try {
    response = await fetch(path, { ...options, signal });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw attachDiagnostic(
      new ApiError('The API is unreachable.', { network: true }),
      networkDiagnostic({
        method: options.method,
        path,
        phase: 'request',
        cause: error,
      }),
    );
  }
  if (!response.ok) {
    let text;
    try {
      text = await response.text();
    } catch (cause) {
      if (cause?.name === 'AbortError') throw cause;
      throw attachDiagnostic(
        new ApiError('The API connection dropped mid-response.', {
          network: true,
        }),
        networkDiagnostic({
          method: options.method,
          path,
          phase: 'response',
          cause,
          response,
        }),
      );
    }
    throw attachDiagnostic(
      errorFromBody(response.status, text),
      httpDiagnostic({ method: options.method, path, response, text }),
    );
  }
  try {
    return await response.blob();
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw attachDiagnostic(
      new ApiError('The API connection dropped mid-response.', {
        network: true,
      }),
      networkDiagnostic({
        method: options.method,
        path,
        phase: 'response',
        cause: error,
        response,
      }),
    );
  }
}

export function newKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
