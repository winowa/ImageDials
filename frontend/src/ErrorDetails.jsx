import React, {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import {
  categoryLabel,
  diagnosticOf,
  redactText,
  redactValue,
} from './diagnostics.js';
import { JsonViewer } from './JsonViewer.jsx';
import { Icon } from './ui.jsx';
import './ErrorDetails.css';

function ResponseBody({ body }) {
  const [view, setView] = useState('tree');
  if (!body) return <p>No response body was retained.</p>;
  const structured = body.json !== undefined;
  return (
    <section className="diagnostic-body" aria-label="Response body">
      <div className="diagnostic-body-head">
        <strong>Response body</strong>
        {structured ? (
          <div role="group" aria-label="Response view">
            <button
              type="button"
              aria-pressed={view === 'tree'}
              onClick={() => setView('tree')}
            >
              Formatted
            </button>
            <button
              type="button"
              aria-pressed={view === 'raw'}
              onClick={() => setView('raw')}
            >
              Raw
            </button>
          </div>
        ) : null}
      </div>
      {body.excerpt ? <p>Only an excerpt was retained.</p> : null}
      {body.truncated ? (
        <p>
          Truncated: {body.text.length.toLocaleString()} of{' '}
          {body.length.toLocaleString()} received characters retained after
          redaction.
        </p>
      ) : null}
      {body.redacted ? <p>Credentials redacted.</p> : null}
      {body.structureLimited ? (
        <p>
          Formatted view omits data beyond the nesting limit. Raw text remains
          available.
        </p>
      ) : null}
      {body.html ? <p>HTML response shown as text.</p> : null}
      {body.text === '' ? (
        <p>Empty response body.</p>
      ) : (
        <JsonViewer
          raw={body.text}
          value={body.json}
          view={structured ? view : 'raw'}
          label="Response body"
        />
      )}
    </section>
  );
}

export function DiagnosticContent({ diagnostic }) {
  const d = redactValue(diagnostic);
  const facts = [
    ['Category', categoryLabel(d.category)],
    ['Request', [d.method, d.endpoint].filter(Boolean).join(' ')],
    [
      'HTTP status',
      d.status ? `${d.status}${d.statusText ? ` ${d.statusText}` : ''}` : null,
    ],
    ['Request ID', d.requestId],
    ['Content type', d.contentType],
    ['Retry-After', d.retryAfter],
    ['Job ID', d.jobId],
    ...(d.facts ?? []),
  ].filter(
    ([, value]) => value !== undefined && value !== null && value !== '',
  );
  return (
    <div className="diagnostic-content">
      <dl>
        {facts.map(([key, value], i) => (
          <React.Fragment key={`${key}-${i}`}>
            <dt>{key}</dt>
            <dd>{String(value)}</dd>
          </React.Fragment>
        ))}
      </dl>
      {d.partial ? (
        <p>
          Partial details: the original request and response were not retained.
        </p>
      ) : null}
      {d.kind === 'network' ? (
        <p>
          {d.phase === 'response'
            ? 'The response body could not be read completely.'
            : 'No HTTP response was received.'}
        </p>
      ) : null}
      {d.reason ? <p>{d.reason}</p> : null}
      {d.cause && d.cause.message !== d.reason ? (
        <p>{[d.cause.name, d.cause.message].filter(Boolean).join(': ')}</p>
      ) : null}
      {d.kind === 'http' ? <ResponseBody body={d.body} /> : null}
      {d.providerDetail ? (
        <section>
          <strong>Provider detail</strong>
          <JsonViewer raw={d.providerDetail} label="Provider detail" />
        </section>
      ) : null}
      {d.data !== undefined ? (
        <section>
          <strong>Retained data</strong>
          <JsonViewer
            value={d.data}
            raw={JSON.stringify(d.data, null, 2)}
            view="tree"
            label="Retained data"
          />
        </section>
      ) : null}
    </div>
  );
}

/** An icon beside a concise message; details stay transient and open on demand. */
export function ErrorDetails({
  error,
  diagnostic,
  label = 'Error details',
  severity = 'error',
}) {
  const [mode, setMode] = useState('closed');
  const [position, setPosition] = useState(null);
  const trigger = useRef(null);
  const panel = useRef(null);
  const timer = useRef(null);
  const returning = useRef(false);
  const id = useId();
  const open = mode !== 'closed';
  const source = diagnostic ?? diagnosticOf(error);
  const close = (restore = false) => {
    clearTimeout(timer.current);
    setMode('closed');
    if (restore) {
      returning.current = true;
      trigger.current?.focus();
      returning.current = false;
    }
  };
  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      if (!trigger.current || !panel.current) return;
      const edge = 8;
      const a = trigger.current.getBoundingClientRect();
      const b = panel.current.getBoundingClientRect();
      const height = window.visualViewport?.height ?? window.innerHeight;
      const width = window.visualViewport?.width ?? window.innerWidth;
      const below = height - a.bottom - edge * 2;
      const above = a.top - edge * 2;
      const naturalHeight = Math.min(
        panel.current.scrollHeight + 2,
        height - edge * 2,
      );
      const flip = naturalHeight > below && above > below;
      const room = Math.max(44, flip ? above : below);
      setPosition({
        left: Math.max(edge, Math.min(a.left, width - b.width - edge)),
        top: flip
          ? Math.max(edge, a.top - Math.min(b.height, room) - edge)
          : Math.min(a.bottom + edge, height - edge - 44),
        maxHeight: Math.min(height - edge * 2, room),
      });
    };
    place();
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    if (panel.current) observer?.observe(panel.current);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    window.visualViewport?.addEventListener('resize', place);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      window.visualViewport?.removeEventListener('resize', place);
    };
  }, [open]);
  useLayoutEffect(() => {
    if (mode === 'pinned') panel.current?.focus();
  }, [mode]);
  useEffect(() => {
    if (!open) return undefined;
    const outside = (event) => {
      if (
        !trigger.current?.contains(event.target) &&
        !panel.current?.contains(event.target)
      )
        close();
    };
    const escape = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close(
          panel.current?.contains(document.activeElement) ||
            document.activeElement === trigger.current,
        );
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape, true);
    };
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return undefined;
    const button = trigger.current;
    const popup = panel.current;
    let scope = button?.parentElement;
    let next;
    while (scope && scope !== document.body && !next) {
      next = [...scope.querySelectorAll('button, a[href], input')].find(
        (node) =>
          node !== button &&
          !node.disabled &&
          !node.closest('[inert]') &&
          !popup?.contains(node),
      );
      scope = scope.parentElement;
    }
    return () => {
      clearTimeout(timer.current);
      if (!popup?.contains(document.activeElement)) return;
      queueMicrotask(() => {
        if (next?.isConnected) next.focus();
      });
    };
  }, [open]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const show = () => {
    clearTimeout(timer.current);
    if (!returning.current)
      setMode((value) => (value === 'closed' ? 'hover' : value));
  };
  const leave = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () => setMode((value) => (value === 'hover' ? 'closed' : value)),
      180,
    );
  };
  if (!source) return null;
  return (
    <span className="diagnostic-anchor" data-severity={severity}>
      <button
        ref={trigger}
        type="button"
        className="icon-btn diagnostic-trigger"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onMouseEnter={show}
        onMouseLeave={leave}
        onFocus={show}
        onBlur={(event) => {
          if (!panel.current?.contains(event.relatedTarget)) close();
        }}
        onClick={() => {
          if (mode === 'pinned') close(true);
          else {
            clearTimeout(timer.current);
            setMode('pinned');
          }
        }}
      >
        <Icon name="warning" size={20} />
      </button>
      {open
        ? createPortal(
            <div
              ref={panel}
              id={id}
              className="diagnostic-popover"
              data-severity={severity}
              role="dialog"
              aria-label={label}
              tabIndex={-1}
              style={position ?? { visibility: 'hidden' }}
              onKeyDown={(event) => {
                if (event.key !== 'Tab') return;
                // A portal inside a parent modal has its own DOM tab sequence.
                event.stopPropagation();
                const nodes = [
                  ...panel.current.querySelectorAll(
                    'button, a[href], input, select, textarea, [tabindex="0"]',
                  ),
                ].filter((node) => !node.disabled && !node.closest('[inert]'));
                const first = nodes[0];
                const last = nodes.at(-1);
                if (
                  (event.shiftKey &&
                    (event.target === first ||
                      event.target === panel.current)) ||
                  (!event.shiftKey && event.target === last)
                ) {
                  event.preventDefault();
                  close(true);
                }
              }}
              onMouseEnter={() => clearTimeout(timer.current)}
              onMouseLeave={leave}
              onFocus={() => {
                clearTimeout(timer.current);
                setMode('pinned');
              }}
              onBlur={(event) => {
                if (
                  !panel.current?.contains(event.relatedTarget) &&
                  event.relatedTarget !== trigger.current
                )
                  close();
              }}
            >
              <div className="diagnostic-heading">
                <strong>{redactText(label)}</strong>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Close details"
                  onClick={() => close(true)}
                >
                  <Icon name="close" size={18} />
                </button>
              </div>
              <DiagnosticContent diagnostic={source} />
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}

export function WarningDetails({
  warning,
  diagnostic,
  label = 'Warning details',
}) {
  return (
    <ErrorDetails
      error={warning}
      diagnostic={diagnostic}
      label={label}
      severity="warning"
    />
  );
}
