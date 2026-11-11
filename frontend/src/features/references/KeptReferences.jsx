import React, { useEffect, useId, useRef, useState } from 'react';

import { formatBytes, usageFraction, usageText } from './retainedReferences.js';
import { Icon, Modal, Tip } from '../../shared/ui/ui.jsx';
import { formatMoment } from '../../shared/browser/formatMoment.js';
import {
  ErrorDetails,
  WarningDetails,
} from '../../shared/diagnostics/ErrorDetails.jsx';
import {
  localDiagnostic,
  preserveError,
} from '../../shared/diagnostics/diagnostics.js';
import './KeptReferences.css';

const aborted = (error) => error?.name === 'AbortError';

const acquire = (urls, blob) =>
  urls?.acquire ? urls.acquire(blob) : URL.createObjectURL(blob);
const release = (urls, url) =>
  urls?.release ? urls.release(url) : URL.revokeObjectURL(url);

/**
 * Confirmation before a kept copy is removed. An attached reference with the
 * same file stays in the draft; only the copy kept in this browser goes.
 */
export function RemoveKeptConfirm({
  name,
  busy,
  error,
  diagnostic,
  onConfirm,
  onCancel,
}) {
  const cancel = useRef(null);
  useEffect(() => {
    cancel.current?.focus();
  }, []);
  return (
    <div
      className="confirm kept-confirm"
      role="group"
      aria-label={`Remove kept copy of ${name}`}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || busy) return;
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }}
    >
      <p className="confirm-text">
        Remove <strong>{name}</strong> from this browser? This cannot be undone.
        A copy attached to the draft stays attached.
      </p>
      {error ? (
        <p className="error-text" role="alert">
          {error?.message ?? error}
          <ErrorDetails
            error={typeof error === 'object' ? error : undefined}
            diagnostic={
              diagnostic ??
              localDiagnostic({
                category: 'reference-storage',
                reason: error?.message ?? error,
              })
            }
            label="Kept file removal details"
          />
        </p>
      ) : null}
      <div className="confirm-actions">
        <button
          type="button"
          className="btn danger"
          disabled={busy}
          onClick={onConfirm}
        >
          <Icon name="trash" size={18} />
          Remove kept copy
        </button>
        <button
          type="button"
          className="btn"
          ref={cancel}
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Lazy preview: the Blob is read and leased only while the row is open. */
function useKeptPreview({ open, item, retained, urls }) {
  const { sha256, revision } = item;
  const key = `${sha256}:${revision}`;
  const [result, setResult] = useState({
    key: null,
    status: 'idle',
    url: null,
  });
  const { load } = retained;
  useEffect(() => {
    if (!open) return undefined;
    const controller = new AbortController();
    let leased = null;
    Promise.resolve()
      .then(() => load(sha256, { signal: controller.signal }))
      .then(
        (blob) => {
          if (controller.signal.aborted) return;
          if (!blob) {
            setResult({
              key,
              status: 'missing',
              url: null,
              diagnostic: localDiagnostic({
                category: 'reference-storage',
                reason: 'This file is no longer kept.',
              }),
            });
            return;
          }
          try {
            leased = acquire(urls, blob);
            setResult({ key, status: 'ready', url: leased });
          } catch (cause) {
            setResult({
              key,
              status: 'error',
              url: null,
              diagnostic: localDiagnostic({
                category: 'reference-preview',
                reason: 'The browser could not create a preview URL.',
                cause,
              }),
            });
          }
        },
        (error) => {
          if (controller.signal.aborted || aborted(error)) return;
          setResult({
            key,
            status: 'error',
            url: null,
            error: preserveError(error),
          });
        },
      );
    return () => {
      controller.abort();
      if (leased) release(urls, leased);
    };
  }, [open, key, sha256, load, urls]);
  if (!open) return { status: 'idle', url: null };
  // A result for an earlier file or an earlier opening is not this preview.
  return result.key === key
    ? {
        ...result,
        onError: () =>
          setResult({
            key,
            status: 'error',
            url: null,
            diagnostic: localDiagnostic({
              category: 'reference-preview',
              reason: 'The browser could not decode the kept file for display.',
            }),
          }),
      }
    : { status: 'loading', url: null };
}

function KeptRow({ item, retained, urls, onAdded }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState(null);
  const [failure, setFailure] = useState(null);
  const bodyId = useId();
  const removeButton = useRef(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const preview = useKeptPreview({ open, item, retained, urls });
  const inDraft = retained.attached.has(item.sha256);
  const size = item.dimensions;

  const add = async () => {
    setBusy('adding');
    setMessage(null);
    setFailure(null);
    const result = await retained.pick(item);
    if (!live.current) return;
    setBusy(null);
    if (result.ok) onAdded(item);
    else {
      setMessage(result.reason);
      setFailure(
        result.error
          ? preserveError(result.error)
          : {
              diagnostic: localDiagnostic({
                category: 'reference-validation',
                reason: result.reason,
              }),
            },
      );
    }
  };
  const confirmRemove = async () => {
    setBusy('removing');
    setMessage(null);
    setFailure(null);
    const result = await retained.remove(item);
    if (!live.current) return;
    setBusy(null);
    if (!result.removed) {
      setMessage(result.message);
      setFailure(
        result.error
          ? preserveError(result.error)
          : {
              diagnostic: localDiagnostic({
                category: 'reference-storage',
                reason: result.message,
              }),
            },
      );
    }
  };

  return (
    <li className="kept-item" data-open={open} data-busy={busy || undefined}>
      <div className="kept-head">
        <button
          type="button"
          className="kept-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={`${item.name}, preview`}
          onClick={() => setOpen(!open)}
        >
          <span className="kept-chevron" aria-hidden="true">
            <Icon name="chevron" size={18} />
          </span>
          <span className="kept-title">
            <strong className="kept-name">{item.name}</strong>
            <span className="kept-meta mono">
              {[
                size ? `${size.width}×${size.height}` : null,
                formatBytes(item.bytes),
                formatMoment(item.savedAt),
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </span>
        </button>
        <div className="kept-actions">
          {inDraft ? <span className="kept-badge">In draft</span> : null}
          <button
            type="button"
            className="btn"
            aria-label={`Add ${item.name} to the draft`}
            disabled={Boolean(busy) || inDraft || Boolean(retained.addBlock)}
            aria-busy={busy === 'adding' || undefined}
            onClick={add}
          >
            <Icon name="plus" size={18} />
            Add
          </button>
          <Tip label="Remove from this browser" hidden={confirming}>
            <button
              ref={removeButton}
              type="button"
              className="icon-btn quiet"
              aria-label={`Remove ${item.name} from this browser`}
              disabled={Boolean(busy)}
              onClick={() => setConfirming(true)}
            >
              <Icon name="trash" size={18} />
            </button>
          </Tip>
        </div>
      </div>
      <div className="kept-body" id={bodyId} inert={!open}>
        <div className="kept-inner">
          {item.description ? (
            <p className="kept-desc">{item.description}</p>
          ) : null}
          <div className="kept-preview" data-state={preview.status}>
            {preview.url ? (
              <img
                src={preview.url}
                alt={`Preview of ${item.name}`}
                onError={preview.onError}
              />
            ) : preview.status === 'loading' ? (
              <span role="status">Loading preview…</span>
            ) : preview.status === 'missing' || preview.status === 'error' ? (
              <span role="alert">
                {preview.status === 'missing'
                  ? 'This file is no longer kept.'
                  : 'The kept file could not be read.'}
                <ErrorDetails
                  error={preview.error}
                  diagnostic={preview.diagnostic}
                  label="Kept file preview details"
                />
              </span>
            ) : null}
          </div>
        </div>
      </div>
      {message ? (
        <p className="error-text kept-message" role="alert">
          {message}
          <ErrorDetails error={failure} label="Kept file action details" />
        </p>
      ) : null}
      {confirming ? (
        <RemoveKeptConfirm
          name={item.name}
          busy={busy === 'removing'}
          error={message}
          diagnostic={failure?.diagnostic}
          onConfirm={confirmRemove}
          onCancel={() => {
            setConfirming(false);
            setMessage(null);
            requestAnimationFrame(() => removeButton.current?.focus());
          }}
        />
      ) : null}
    </li>
  );
}

/**
 * Files kept in this browser: usage, a lazy preview, adding one to the draft
 * again without uploading it, and removing a kept copy after confirmation.
 */
export default function KeptReferencesDialog({ retained, urls, onClose }) {
  const { items, usage, status } = retained;
  return (
    <Modal label="Kept references" onClose={onClose} className="kept-dialog">
      <div className="dialog-bar">
        <h2 className="kept-dialog-title">Kept in this browser</h2>
        <Tip label="Close">
          <button
            type="button"
            className="icon-btn quiet"
            aria-label="Close kept references"
            onClick={onClose}
          >
            <Icon name="close" size={20} />
          </button>
        </Tip>
      </div>
      <div className="kept-body-wrap">
        {usage ? (
          <div className="kept-usage">
            <p className="kept-usage-text">{usageText(usage)}</p>
            <span className="kept-meter" aria-hidden="true">
              <span style={{ width: `${usageFraction(usage) * 100}%` }} />
            </span>
          </div>
        ) : null}
        {retained.addBlock && items.length ? (
          <p className="kept-note">
            {retained.addBlock}
            <WarningDetails
              diagnostic={localDiagnostic({
                category: 'reference-validation',
                reason: retained.addBlock,
              })}
              label="Kept reference limit details"
            />
          </p>
        ) : null}
        {status === 'error' ? (
          <div className="notice" data-tone="error" role="alert">
            <span>
              {retained.error?.message ?? retained.error}
              <ErrorDetails
                error={
                  typeof retained.error === 'object'
                    ? retained.error
                    : undefined
                }
                diagnostic={
                  retained.failure?.diagnostic ??
                  localDiagnostic({
                    category: 'reference-storage',
                    reason: retained.error?.message ?? retained.error,
                  })
                }
                label="Kept reference storage details"
              />
            </span>
            <button type="button" className="btn" onClick={retained.refresh}>
              Retry
            </button>
          </div>
        ) : null}
        {status === 'loading' ? (
          <p className="kept-note" role="status">
            Reading kept files…
          </p>
        ) : null}
        {status === 'ready' && !items.length ? (
          <p className="kept-note">No files kept.</p>
        ) : null}
        {items.length ? (
          <ul className="kept-list" aria-label="Kept files">
            {items.map((item) => (
              <KeptRow
                key={`${item.sha256}:${item.revision}`}
                item={item}
                retained={retained}
                urls={urls}
                onAdded={onClose}
              />
            ))}
          </ul>
        ) : null}
      </div>
    </Modal>
  );
}
