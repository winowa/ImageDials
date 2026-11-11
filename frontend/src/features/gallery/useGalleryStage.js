import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { resolveTransition } from './galleryEffects.js';
import {
  createStage,
  readyStage,
  retargetStage,
  settleStage,
  stageLayers,
  visibleEntry,
} from './galleryStage.js';

/**
 * Drives the stage layers for the wanted `image`.
 *
 * @param {object} options
 * @param {string|null} options.key identity of the wanted picture
 * @param {object|null} options.record its library record
 * @param {1|-1} options.direction travel direction for directional effects
 * @param {string[]} options.effectIds the viewer's chosen effects, run together (empty: Instant)
 * @param {boolean} options.reducedMotion
 * @returns {{layers: object[], visible: object|null, ready: (key: string, picture?: HTMLImageElement|null, instant?: boolean) => void, effect: object|null, direction: 1|-1}}
 */
export function useGalleryStage({
  key,
  record,
  direction,
  effectIds,
  reducedMotion,
}) {
  const [state, setState] = useState(createStage);
  const entry = key && record ? { key, record } : null;
  let next = retargetStage(state, entry, direction);
  // Reduced motion (also switched on mid-effect) leaves no effect running.
  if (reducedMotion) next = settleStage(next);
  // Adjusting state during render: this render already uses the new layers.
  if (next !== state) setState(next);

  // Latest choices, read when a load completes rather than when it began.
  const choice = useRef({ effectIds, reducedMotion });
  useLayoutEffect(() => {
    choice.current = { effectIds, reducedMotion };
  });

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const ready = useCallback((readyKey, picture = null, instant = false) => {
    const start = () => {
      if (!alive.current) return;
      const { effectIds: ids, reducedMotion: reduced } = choice.current;
      setState((s) =>
        readyStage(s, readyKey, resolveTransition(instant ? [] : ids, reduced)),
      );
    };
    // Decode first so the effect never starts on an undecoded picture. The
    // check for a late load happens in `readyStage` when this resolves.
    const decoding = picture?.decode?.();
    if (decoding) decoding.then(start, start);
    else start();
  }, []);

  // The running effect ends after its duration; a new target or a reduced
  // motion preference settles it sooner (see `retargetStage`, below).
  const effect = state.effect;
  const enteringKey = state.incoming?.key ?? null;
  useEffect(() => {
    if (!effect) return undefined;
    const timer = setTimeout(
      () => setState((s) => settleStage(s)),
      effect.durationMs,
    );
    return () => clearTimeout(timer);
  }, [effect, enteringKey]);

  return {
    layers: stageLayers(next),
    visible: visibleEntry(next),
    ready,
    effect,
    direction: state.direction,
  };
}
