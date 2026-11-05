/**
 * The playful lines shown on the stage while an image is being made. They are
 * decoration only: they never describe real provider progress, and a person
 * sees them in a shuffled order with no repeat until every line has been shown.
 */
import shared from '../../shared/generation-phrases.json';

export const PHRASE_INTERVAL_MS = shared.interval_ms;

/** Time an outgoing line stays on screen while the next one enters. */
export const PHRASE_LEAVE_MS = 320;

const usable = (list) =>
  Array.from(
    new Set(
      (Array.isArray(list) ? list : [])
        .filter((p) => typeof p === 'string')
        .map((p) => p.trim())
        .filter(Boolean),
    ),
  );

export const PHRASES = Object.freeze(usable(shared.phrases));

function shuffled(items, random) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * A shuffled bag. Each cycle shows every line once; a new cycle never starts
 * with the line that ended the previous one. `next()` never returns the same
 * line twice in a row unless the bag holds only one line.
 */
export function createPhraseBag(phrases = PHRASES, random = Math.random) {
  const pool = usable(phrases);
  let queue = [];
  let last = null;
  return {
    size: pool.length,
    next() {
      if (!pool.length) return '';
      if (!queue.length) {
        queue = shuffled(pool, random);
        // `pop()` serves the end of the queue first.
        if (pool.length > 1 && queue[queue.length - 1] === last) {
          [queue[0], queue[queue.length - 1]] = [
            queue[queue.length - 1],
            queue[0],
          ];
        }
      }
      last = queue.pop();
      return last;
    },
  };
}

let sharedBag = null;

/** The one bag every generation shares, so variety carries across jobs. */
export function sharedPhraseBag() {
  sharedBag ??= createPhraseBag();
  return sharedBag;
}

/** Forget the shared bag's position (tests only). */
export function resetSharedPhraseBag() {
  sharedBag = null;
}
