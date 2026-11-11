import { regionToolAvailability } from '../../features/references/regionSelection.js';

/** Keep a region only with the exact source bytes and their oriented geometry. */
export function regionMatchesReference(selection, reference) {
  if (!selection) return true;
  if (!reference || reference.sha256 !== selection.source_sha256) return false;
  const { width, height } = reference.dimensions ?? {};
  return (
    width == null ||
    height == null ||
    (width === selection.width && height === selection.height)
  );
}

export function regionSubmissionProblem(selection, references, capability) {
  if (!selection) return null;
  const base = references[0];
  const availability = regionToolAvailability(capability, {
    ...base,
    file: base?.blob,
  });
  if (!availability.available)
    return `${availability.reason} Clear the region selection to continue.`;
  if (!base?.blob || base.status !== 'ready')
    return 'Attach the original base image to use this region selection.';
  if (!regionMatchesReference(selection, base))
    return 'The region selection belongs to a different base image. Clear it or select the original base again.';
  return null;
}
