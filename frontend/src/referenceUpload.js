/** Header inspection never decodes large pixels in the browser. Unknown formats
 * use the analysis pixel-limit response as the fallback trigger. */
import { ApiError } from './api.js';
import {
  attachDiagnostic,
  httpDiagnostic,
  networkDiagnostic,
  localDiagnostic,
} from './diagnostics.js';

export async function referenceHeaderSize(file) {
  const bytes = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
  const view = new DataView(bytes.buffer);
  if (
    bytes.length >= 24 &&
    view.getUint32(0) === 0x89504e47 &&
    view.getUint32(4) === 0x0d0a1a0a
  )
    return { width: view.getUint32(16), height: view.getUint32(20) };
  if (
    bytes.length >= 30 &&
    view.getUint32(0) === 0x52494646 &&
    view.getUint32(8) === 0x57454250
  ) {
    const kind = view.getUint32(12);
    if (kind === 0x56503858)
      return {
        width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16),
        height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16),
      };
    if (
      kind === 0x56503820 &&
      bytes[23] === 0x9d &&
      bytes[24] === 1 &&
      bytes[25] === 0x2a
    )
      return {
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
      };
    if (kind === 0x5650384c && bytes[20] === 0x2f) {
      const bits = view.getUint32(21, true);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1,
      };
    }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 < bytes.length && bytes[at] === 0xff) {
      while (bytes[at] === 0xff) at++;
      const marker = bytes[at++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = view.getUint16(at);
      if (length < 2) break;
      if (
        [
          0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd,
          0xce, 0xcf,
        ].includes(marker)
      )
        return {
          width: view.getUint16(at + 5),
          height: view.getUint16(at + 3),
        };
      at += length;
    }
  }
  return null;
}

export const pixelLimitFailure = (error) =>
  error?.status === 413 && /decoded pixel limit/i.test(error.message);

/** Transient binary adaptation, with exact source and model identities. */
export async function adaptReference(
  file,
  { signal, maxNormalizedBytes } = {},
) {
  const body = new FormData();
  body.append('file', file, file.name || 'reference');
  let response;
  const query = Number.isSafeInteger(maxNormalizedBytes)
    ? `?max_normalized_bytes=${maxNormalizedBytes}`
    : '';
  const path = `/api/images/reference-adapt${query}`;
  try {
    response = await fetch(path, {
      method: 'POST',
      body,
      signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw attachDiagnostic(
      new ApiError('The API is unreachable.', { network: true }),
      networkDiagnostic({ method: 'POST', path, cause: error }),
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
          method: 'POST',
          path,
          phase: 'response',
          cause,
          response,
        }),
      );
    }
    let message = text;
    try {
      message = JSON.parse(text).detail || text;
    } catch {
      /* Plain error. */
    }
    throw attachDiagnostic(
      new ApiError(message || 'The smaller copy could not be prepared.', {
        status: response.status,
      }),
      httpDiagnostic({ method: 'POST', path, response, text }),
    );
  }
  const descriptor = (prefix) => ({
    sha256: response.headers.get(`X-${prefix}-SHA256`),
    width: Number(response.headers.get(`X-${prefix}-Width`)),
    height: Number(response.headers.get(`X-${prefix}-Height`)),
  });
  const source = {
    ...descriptor('Source'),
    ...(maxNormalizedBytes ? { max_normalized_bytes: maxNormalizedBytes } : {}),
  };
  if (
    !/^[0-9a-f]{64}$/.test(source.sha256 || '') ||
    !(source.width > 0 && source.height > 0)
  )
    throw attachDiagnostic(
      new Error('The original file identity response was incomplete.'),
      localDiagnostic({
        category: 'reference-adaptation',
        reason: 'The original file identity response was incomplete.',
        facts: { status: response.status },
        data: source,
      }),
    );
  if (response.status === 204)
    return {
      blob: file,
      sha256: source.sha256,
      dimensions: { width: source.width, height: source.height },
    };
  const adapted = descriptor('Adapted');
  let blob;
  try {
    blob = await response.blob();
  } catch (cause) {
    if (cause?.name === 'AbortError') throw cause;
    throw attachDiagnostic(
      new ApiError('The API connection dropped mid-response.', {
        network: true,
      }),
      networkDiagnostic({
        method: 'POST',
        path,
        phase: 'response',
        cause,
        response,
      }),
    );
  }
  if (
    !blob.size ||
    !/^[0-9a-f]{64}$/.test(adapted.sha256 || '') ||
    !(adapted.width > 0 && adapted.height > 0) ||
    !/^[0-9a-f]{64}$/.test(source.sha256 || '') ||
    !(source.width > 0 && source.height > 0)
  )
    throw attachDiagnostic(
      new Error('The smaller copy response was incomplete.'),
      localDiagnostic({
        category: 'reference-adaptation',
        reason: 'The model copy response was incomplete.',
        facts: { status: response.status, bytes: blob.size },
        data: { source, adapted },
      }),
    );
  return {
    blob,
    sha256: adapted.sha256,
    dimensions: { width: adapted.width, height: adapted.height },
    source,
    original: {
      blob: file,
      originalFile: file,
      sha256: source.sha256,
      dimensions: { width: source.width, height: source.height },
    },
  };
}

/** Reserve an equal share for every eligible slot so additions never silently
 * change an already attached copy, its checksum, preview or frozen retry. */
export function referenceByteBudget(capability) {
  const perItem = capability?.maxImageBytes;
  const total = capability?.maxTotalBytes;
  const slots = capability?.maxReferences;
  if (!(perItem > 0 && total > 0 && slots > 0)) return undefined;
  return Math.max(1024, Math.floor(Math.min(perItem, total / slots)));
}

export async function prepareReference(file, uploads, options = {}) {
  const size = await referenceHeaderSize(file);
  // A conservative PNG upper bound avoids a round trip for small images.
  // Larger sources are measured on the server, never decoded on the UI thread.
  const normalizedBound = size
    ? size.width * size.height * 4 * 1.002 + size.height + 1024
    : 0;
  if (
    size &&
    ((uploads?.max_decoded_pixels &&
      size.width * size.height > uploads.max_decoded_pixels) ||
      (options.maxNormalizedBytes &&
        normalizedBound > options.maxNormalizedBytes))
  )
    return adaptReference(file, options);
  return { blob: file };
}
