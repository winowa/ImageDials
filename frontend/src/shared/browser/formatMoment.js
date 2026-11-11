/** A moment, as milliseconds since the epoch, in the viewer's locale. */
export function formatMoment(milliseconds) {
  const date = new Date(milliseconds);
  if (milliseconds === null || Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}
