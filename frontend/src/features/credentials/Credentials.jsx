import { ErrorDetails } from '../../shared/diagnostics/ErrorDetails.jsx';
import { localDiagnostic } from '../../shared/diagnostics/diagnostics.js';
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import {
  CREDENTIAL_LABEL,
  CREDENTIAL_STATE,
  boundForDisplay,
  createCredentialsInspector,
} from './credentials.js';
import { readOriginalBytes } from '../../data/media/originalBytes.js';
import { Disclosure } from '../../shared/ui/ui.jsx';
import { JsonTree } from '../../shared/json/JsonTree.jsx';

const PHASE = Object.freeze({
  IDLE: 'idle',
  LOADING: 'loading',
  DONE: 'done',
  ERROR: 'error',
});

const isAbort = (error) => error?.name === 'AbortError';

/**
 * Inspect the original file of `image` on request. One inspection at a time;
 * each owns its SDK worker, which ends with it. Closing, unmounting or
 * cancelling aborts the run, and a late result is dropped.
 */
export function useCredentials(
  image,
  { media = null, readLocal = null, fetchBlob, createInspector } = {},
) {
  const [state, setState] = useState({ phase: PHASE.IDLE });
  const run = useRef({ controller: null, inspector: null });
  const options = useRef({});
  useLayoutEffect(() => {
    options.current = { media, readLocal, fetchBlob, createInspector, image };
  });

  const stop = useCallback(() => {
    const current = run.current;
    current.controller?.abort();
    current.inspector?.dispose();
    current.controller = null;
    current.inspector = null;
  }, []);

  const start = useCallback(async () => {
    stop();
    const controller = new AbortController();
    const inspector = (
      options.current.createInspector ?? createCredentialsInspector
    )();
    run.current = { controller, inspector };
    setState({ phase: PHASE.LOADING });
    try {
      const { signal } = controller;
      const blob = await readOriginalBytes(options.current.image, {
        signal,
        media: options.current.media,
        readLocal: options.current.readLocal,
        fetchBlob: options.current.fetchBlob,
      });
      const result = await inspector.inspect(blob, { signal });
      if (!signal.aborted) setState({ phase: PHASE.DONE, result });
    } catch (error) {
      if (controller.signal.aborted || isAbort(error)) return;
      setState({ phase: PHASE.ERROR, error });
    } finally {
      inspector.dispose();
      if (run.current.inspector === inspector) run.current.inspector = null;
    }
  }, [stop]);

  const cancel = useCallback(() => {
    stop();
    setState({ phase: PHASE.IDLE });
  }, [stop]);

  useEffect(() => stop, [stop]);

  return { ...state, start, cancel };
}

function Issues({ issues }) {
  return (
    <ul className="cred-issues" aria-label="Validation results">
      {issues.map((issue) => (
        <li key={`${issue.code}|${issue.explanation}`}>
          <code>{issue.code}</code>
          {issue.explanation ? ` ${issue.explanation}` : ''}
        </li>
      ))}
    </ul>
  );
}

function Result({ result }) {
  const { state, summary, store } = result;
  if (state === CREDENTIAL_STATE.ABSENT)
    return (
      <p className="prose">No Content Credentials in the original file.</p>
    );
  return (
    <>
      <dl className="wm-status cred-facts">
        <dt>Status</dt>
        <dd data-state={state}>{CREDENTIAL_LABEL[state]}</dd>
        {summary.signer ? (
          <>
            <dt>Signer</dt>
            <dd>{summary.signer}</dd>
          </>
        ) : null}
        {summary.issuer && summary.issuer !== summary.signer ? (
          <>
            <dt>Issuer</dt>
            <dd>{summary.issuer}</dd>
          </>
        ) : null}
        {summary.signedAt ? (
          <>
            <dt>Signed</dt>
            <dd>{summary.signedAt}</dd>
          </>
        ) : null}
        {summary.generators.length ? (
          <>
            <dt>Created with</dt>
            <dd>{summary.generators.join(', ')}</dd>
          </>
        ) : null}
      </dl>
      {summary.issues.length ? <Issues issues={summary.issues} /> : null}
      <Disclosure title="Manifest data">
        <JsonTree value={boundForDisplay(store)} />
      </Disclosure>
    </>
  );
}

/**
 * Content Credentials of the original file, read in this browser when the
 * disclosure is first opened.
 */
export default function CredentialsPanel({ image, ...sources }) {
  const credentials = useCredentials(image, sources);
  const { phase, result, error, start, cancel } = credentials;
  const meta =
    phase === PHASE.DONE
      ? CREDENTIAL_LABEL[result.state]
      : phase === PHASE.LOADING
        ? 'Reading…'
        : phase === PHASE.ERROR
          ? 'Failed'
          : null;
  return (
    <Disclosure
      title="Content Credentials"
      meta={meta}
      onToggle={(open) => {
        if (open && phase === PHASE.IDLE) start();
      }}
    >
      <div className="cred-panel" aria-live="polite">
        {phase === PHASE.IDLE ? (
          <button type="button" className="btn" onClick={start}>
            Read credentials
          </button>
        ) : null}
        {phase === PHASE.LOADING ? (
          <>
            <p className="count" role="status">
              Reading the original file…
            </p>
            <button type="button" className="btn" onClick={cancel}>
              Cancel
            </button>
          </>
        ) : null}
        {phase === PHASE.ERROR ? (
          <>
            <p className="error-text" role="alert">
              <ErrorDetails
                error={error}
                diagnostic={
                  error.diagnostic ??
                  localDiagnostic({
                    category: 'file',
                    reason: error.message,
                    cause: error.cause ?? error,
                  })
                }
              />
              Credentials could not be read. {error.message}
            </p>
            <button type="button" className="btn" onClick={start}>
              Retry
            </button>
          </>
        ) : null}
        {phase === PHASE.DONE ? <Result result={result} /> : null}
      </div>
    </Disclosure>
  );
}
