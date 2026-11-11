import { regionToolAvailability } from '../../features/references/regionSelection.js';

/**
 * Whether the region tool can be used on the current base reference.
 */
export function useRegionAvailability({ references, regionCapability }) {
  const regionBaseRef = references.refs[0] ?? null;
  const regionAvailability = regionToolAvailability(regionCapability, {
    ...regionBaseRef,
    file: regionBaseRef?.blob,
  });
  const regionAvailable =
    regionAvailability.available &&
    Boolean(regionBaseRef?.blob) &&
    regionBaseRef.status === 'ready';

  return {
    regionAvailability,
    regionAvailable,
  };
}
