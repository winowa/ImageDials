import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { speedIntervalMs } from '../../data/records/browse.js';
import { VARIANT_KIND } from '../../data/storage/cachePolicy.js';
import {
  createPlayback,
  dwellMs,
  failPlayback,
  forgetFailures,
  peekNext,
  readyPlayback,
  selectPlayback,
  stepPlayback,
  syncPlayback,
} from './galleryPlayback.js';
import {
  describeImage,
  hasSharedMedia,
} from '../../data/records/imageRecord.js';
import { MediaContext } from '../../data/media/variantSrc.js';

const randomSeed = () => Math.floor(Math.random() * 0x100000000);

/**
 * Playback state and its timer.
 *
 * The interval for a shown image starts when its full picture has actually
 * loaded (`ready`), never when it was chosen. Every change that makes the
 * running timer wrong (another image, pausing, speed, hold) re-runs the effect,
 * whose cleanup cancels the old timer, so a stale load cannot start a new one.
 *
 * @param {object} options
 * @param {{key: string, createdAtMs: number|null}[]} options.library all records
 * @param {string[]} options.eligible eligible keys, newest first
 * @param {boolean} options.playing
 * @param {number} options.speedSeconds
 * @param {number} options.holdMs how long a new image stays after it loaded
 * @param {number} [options.seed] fixes the shuffle (tests); random otherwise
 */
export function useGalleryPlayback({
  library,
  eligible,
  playing,
  speedSeconds,
  holdMs,
  seed,
}) {
  const [state, setState] = useState(() =>
    createPlayback(seed ?? randomSeed()),
  );
  const synced = useMemo(
    () => syncPlayback(state, { library, eligible, playing }),
    [state, library, eligible, playing],
  );
  // Adjusting state during render: the synced value is what this render uses.
  if (synced !== state) setState(synced);

  const playingNow = useRef(playing);
  useLayoutEffect(() => {
    playingNow.current = playing;
  });
  const apply = useCallback((change) => setState((s) => change(s)), []);

  const step = useCallback(
    (delta) => apply((s) => stepPlayback(s, delta)),
    [apply],
  );
  const select = useCallback(
    (key) => apply((s) => selectPlayback(s, key)),
    [apply],
  );
  const ready = useCallback(
    (key) => apply((s) => readyPlayback(s, key)),
    [apply],
  );
  const unavailable = useCallback(
    (key) => apply((s) => failPlayback(s, key, playingNow.current)),
    [apply],
  );
  const forget = useCallback(() => apply(forgetFailures), [apply]);

  const { current, loaded, hold } = synced;
  const speedMs = speedIntervalMs(speedSeconds);
  useEffect(() => {
    if (!playing || current === null || loaded !== current) return undefined;
    const wait = dwellMs({ current, hold }, { speedMs, holdMs });
    const timer = setTimeout(() => step(1), wait);
    return () => clearTimeout(timer);
  }, [playing, current, loaded, hold, speedMs, holdMs, step]);

  return {
    order: synced.order,
    current,
    hold,
    loaded,
    failed: synced.failed,
    nextKey: peekNext(synced),
    step,
    select,
    ready,
    unavailable,
    forget,
  };
}

/**
 * Warm the browser (and the variant cache) with ONE upcoming full image. The
 * cache is asked through the same lease the display uses, so a cached copy is
 * only held, never fetched again; a miss loads the network URL once and offers
 * it to the capture queue. Leaving, pausing or choosing another image cancels
 * the request and releases the lease, except when that very image has just
 * become the displayed one (`displayedKey`): its request is then left to finish
 * so the display reuses it.
 */
export function usePreloadImage(record, active, onFail, displayedKey = null) {
  const media = useContext(MediaContext);
  const failure = useRef(onFail);
  const displaying = useRef(displayedKey);
  useLayoutEffect(() => {
    failure.current = onFail;
    displaying.current = displayedKey;
  });
  const view = record ? describeImage(record) : null;
  const key = view?.key ?? null;
  const url = view?.originalUrl ?? '';

  useEffect(() => {
    if (!active || !record || !url) return undefined;
    let cancelled = false;
    let lease = null;
    let probe = null;
    const load = () => {
      probe = new Image();
      probe.onload = () => {
        if (!cancelled && media && hasSharedMedia(record))
          media.capture(record, VARIANT_KIND.FULL, url);
      };
      probe.onerror = () => {
        if (!cancelled) failure.current?.(key);
      };
      probe.src = url;
    };
    if (media && hasSharedMedia(record)) {
      media
        .lease(record, VARIANT_KIND.FULL)
        .catch(() => null)
        .then((held) => {
          if (cancelled) held?.release();
          else if (held) lease = held;
          else load();
        });
    } else load();
    return () => {
      cancelled = true;
      lease?.release();
      if (probe) {
        probe.onload = null;
        probe.onerror = null;
        // The picture being preloaded became the one on screen: the display
        // asks for the same URL, so let the request finish and share it
        // instead of aborting it and downloading the file a second time.
        if (displaying.current !== key) probe.src = '';
      }
    };
    // Keyed by identity: a refreshed record object is no new preload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key, url, media]);
}
