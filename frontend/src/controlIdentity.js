/** Shared ready/flight/metadata identity; ordered reference signature is opaque. */
import { isNearAnchor } from './promptAnchor.js';

export function matchesControlIdentity(set, { provider, draft, refs, policy }) {
  return (
    set?.provider === provider &&
    isNearAnchor(
      set.anchor ?? set.key,
      draft.prompt,
      draft.mode,
      policy.controls.similarityMinimumRatio,
    ) &&
    (set.refs ?? '') === refs
  );
}
