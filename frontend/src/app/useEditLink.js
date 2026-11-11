import { useCallback, useEffect, useRef, useState } from 'react';

import { imageKey } from '../data/records/imageRecord.js';
import { resolveEditLink } from './routes.js';
import { isExactRecord } from '../data/records/exactRecords.js';

const HTTP_NOT_FOUND = 404;
const MESSAGE = {
  missing: 'That saved image is not in the library.',
  skip: 'The draft changed before the link could be applied, so it was left as it is.',
  failed: 'That saved image could not be loaded.',
};

const blankRun = (id = 0, revision = 0) => ({
  id,
  revision,
  done: false,
  controller: null,
});

/**
 * Apply the navigation's edit target once. Browser-only images and rows already
 * held are matched by exact identity; anything else is read directly from the
 * record endpoint, so a saved image anywhere in the catalog restores without
 * walking pages. Only the exact record is restored, and history then opens
 * around it. An edit made first keeps the draft; a 404 reports the image
 * missing; another failure can be retried. Later refreshes, selections and
 * re-renders never run it again; only another navigation does.
 */
export function useEditLink(nav, studio) {
  const {
    history,
    editReady,
    restore,
    draftRevision,
    loadEditRecord,
    finishEditLink,
  } = studio;
  const seen = useRef(blankRun());
  const [outcome, setOutcome] = useState(null);
  const [attempt, setAttempt] = useState(0);

  // Leaving the navigation (or a StrictMode remount) abandons its read.
  const navId = nav.id;
  useEffect(
    () => () => {
      if (seen.current.id !== navId) return;
      seen.current.controller?.abort();
      seen.current.controller = null;
    },
    [navId],
  );

  useEffect(() => {
    if (!nav.edit) return;
    if (seen.current.id !== nav.id)
      seen.current = blankRun(nav.id, draftRevision());
    const run = seen.current;
    if (run.done || run.controller || !editReady) return;
    const finish = (next, anchor = null) => {
      run.done = true;
      run.controller = null;
      setOutcome({ id: nav.id, ...next });
      finishEditLink(nav.id, anchor);
    };
    if (draftRevision() !== run.revision) {
      finish({ message: MESSAGE.skip });
      return;
    }
    const local = resolveEditLink({
      target: nav.edit,
      items: history,
      ready: true,
      draftChanged: false,
    });
    const listed = local.action === 'restore' ? local.item : null;
    const applyExact = (record, anchor) => {
      restore(record);
      finish({ center: record.client_key ?? imageKey(record) }, anchor);
    };
    if (listed && isExactRecord(listed)) {
      applyExact(listed, null);
      return;
    }
    const controller = new AbortController();
    run.controller = controller;
    loadEditRecord(nav.edit, listed, { signal: controller.signal }).then(
      (record) => {
        if (run !== seen.current || run.controller !== controller) return;
        if (!record) {
          finish({ message: MESSAGE.missing });
          return;
        }
        if (draftRevision() !== run.revision) {
          finish({ message: MESSAGE.skip });
          return;
        }
        applyExact(
          record,
          listed ? null : String(record.id ?? record.image_id),
        );
      },
      (error) => {
        if (run !== seen.current || run.controller !== controller) return;
        if (error?.name === 'AbortError') return;
        run.controller = null;
        if (error.status === HTTP_NOT_FOUND) {
          finish({ message: MESSAGE.missing });
          return;
        }
        // The rest of the page does not wait for a link that may be retried.
        setOutcome({ id: nav.id, message: MESSAGE.failed, retryable: true });
        finishEditLink(nav.id);
      },
    );
  }, [
    nav,
    history,
    editReady,
    restore,
    draftRevision,
    loadEditRecord,
    finishEditLink,
    attempt,
  ]);

  const mine = outcome?.id === nav.id ? outcome : null;
  const done = useCallback(
    () => setOutcome((o) => (o?.center ? { ...o, center: null } : o)),
    [],
  );
  const dismiss = useCallback(
    () => setOutcome((o) => (o?.message ? { ...o, message: null } : o)),
    [],
  );
  const retry = useCallback(() => {
    setOutcome((o) => (o?.message ? { ...o, message: null } : o));
    setAttempt((n) => n + 1);
  }, []);
  return {
    center: mine?.center ? { token: nav.id, key: mine.center } : null,
    centered: done,
    message: mine?.message ?? null,
    retry: mine?.retryable ? retry : null,
    dismiss,
  };
}
