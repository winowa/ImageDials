import { createContext, useContext, useEffect, useState } from 'react';

import { variantId } from './cachePolicy.js';
import { hasSharedMedia, imageKey } from './imageRecord.js';

/** The variant cache for shared-library images; null means network only. */
export const MediaContext = createContext(null);

/**
 * Where to find one variant of a saved image:
 * - `bypass`: not cacheable here (no cache, or not a shared-library file);
 *   use the network URL at once.
 * - `pending`: the cache is being asked; show nothing yet.
 * - `hit`: display `url`, a leased object URL of the cached bytes.
 * - `miss`: use the network URL, then offer it to `media.capture`.
 *
 * The lease is acquired in an effect and released by the effect cleanup of the
 * state that holds it, so a new lease is committed before the old one goes and
 * React StrictMode's mount/cleanup/mount cannot leak or double-release.
 */
export function useVariantLookup(record, kind) {
  const media = useContext(MediaContext);
  const id =
    media && (media.accepts?.(record) ?? hasSharedMedia(record))
      ? JSON.stringify([
          variantId(imageKey(record), kind),
          record.local_added_at ?? null,
        ])
      : null;
  const [resolved, setResolved] = useState({ id: null, lease: null });

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const read = id
      ? media.lease(record, kind, { signal: controller.signal })
      : Promise.resolve(null);
    read
      .catch(() => null)
      .then((lease) => {
        if (cancelled) lease?.release();
        else setResolved({ id, lease });
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
    // Keyed by variant identity: a new object for the same image is no new lookup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, media]);

  useEffect(() => () => resolved.lease?.release(), [resolved]);

  if (!id) return { status: 'bypass', media: null };
  if (resolved.id === id)
    return resolved.lease
      ? { status: 'hit', url: resolved.lease.url, media }
      : { status: 'miss', media };
  const url = media.peek(record, kind);
  return url ? { status: 'hit', url, media } : { status: 'pending', media };
}
