import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { WarningDetails } from '../../shared/diagnostics/ErrorDetails.jsx';
import { localDiagnostic } from '../../shared/diagnostics/diagnostics.js';
import { copyText, STATE_LABEL } from './llmExchange.js';
import { Disclosure, Icon, Modal, Tip } from '../../shared/ui/ui.jsx';
import { JsonViewer } from '../../shared/json/JsonViewer.jsx';
import './LlmExchange.css';

const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const COPY_RESET_MS = 1800;

/** Copies exactly the stored text; says plainly when the clipboard refuses. */
function CopyButton({ block }) {
  const [state, setState] = useState('idle');
  const [failure, setFailure] = useState(null);
  const timer = useRef(null);
  const active = useRef(false);
  const operation = useRef(0);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      clearTimeout(timer.current);
    };
  }, []);
  const copy = async () => {
    clearTimeout(timer.current);
    setFailure(null);
    setState('idle');
    const sequence = ++operation.current;
    const isCurrent = () => active.current && sequence === operation.current;
    try {
      await navigator.clipboard.writeText(copyText(block));
      if (!isCurrent()) return;
      setState('copied');
    } catch (cause) {
      if (!isCurrent()) return;
      setFailure(
        localDiagnostic({
          category: 'clipboard',
          reason: 'Copy is unavailable here',
          cause,
        }),
      );
      setState('failed');
      return;
    }
    timer.current = setTimeout(() => setState('idle'), COPY_RESET_MS);
  };
  return (
    <span className="exchange-copy">
      <button
        type="button"
        className="btn exchange-tool"
        aria-label={`Copy ${block.label}`}
        onClick={copy}
      >
        <Icon name={state === 'copied' ? 'check' : 'copy'} size={16} />
        Copy
      </button>
      <span role="status" className="exchange-copy-status">
        {state === 'copied'
          ? 'Copied'
          : state === 'failed'
            ? 'Copy is unavailable here'
            : ''}
      </span>
      {failure ? (
        <WarningDetails diagnostic={failure} label="Copy failure details" />
      ) : null}
    </span>
  );
}

/** One stored value: formatted JSON when it is JSON, always the exact text. */
function Block({ block }) {
  const structured = block.value !== undefined;
  const hasRaw = typeof block.raw === 'string';
  const [view, setView] = useState(structured ? 'tree' : 'raw');
  const shown = structured && (view === 'tree' || !hasRaw) ? 'tree' : 'raw';
  const label = capitalize(block.label);
  return (
    <Disclosure
      title={label}
      defaultOpen={!block.collapsed}
      meta={
        hasRaw && block.raw.length
          ? `${block.raw.length.toLocaleString()} characters`
          : undefined
      }
    >
      <div className="exchange-block">
        <div className="exchange-tools">
          {structured && hasRaw ? (
            <div className="exchange-views" role="group" aria-label="View">
              {[
                ['tree', 'Formatted'],
                ['raw', 'Raw'],
              ].map(([id, text]) => (
                <button
                  key={id}
                  type="button"
                  className="exchange-view"
                  aria-pressed={shown === id}
                  onClick={() => setView(id)}
                >
                  {text}
                </button>
              ))}
            </div>
          ) : null}
          <CopyButton block={block} />
        </div>
        {block.note ? <p className="exchange-note">{block.note}</p> : null}
        {block.raw === '' && shown === 'raw' ? (
          <p className="exchange-note">Empty</p>
        ) : (
          <JsonViewer
            raw={block.raw}
            value={block.value}
            view={shown}
            label={label}
          />
        )}
      </div>
    </Disclosure>
  );
}

function ExchangeBody({ exchange }) {
  return (
    <div className="exchange-body">
      {exchange.chips.length ? (
        <ul className="exchange-chips" aria-label="Call">
          {exchange.chips.map((chip) => (
            <li key={chip} className="badge">
              {chip}
            </li>
          ))}
        </ul>
      ) : null}
      {exchange.notes.map((note) => (
        <p key={note} className="exchange-note">
          {note}
        </p>
      ))}
      {exchange.sections.map((section) => (
        <section key={section.id} className="exchange-section">
          <h4 className="mini">{section.title}</h4>
          {section.blocks.map((block) => (
            <Block key={block.id} block={block} />
          ))}
        </section>
      ))}
    </div>
  );
}

function StateBadge({ state }) {
  return (
    <span className="badge" data-state={state}>
      {STATE_LABEL[state]}
    </span>
  );
}

/** Calls shown inline: one directly, several as progressive sections. */
export function ExchangeList({ exchanges }) {
  if (exchanges.length === 1) {
    const [only] = exchanges;
    return (
      <div className="exchange-list">
        <p className="exchange-heading">
          <strong>{only.title}</strong> <StateBadge state={only.state} />
        </p>
        <ExchangeBody exchange={only} />
      </div>
    );
  }
  return (
    <div className="exchange-list">
      {exchanges.map((exchange, index) => (
        <Disclosure
          key={exchange.id}
          title={exchange.title}
          defaultOpen={index === 0 || exchange.state === 'failed'}
          meta={<StateBadge state={exchange.state} />}
        >
          <ExchangeBody exchange={exchange} />
        </Disclosure>
      ))}
    </div>
  );
}

/** Modal inspector. The caller returns focus to its opener from `onClose`. */
export function ExchangeDialog({
  exchanges,
  title = 'Request and response',
  onClose,
}) {
  return createPortal(
    <Modal label={title} onClose={onClose} className="exchange-dialog">
      <div className="dialog-bar">
        <h2 className="exchange-title">{title}</h2>
        <Tip label="Close">
          <button
            type="button"
            className="icon-btn quiet"
            aria-label="Close request and response"
            onClick={onClose}
          >
            <Icon name="close" size={20} />
          </button>
        </Tip>
      </div>
      {exchanges.length ? (
        <ExchangeList exchanges={exchanges} />
      ) : (
        <p className="exchange-note">No request or reply to show.</p>
      )}
    </Modal>,
    document.body,
  );
}
