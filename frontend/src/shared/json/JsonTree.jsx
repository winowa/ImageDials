import React, { useEffect, useRef, useState } from 'react';

import { useResizableViewport, ViewportHandle } from './ViewportResize.jsx';
import './JsonTree.css';

/** Levels below the root that start open. */
const OPEN_DEPTH = 1;
/** Longest a closing animation may take before the body is dropped anyway. */
const CLOSE_FALLBACK_MS = 450;

function Chevron() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="icon icon-chevron"
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

function Primitive({ value }) {
  if (value === null) return <span className="j-null">null</span>;
  if (typeof value === 'string')
    return <span className="j-str">{JSON.stringify(value)}</span>;
  if (typeof value === 'number') return <span className="j-num">{value}</span>;
  return <span className="j-bool">{String(value)}</span>;
}

/** True when the element's own CSS animates it (not with reduced motion). */
function animates(element) {
  if (!element || typeof getComputedStyle !== 'function') return false;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
    return false;
  return (getComputedStyle(element).transitionDuration || '')
    .split(',')
    .some((part) => parseFloat(part) > 0);
}

function Key({ name }) {
  return name === undefined ? null : (
    <span className="j-key">{JSON.stringify(String(name))}: </span>
  );
}

function Leaf({ name, children }) {
  return (
    <div className="j-line">
      <span className="j-gutter" aria-hidden="true" />
      <span className="j-text">
        <Key name={name} />
        {children}
      </span>
    </div>
  );
}

function JsonNode({ name, value, depth }) {
  const composite = value !== null && typeof value === 'object';
  const entries = composite
    ? Array.isArray(value)
      ? value.map((v, i) => [i, v])
      : Object.entries(value)
    : [];
  // closed | opening | open | closing: the body stays mounted while it
  // animates away, and a press during either animation reverses it.
  const [phase, setPhase] = useState(depth < OPEN_DEPTH ? 'open' : 'closed');
  const body = useRef(null);
  const open = phase === 'open' || phase === 'opening';

  useEffect(() => {
    if (phase !== 'opening') return undefined;
    // Let the collapsed state paint once so the opening transition runs.
    let second;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setPhase('open'));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [phase]);
  useEffect(() => {
    if (phase !== 'closing') return undefined;
    const timer = setTimeout(() => setPhase('closed'), CLOSE_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  if (!composite)
    return (
      <Leaf name={name}>
        <Primitive value={value} />
      </Leaf>
    );
  const array = Array.isArray(value);
  const [l, r] = array ? ['[', ']'] : ['{', '}'];
  // Nothing to open: show it as a plain value.
  if (!entries.length)
    return (
      <Leaf name={name}>
        <span className="j-punct">
          {l}
          {r}
        </span>
      </Leaf>
    );
  // The press target carries the same motion rules as the body (none under
  // reduced motion), so it tells whether anything will animate.
  const toggle = (event) => {
    const moves = animates(event.currentTarget);
    if (open) {
      if (body.current?.contains(document.activeElement))
        event.currentTarget.focus();
      setPhase(moves ? 'closing' : 'closed');
    } else if (phase === 'closing') setPhase('open');
    else setPhase(moves ? 'opening' : 'open');
  };
  return (
    <div className="j-node" data-open={open} data-phase={phase}>
      <button
        type="button"
        className="j-line j-toggle"
        aria-expanded={open}
        aria-label={`${name ?? 'root'} ${open ? 'collapse' : 'expand'}`}
        onClick={toggle}
      >
        <span className="j-gutter" aria-hidden="true">
          <Chevron />
        </span>
        <span className="j-text">
          <Key name={name} />
          <span className="j-punct">{l}</span>
          {phase === 'closed' ? (
            <span className="j-punct">
              {' '}
              {entries.length} {entries.length === 1 ? 'item' : 'items'} {r}
            </span>
          ) : null}
        </span>
      </button>
      {phase === 'closed' ? null : (
        <div
          className="j-body"
          data-open={open}
          inert={!open}
          ref={body}
          onTransitionEnd={(event) => {
            if (
              event.target === event.currentTarget &&
              event.propertyName === 'grid-template-rows' &&
              phase === 'closing'
            )
              setPhase('closed');
          }}
        >
          <div className="j-inner">
            <div className="j-children">
              {entries.map(([k, v]) => (
                <JsonNode
                  key={k}
                  name={array ? undefined : k}
                  value={v}
                  depth={depth + 1}
                />
              ))}
            </div>
            <div className="j-line j-close">
              <span className="j-gutter" aria-hidden="true" />
              <span className="j-text j-punct">{r}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Arrow keys walk the open rows; Right opens and Left closes the focused one. */
function onTreeKeys(event) {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const current = event.target.closest?.('.j-toggle');
  if (!current) return;
  const rows = [...event.currentTarget.querySelectorAll('.j-toggle')].filter(
    (row) => !row.closest('[inert]'),
  );
  const at = rows.indexOf(current);
  const go = (index) => {
    event.preventDefault();
    rows[Math.max(0, Math.min(rows.length - 1, index))]?.focus();
  };
  const expanded = current.getAttribute('aria-expanded') === 'true';
  if (event.key === 'ArrowDown') go(at + 1);
  else if (event.key === 'ArrowUp') go(at - 1);
  else if (event.key === 'Home') go(0);
  else if (event.key === 'End') go(rows.length - 1);
  else if (event.key === 'ArrowRight' && !expanded) {
    event.preventDefault();
    current.click();
  } else if (event.key === 'ArrowLeft' && expanded) {
    event.preventDefault();
    current.click();
  }
}

/**
 * Collapsible, syntax-highlighted view of parsed JSON. `flush` drops the
 * frame and its own scrolling, for a parent that supplies the viewport.
 */
function TreeContent({ value, flush = false, viewportProps = {} }) {
  return (
    <div
      className="json-tree"
      data-flush={flush}
      onKeyDown={onTreeKeys}
      {...viewportProps}
    >
      <JsonNode value={value} depth={0} />
    </div>
  );
}

function ResizableTree({ value }) {
  const viewport = useResizableViewport();
  return (
    <div className="json-tree-viewer">
      <TreeContent value={value} viewportProps={viewport.props} />
      <ViewportHandle viewport={viewport} label="JSON" />
    </div>
  );
}

export function JsonTree({ value, flush = false }) {
  return flush ? (
    <TreeContent value={value} flush />
  ) : (
    <ResizableTree value={value} />
  );
}
