import React, { useEffect, useState } from 'react';

import {
  PHRASE_INTERVAL_MS,
  PHRASE_LEAVE_MS,
  sharedPhraseBag,
} from './generationPhrases.js';

const calm = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/**
 * Rotating decorative line for the stage. It exists only while a generation is
 * waiting, so mounting starts the rotation and unmounting (preview, completion,
 * failure, route change) stops it. It is not a live region: the real progress
 * steps announce status, these lines are never read out as updates.
 */
export default function GenerationPhrase({
  bag = sharedPhraseBag(),
  intervalMs = PHRASE_INTERVAL_MS,
}) {
  const [view, setView] = useState({ current: null, leaving: null });

  useEffect(() => {
    let leaveTimer = null;
    const show = (first) => {
      const next = bag.next();
      const instant = first || calm();
      setView((prev) => ({
        current: next,
        leaving: instant ? null : prev.current,
      }));
      clearTimeout(leaveTimer);
      leaveTimer = instant
        ? null
        : setTimeout(
            () => setView((v) => ({ ...v, leaving: null })),
            PHRASE_LEAVE_MS,
          );
    };
    show(true);
    const tick = setInterval(() => show(false), intervalMs);
    return () => {
      clearInterval(tick);
      clearTimeout(leaveTimer);
    };
  }, [bag, intervalMs]);

  if (!view.current) return null;
  return (
    <div className="stage-wait">
      {view.leaving ? (
        <p
          className="stage-phrase"
          data-state="leaving"
          aria-hidden="true"
          key={`out:${view.leaving}`}
        >
          {view.leaving}
        </p>
      ) : null}
      <p
        className="stage-phrase"
        data-state="current"
        key={`in:${view.current}`}
      >
        {view.current}
      </p>
    </div>
  );
}
