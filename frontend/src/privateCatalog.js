import {
  PRIVATE_PAGE_METADATA_MAX_BYTES,
  PRIVATE_READ_PAGE_LIMIT,
} from './cacheStore.js';

/** Bounded metadata windows over the private cache read kernel. */
export const PRIVATE_CATALOG_BOUNDS = Object.freeze({
  create: Object.freeze({ rows: 40, bytes: 384 * 1024 }),
  library: Object.freeze({ rows: 48, bytes: 512 * 1024 }),
  pins: Object.freeze({ entries: 12, bytes: 256 * 1024 }),
});
export const PRIVATE_PIN_MAX_ENTRIES = 32;
const PRIVATE_PIN_ROLES = new Set([
  'selected',
  'draft-base',
  'pending-job',
  'unsaved',
  'watermark-action',
]);
export const PRIVATE_PIN_MAX_ROLES = PRIVATE_PIN_ROLES.size;

function metadataBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function validateBounds(name, bounds) {
  if (
    !bounds ||
    !Number.isInteger(bounds.rows) ||
    bounds.rows < 1 ||
    bounds.rows > PRIVATE_READ_PAGE_LIMIT ||
    !Number.isSafeInteger(bounds.bytes) ||
    bounds.bytes < 1 ||
    bounds.bytes > PRIVATE_PAGE_METADATA_MAX_BYTES
  )
    throw new RangeError(`Invalid ${name} private metadata bounds.`);
}

function identityOf(row) {
  return { key: row.key, addedAt: row.addedAt };
}

function sameIdentity(left, right) {
  return left?.key === right?.key && left?.addedAt === right?.addedAt;
}

function fitRows(rows, bounds, direction) {
  const retained = [];
  let bytes = 0;
  let oversized = false;
  const candidates = direction === 'newer' ? [...rows].reverse() : rows;
  for (const row of candidates) {
    const size = metadataBytes(row);
    if (retained.length >= bounds.rows) break;
    if (retained.length && bytes + size > bounds.bytes) break;
    retained.push(row);
    bytes += size;
    oversized ||= size > bounds.bytes;
  }
  if (direction === 'newer') retained.reverse();
  return { rows: retained, bytes, oversized };
}

function fitAround(rows, identity, bounds) {
  const selectedIndex = rows.findIndex((row) =>
    sameIdentity(identityOf(row), identity),
  );
  if (selectedIndex < 0) return { rows: [], bytes: 0, oversized: false };
  const selected = rows[selectedIndex];
  const selectedBytes = metadataBytes(selected);
  let start = selectedIndex;
  let end = selectedIndex;
  let bytes = selectedBytes;
  let oversized = selectedBytes > bounds.bytes;
  if (!oversized) {
    let leftStopped = false;
    let rightStopped = false;
    while (end - start + 1 < bounds.rows && (!leftStopped || !rightStopped)) {
      if (!leftStopped && start > 0) {
        const size = metadataBytes(rows[start - 1]);
        if (bytes + size <= bounds.bytes) {
          start--;
          bytes += size;
        } else leftStopped = true;
      } else leftStopped = true;
      if (end - start + 1 >= bounds.rows) break;
      if (!rightStopped && end + 1 < rows.length) {
        const size = metadataBytes(rows[end + 1]);
        if (bytes + size <= bounds.bytes) {
          end++;
          bytes += size;
        } else rightStopped = true;
      } else rightStopped = true;
    }
  }
  return {
    rows: rows.slice(start, end + 1),
    bytes,
    oversized,
  };
}

/**
 * Construct independent Create and Library metadata windows. A window is a
 * traversal aid; entries outside it are neither missing nor deleted.
 */
export function createPrivateCatalog(store, options = {}) {
  if (
    !store ||
    ![
      'privateCount',
      'readPrivatePage',
      'readPrivateAround',
      'readPrivateDetail',
      'scanPrivateSlice',
    ].every((method) => typeof store[method] === 'function')
  )
    throw new TypeError('A private metadata read store is required.');

  const configured = {
    create: options.create ?? PRIVATE_CATALOG_BOUNDS.create,
    library: options.library ?? PRIVATE_CATALOG_BOUNDS.library,
    pins: options.pins ?? PRIVATE_CATALOG_BOUNDS.pins,
  };
  validateBounds('Create', configured.create);
  validateBounds('Library', configured.library);
  if (
    !Number.isInteger(configured.pins.entries) ||
    configured.pins.entries < 1 ||
    configured.pins.entries > PRIVATE_PIN_MAX_ENTRIES ||
    !Number.isSafeInteger(configured.pins.bytes) ||
    configured.pins.bytes < 1 ||
    configured.pins.bytes > PRIVATE_PAGE_METADATA_MAX_BYTES
  )
    throw new RangeError('Invalid private pin ledger bounds.');

  const windows = Object.fromEntries(
    ['create', 'library'].map((name) => [
      name,
      {
        name,
        bounds: configured[name],
        rows: [],
        bytes: 0,
        missing: null,
        seq: null,
        next: null,
        previous: null,
        pending: null,
        error: null,
        oversized: false,
        complete: false,
        ticket: 0,
      },
    ]),
  );
  const pins = new Map();
  let pinBytes = 0;
  let knownSeq = null;

  function getWindow(name) {
    const window = windows[name];
    if (!window) throw new TypeError('Unknown private catalog surface.');
    return window;
  }

  function snapshot(name) {
    const window = getWindow(name);
    return {
      ...window,
      rows: [...window.rows],
      bounds: { ...window.bounds },
      complete: false,
    };
  }

  async function request(name, operation, direction = 'older') {
    const window = getWindow(name);
    const ticket = ++window.ticket;
    window.pending = ticket;
    window.error = null;
    try {
      const result = await operation(window.bounds);
      if (window.pending !== ticket)
        return { accepted: false, stale: true, state: snapshot(name) };
      if (
        result.staleRead ||
        (knownSeq !== null && result.seq < knownSeq) ||
        (window.seq !== null && result.seq < window.seq)
      ) {
        window.pending = null;
        return { accepted: false, stale: true, state: snapshot(name) };
      }
      const fit = fitRows(result.rows, window.bounds, direction);
      const truncated = fit.rows.length < result.rows.length;
      window.rows = fit.rows;
      window.bytes = fit.bytes;
      window.missing = result.missing ?? false;
      window.seq = result.seq;
      window.next =
        truncated && direction === 'older'
          ? identityOf(fit.rows.at(-1))
          : (result.next ?? null);
      window.previous =
        truncated && direction === 'newer'
          ? identityOf(fit.rows[0])
          : (result.previous ?? null);
      window.oversized = Boolean(result.oversized || fit.oversized);
      knownSeq = Math.max(knownSeq ?? result.seq, result.seq);
      window.pending = null;
      return { accepted: true, stale: false, state: snapshot(name) };
    } catch (error) {
      if (window.pending !== ticket)
        return { accepted: false, stale: true, state: snapshot(name) };
      window.pending = null;
      window.error = error;
      return { accepted: false, stale: false, error, state: snapshot(name) };
    }
  }

  const api = {
    bounds(name) {
      return { ...getWindow(name).bounds };
    },
    snapshot,
    count() {
      return store.privateCount().then((result) => {
        knownSeq = Math.max(knownSeq ?? result.seq, result.seq);
        return result;
      });
    },
    first(name) {
      return request(
        name,
        (bounds) => store.readPrivatePage({ limit: bounds.rows }),
        'older',
      );
    },
    last(name) {
      return request(
        name,
        (bounds) =>
          store.readPrivatePage({
            edge: 'oldest',
            direction: 'newer',
            limit: bounds.rows,
          }),
        'newer',
      );
    },
    older(name) {
      const current = getWindow(name);
      if (!current.next)
        return Promise.resolve({
          accepted: false,
          stale: false,
          state: snapshot(name),
        });
      return request(
        name,
        (bounds) =>
          store.readPrivatePage({
            anchor: current.next,
            direction: 'older',
            limit: bounds.rows,
          }),
        'older',
      );
    },
    newer(name) {
      const current = getWindow(name);
      if (!current.previous)
        return Promise.resolve({
          accepted: false,
          stale: false,
          state: snapshot(name),
        });
      return request(
        name,
        (bounds) =>
          store.readPrivatePage({
            anchor: current.previous,
            direction: 'newer',
            limit: bounds.rows,
          }),
        'newer',
      );
    },
    around(name, identity, { before, after } = {}) {
      if (
        !identity ||
        typeof identity.key !== 'string' ||
        !Number.isFinite(identity.addedAt)
      )
        throw new TypeError(
          'A private key and addedAt incarnation are required.',
        );
      const bounds = getWindow(name).bounds;
      const left = before ?? Math.floor((bounds.rows - 1) / 2);
      const right = after ?? bounds.rows - 1 - left;
      if (left + right + 1 > bounds.rows)
        throw new RangeError('Private around window exceeds its row bound.');
      return request(
        name,
        async () => {
          const result = await store.readPrivateAround(identity, {
            before: left,
            after: right,
          });
          if (result.missing)
            return { ...result, rows: [], next: null, previous: null };
          const fit = fitAround(result.rows, identity, getWindow(name).bounds);
          if (!fit.rows.length) return { ...result, staleRead: true, rows: [] };
          const first = identityOf(fit.rows[0]);
          const last = identityOf(fit.rows.at(-1));
          const [newerProbe, olderProbe] = await Promise.all([
            store.readPrivatePage({
              anchor: first,
              direction: 'newer',
              limit: 1,
            }),
            store.readPrivatePage({
              anchor: last,
              direction: 'older',
              limit: 1,
            }),
          ]);
          knownSeq = Math.max(
            knownSeq ?? result.seq,
            newerProbe.seq,
            olderProbe.seq,
          );
          if (newerProbe.seq !== result.seq || olderProbe.seq !== result.seq)
            return { ...result, staleRead: true, rows: [] };
          return {
            ...result,
            rows: fit.rows,
            oversized: result.oversized || fit.oversized,
            next: olderProbe.rows.length ? last : null,
            previous: newerProbe.rows.length ? first : null,
          };
        },
        'older',
      );
    },
    async lookup(key) {
      if (typeof key !== 'string' || !key)
        throw new TypeError('A private key is required.');
      return store.readPrivateDetail(key);
    },
    async confirm(identity) {
      if (
        !identity ||
        typeof identity.key !== 'string' ||
        !Number.isFinite(identity.addedAt)
      )
        throw new TypeError(
          'A private key and addedAt incarnation are required.',
        );
      const row = await store.readPrivateDetail(identity.key);
      return row && sameIdentity(identityOf(row), identity) ? row : null;
    },
    /** Pin a bounded exact incarnation; a full ledger refuses visibly. */
    pin(identity, reason = 'selected') {
      if (
        !identity ||
        typeof identity.key !== 'string' ||
        !Number.isFinite(identity.addedAt)
      )
        throw new TypeError(
          'A private key and addedAt incarnation are required.',
        );
      if (!PRIVATE_PIN_ROLES.has(reason))
        throw new TypeError('Unknown private pin role.');
      const id = `${identity.key}\u0000${identity.addedAt}`;
      const existing = pins.get(id);
      if (existing) {
        if (existing.roles.has(reason))
          return { accepted: true, count: pins.size, bytes: pinBytes };
        const roleBytes = metadataBytes(reason);
        if (
          existing.roles.size >= PRIVATE_PIN_MAX_ROLES ||
          pinBytes + roleBytes > configured.pins.bytes
        )
          return {
            accepted: false,
            reason: 'pin-limit',
            count: pins.size,
            bytes: pinBytes,
          };
        existing.roles.add(reason);
        existing.size += roleBytes;
        pinBytes += roleBytes;
        return { accepted: true, count: pins.size, bytes: pinBytes };
      }
      const baseBytes = metadataBytes(identity);
      const roleBytes = metadataBytes(reason);
      const size = baseBytes + roleBytes;
      if (
        pins.size >= configured.pins.entries ||
        pinBytes + size > configured.pins.bytes
      )
        return {
          accepted: false,
          reason: 'pin-limit',
          count: pins.size,
          bytes: pinBytes,
        };
      pins.set(id, {
        identity: { ...identity },
        pinnedAt: Date.now(),
        baseBytes,
        size,
        roles: new Set([reason]),
      });
      pinBytes += size;
      return { accepted: true, count: pins.size, bytes: pinBytes };
    },
    unpin(identity, reason) {
      if (!identity) return false;
      const id = `${identity.key}\u0000${identity.addedAt}`;
      const entry = pins.get(id);
      if (!entry) return false;
      if (reason !== undefined) {
        if (!entry.roles.delete(reason)) return false;
        const roleBytes = metadataBytes(reason);
        entry.size -= roleBytes;
        pinBytes -= roleBytes;
        if (entry.roles.size) return true;
      }
      pins.delete(id);
      pinBytes -= reason === undefined ? entry.size : entry.baseBytes;
      return true;
    },
    pinSnapshot() {
      return [...pins.values()].map(({ identity, pinnedAt, roles }) => ({
        identity: { ...identity },
        pinnedAt,
        roles: [...roles],
      }));
    },
    /** Search is deliberately deferred; callers can consume cancellable bounded store slices. */
    scan(options) {
      return store.scanPrivateSlice(options);
    },
  };
  return api;
}
