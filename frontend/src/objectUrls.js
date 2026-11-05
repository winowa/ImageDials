/**
 * Reference-counted browser object URLs. An imported image is shown by a local
 * preview and may then stay in the local history; a URL is revoked only once
 * nothing displays or lists it any more.
 */
export function createUrlLedger(urlApi = URL) {
  const counts = new Map();

  return {
    /** A new object URL for `blob`, already held once. */
    acquire(blob) {
      const url = urlApi.createObjectURL(blob);
      counts.set(url, 1);
      return url;
    },
    /** Hold an existing URL for another owner. */
    retain(url) {
      if (counts.has(url)) counts.set(url, counts.get(url) + 1);
    },
    /** Drop one hold; the URL is revoked when the last one goes. */
    release(url) {
      const held = counts.get(url);
      if (!held) return;
      if (held > 1) {
        counts.set(url, held - 1);
        return;
      }
      counts.delete(url);
      urlApi.revokeObjectURL(url);
    },
    /** Revoke everything still held (the owner is going away). */
    releaseAll() {
      for (const url of counts.keys()) urlApi.revokeObjectURL(url);
      counts.clear();
    },
    held: (url) => counts.get(url) ?? 0,
  };
}
