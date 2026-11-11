import { THUMBNAIL_MAX_PIXELS } from '../records/imageRecord.js';
import { decodeImage } from '../../features/watermarks/watermarkRenderer.js';

/** Encoding quality of the list thumbnail (JPEG). */
export const THUMBNAIL_JPEG_QUALITY = 0.82;
const THUMBNAIL_BACKGROUND = '#ffffff';

/**
 * A white-backed JPEG whose longest side is at most `maxPixels`, made from the
 * original bytes (which are never modified). Transparent areas are flattened
 * onto white, as the shared library's thumbnails are. Resolves null when this
 * browser cannot decode or draw the image; the original is still stored.
 * @param {Blob} blob
 * @returns {Promise<Blob|null>}
 */
export async function makeThumbnail(blob, maxPixels = THUMBNAIL_MAX_PIXELS) {
  let image;
  try {
    image = await decodeImage(blob);
    const width = image.width ?? image.naturalWidth;
    const height = image.height ?? image.naturalHeight;
    if (!(width > 0 && height > 0)) return null;
    const scale = Math.min(1, maxPixels / Math.max(width, height));
    const target = {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
    };
    const canvas = document.createElement('canvas');
    canvas.width = target.width;
    canvas.height = target.height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.fillStyle = THUMBNAIL_BACKGROUND;
    context.fillRect(0, 0, target.width, target.height);
    context.drawImage(image, 0, 0, target.width, target.height);
    return await new Promise((resolve) =>
      canvas.toBlob(
        (result) => resolve(result?.size ? result : null),
        'image/jpeg',
        THUMBNAIL_JPEG_QUALITY,
      ),
    );
  } catch {
    return null;
  } finally {
    image?.close?.();
  }
}

/** Lower-case hex SHA-256 of the bytes, or null where `crypto.subtle` is absent (plain HTTP). */
export async function sha256Hex(blob) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const digest = await subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
