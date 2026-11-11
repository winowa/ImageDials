/**
 * The one reader of a saved image's ORIGINAL bytes, for downloading and for
 * credential inspection. Never the thumbnail or a prepared, watermarked or
 * re-encoded copy.
 *
 * Order: a browser-only image uses its local bytes and never a wire URL; a
 * shared image uses the cached original when present, else the canonical file
 * route. Nothing is stored or written here.
 */
import { fetchBlob as networkFetchBlob } from '../api/api.js';
import { VARIANT_KIND } from '../storage/cachePolicy.js';
import { isLocalOnly, originalUrl } from '../records/imageRecord.js';

export class OriginalUnavailableError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'OriginalUnavailableError';
  }
}

const abortError = () => new DOMException('Aborted', 'AbortError');

/**
 * @param {object} image library record
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {{blob: Function}|null} [options.media] the variant cache, if any
 * @param {(record: object, options: object) => Promise<Blob|null>} [options.readLocal]
 *   reads the bytes of a browser-only image
 * @param {(url: string, options: object) => Promise<Blob>} [options.fetchBlob]
 * @returns {Promise<Blob>}
 */
export async function readOriginalBytes(
  image,
  { signal, media = null, readLocal = null, fetchBlob = networkFetchBlob } = {},
) {
  if (signal?.aborted) throw abortError();
  let blob;
  if (isLocalOnly(image)) {
    try {
      blob = readLocal ? await readLocal(image, { signal }) : null;
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      throw new OriginalUnavailableError(
        `The original could not be read from this browser. ${error.message}`,
        error,
      );
    }
    if (!blob?.size)
      throw new OriginalUnavailableError(
        'The original bytes of this image are not stored in this browser.',
      );
  } else {
    blob = await media?.blob(image, VARIANT_KIND.FULL).catch(() => null);
    if (!blob) {
      const url = originalUrl(image);
      if (!url)
        throw new OriginalUnavailableError('This image has no original file.');
      blob = await fetchBlob(url, { signal });
      if (!blob?.size)
        throw new OriginalUnavailableError('The original file is empty.');
    }
  }
  if (signal?.aborted) throw abortError();
  return blob;
}
