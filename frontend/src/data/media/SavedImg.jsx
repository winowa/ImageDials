import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { VARIANT_KIND } from '../storage/cachePolicy.js';
import {
  describeImage,
  imageKey,
  isBrowserUpload,
} from '../records/imageRecord.js';
import { useVariantLookup } from './variantSrc.js';
import WatermarkMark from './WatermarkMark.jsx';

/**
 * A saved image from the canonical file route. `variant="thumbnail"` asks for
 * the small JPEG and falls back to the original bytes if that cannot load.
 * With `watermark` ({settings, placement?}) the shared watermark is drawn over
 * the displayed image; the container must be positioned.
 */
export function SavedImg({
  image,
  className,
  loading = 'lazy',
  variant = 'thumbnail',
  watermark = null,
  onReady = undefined,
  onUnavailable = undefined,
}) {
  const [failedUrls, setFailedUrls] = useState([]);
  const imgRef = useRef(null);
  const view = describeImage(image);
  const kind =
    variant === 'original' ? VARIANT_KIND.FULL : VARIANT_KIND.THUMBNAIL;
  const lookup = useVariantLookup(image, kind);
  const privateMedia =
    Number.isFinite(image.local_added_at) &&
    lookup.media?.accepts?.(image) === true;
  const localOnly = privateMedia || isBrowserUpload(image);
  const privateIdentity = privateMedia
    ? JSON.stringify([imageKey(image), image.local_added_at])
    : null;
  const [recovery, setRecovery] = useState({
    identity: null,
    lease: null,
    loading: false,
  });
  const recoveryAttempt = useRef({
    identity: null,
    attempted: false,
    controller: null,
  });
  const localUrl = isBrowserUpload(image)
    ? variant === 'original'
      ? view.originalUrl
      : view.thumbnailUrl
    : '';
  const networkSources = localOnly
    ? localUrl.startsWith('blob:')
      ? [localUrl]
      : []
    : variant === 'original'
      ? [view.originalUrl]
      : [view.thumbnailUrl, view.originalUrl];
  useEffect(() => {
    if (recoveryAttempt.current.identity === privateIdentity) return;
    recoveryAttempt.current.controller?.abort();
    recoveryAttempt.current = {
      identity: privateIdentity,
      attempted: false,
      controller: null,
    };
    setRecovery({ identity: privateIdentity, lease: null, loading: false });
  }, [privateIdentity]);
  useEffect(() => () => recoveryAttempt.current.controller?.abort(), []);
  useEffect(() => () => recovery.lease?.release(), [recovery]);
  // A cached copy that failed to display is dropped and the network takes over.
  const cachedUrl =
    lookup.status === 'hit' && !failedUrls.includes(lookup.url)
      ? lookup.url
      : null;
  const recoveredUrl =
    recovery.identity === privateIdentity
      ? (recovery.lease?.url ?? null)
      : null;
  const pending =
    lookup.status === 'pending' ||
    (recovery.identity === privateIdentity && recovery.loading);
  const src = pending
    ? undefined
    : recoveredUrl && !failedUrls.includes(recoveredUrl)
      ? recoveredUrl
      : [cachedUrl, ...networkSources].find(
          (url) => url && !failedUrls.includes(url),
        );
  const unavailable = !pending && !src;
  const report = useRef(onUnavailable);
  useLayoutEffect(() => {
    report.current = onUnavailable;
  });
  // Reported once every source (cache and network) has failed.
  useEffect(() => {
    if (unavailable) report.current?.();
  }, [unavailable]);
  if (unavailable)
    return (
      <div
        className={`img-missing ${className ?? ''}`}
        role="img"
        aria-label={view.title}
      >
        Image unavailable
      </div>
    );
  const onLoad = () => {
    // Only the network copy of the variant that was asked for is worth keeping.
    if (src === networkSources[0] && lookup.status === 'miss')
      lookup.media.capture(image, kind, src);
    onReady?.(src);
  };
  const onError = () => {
    if (src === cachedUrl) lookup.media.drop(image, kind);
    setFailedUrls((urls) => [...urls, src]);
    const attempt = recoveryAttempt.current;
    if (
      privateIdentity &&
      kind === VARIANT_KIND.THUMBNAIL &&
      attempt.identity === privateIdentity &&
      !attempt.attempted &&
      typeof lookup.media?.recoverThumbnail === 'function'
    ) {
      attempt.attempted = true;
      const controller = new AbortController();
      attempt.controller = controller;
      setRecovery({ identity: privateIdentity, lease: null, loading: true });
      lookup.media
        .recoverThumbnail(image, { signal: controller.signal })
        .then((lease) => {
          if (controller.signal.aborted) {
            lease?.release();
            return;
          }
          setRecovery({ identity: privateIdentity, lease, loading: false });
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setRecovery({
              identity: privateIdentity,
              lease: null,
              loading: false,
            });
        });
    }
  };
  return (
    <>
      <img
        ref={imgRef}
        className={pending ? `${className ?? ''} img-pending` : className}
        src={src}
        alt={image.alt_text || image.title || image.prompt}
        width={view.size?.width}
        height={view.size?.height}
        loading={loading}
        decoding="async"
        onLoad={onLoad}
        onError={onError}
      />
      {watermark ? (
        <WatermarkMark
          image={image}
          imgRef={imgRef}
          settings={watermark.settings}
          placement={watermark.placement}
        />
      ) : null}
    </>
  );
}
