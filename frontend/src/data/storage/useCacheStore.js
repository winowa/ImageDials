import { useEffect, useRef, useState } from 'react';

import { openCacheDb } from './cacheDb.js';
import { createCacheStore } from './cacheStore.js';

/**
 * The page's one cache store. It opens the database once and reports `ready`
 * when the attempt has settled; an unusable database gives a store without
 * storage, so callers never branch on it. The limits are the current
 * `policy.cache` and may change when capabilities are re-read.
 *
 * @param {{sharedRecordLimit: number, sharedVariantLimit: number, sharedVariantMaxBytes: number}} limits
 * @returns {{store: ReturnType<typeof createCacheStore>|null, ready: boolean}}
 */
export function useCacheStore(limits) {
  const [opened, setOpened] = useState({ store: null, ready: false });
  const latest = useRef(limits);
  useEffect(() => {
    latest.current = limits;
    opened.store?.setLimits(limits);
  }, [limits, opened.store]);

  useEffect(() => {
    let alive = true;
    let database = null;
    openCacheDb().then((db) => {
      database = db;
      if (!alive) {
        db?.close();
        return;
      }
      setOpened({ store: createCacheStore(db, latest.current), ready: true });
    });
    return () => {
      alive = false;
      database?.close();
    };
  }, []);
  return opened;
}
