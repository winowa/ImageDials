/**
 * The Gallery stage's layers as a pure state machine.
 *
 * The picture on screen stays until its replacement has fully loaded. The
 * replacement is mounted hidden (`incoming`, role `loading`); only when it
 * reports ready does a moving effect start (`incoming` is then `entering`, the
 * old picture `exiting`). A new target at any moment settles a running effect
 * at once and abandons a replacement that never became ready, so nothing can
 * be left half-animated or swapped in late.
 *
 * Entries are `{key, record}`; layers are keyed by `key`, so a layer keeps its
 * element (and its already loaded picture) while changing role.
 */

export const LAYER_ROLE = Object.freeze({
  SHOWN: 'shown',
  LOADING: 'loading',
  ENTERING: 'entering',
  EXITING: 'exiting',
});

/**
 * @typedef {{key: string, record: object}} StageEntry
 * @typedef {object} StageState
 * @property {StageEntry|null} shown settled picture
 * @property {StageEntry|null} incoming replacement, loading or entering
 * @property {StageEntry|null} outgoing picture leaving while `incoming` enters
 * @property {object|null} effect the running effect
 * @property {1|-1} direction travel direction of directional effects
 */

/** @returns {StageState} */
export const createStage = () => ({
  shown: null,
  incoming: null,
  outgoing: null,
  effect: null,
  direction: 1,
});

export const isTransitioning = (state) => state.effect !== null;

/** A running effect ends: the entering picture is the settled one. */
export function settleStage(state) {
  if (!isTransitioning(state)) return state;
  return {
    ...state,
    shown: state.incoming,
    incoming: null,
    outgoing: null,
    effect: null,
  };
}

/**
 * The picture to show is now `entry` (null: nothing to show).
 * @param {StageState} state
 * @param {StageEntry|null} entry
 * @param {1|-1} [direction]
 */
export function retargetStage(state, entry, direction = 1) {
  if (!entry) {
    const empty = !state.shown && !state.incoming && !state.outgoing;
    return empty && !state.effect ? state : createStage();
  }
  // The picture already entering is the target: only refresh its record.
  if (isTransitioning(state) && state.incoming.key === entry.key)
    return state.incoming.record === entry.record
      ? state
      : { ...state, incoming: entry };
  const settled = settleStage(state);
  if (settled.shown?.key === entry.key) {
    // The wanted picture is already shown: drop any replacement still loading.
    if (settled.incoming === null && settled.shown.record === entry.record)
      return settled;
    return { ...settled, shown: entry, incoming: null };
  }
  if (settled.incoming?.key === entry.key)
    return settled.incoming.record === entry.record
      ? settled
      : { ...settled, incoming: entry };
  return { ...settled, incoming: entry, direction };
}

/**
 * The replacement `key` has loaded. A key that is no longer the replacement
 * (a late load) changes nothing.
 * @param {StageState} state
 * @param {string} key
 * @param {{animated: boolean}} effect the effect for this change
 */
export function readyStage(state, key, effect) {
  if (isTransitioning(state) || state.incoming?.key !== key) return state;
  if (!state.shown || !effect.animated)
    return {
      ...state,
      shown: state.incoming,
      incoming: null,
      outgoing: null,
      effect: null,
    };
  return { ...state, outgoing: state.shown, shown: null, effect };
}

/** The picture the viewer sees, so details can follow it. */
export function visibleEntry(state) {
  return isTransitioning(state) ? state.incoming : state.shown;
}

/**
 * Layers to render, the newest first, with their roles.
 * @returns {{entry: StageEntry, role: string}[]}
 */
export function stageLayers(state) {
  const layers = [];
  if (state.incoming)
    layers.push({
      entry: state.incoming,
      role: isTransitioning(state) ? LAYER_ROLE.ENTERING : LAYER_ROLE.LOADING,
    });
  if (state.shown) layers.push({ entry: state.shown, role: LAYER_ROLE.SHOWN });
  if (state.outgoing)
    layers.push({ entry: state.outgoing, role: LAYER_ROLE.EXITING });
  return layers;
}
