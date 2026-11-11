import React, { Fragment, useMemo } from 'react';
import { JsonTree } from './JsonTree.jsx';
import { tokenizeJson } from './jsonTokens.js';
import { useResizableViewport, ViewportHandle } from './ViewportResize.jsx';
import './JsonViewer.css';

const TOKEN_CLASS = {
  key: 'j-key',
  str: 'j-str',
  num: 'j-num',
  bool: 'j-bool',
  null: 'j-null',
  punct: 'j-punct',
};

/**
 * The exact stored text. When `highlight` is set and the text is well-formed
 * JSON it is coloured token by token; every character, including whitespace,
 * stays as stored. Anything else is plain text.
 */
function StoredText({ text, highlight }) {
  const segments = useMemo(
    () => (highlight ? tokenizeJson(text) : null),
    [text, highlight],
  );
  if (!segments) return text;
  return segments.map((segment, index) => (
    <Fragment key={index}>
      {TOKEN_CLASS[segment.kind] ? (
        <span className={TOKEN_CLASS[segment.kind]}>{segment.text}</span>
      ) : (
        segment.text
      )}
    </Fragment>
  ));
}

/** Exact text with optional JSON highlighting, never generated HTML. */
export function RawJsonView({
  text,
  label = 'JSON',
  className = '',
  ...props
}) {
  return (
    <pre
      tabIndex={0}
      aria-label={`${label} text`}
      {...props}
      className={`exchange-viewport exchange-raw ${className}`.trim()}
    >
      <StoredText text={text} highlight />
    </pre>
  );
}

/** Shared viewport; callers own view selection, copy and evidence labels. */
export function JsonViewer({ raw, value, view = 'raw', label = 'JSON' }) {
  const viewport = useResizableViewport();
  return (
    <div className="exchange-viewer">
      {view === 'tree' && value !== undefined ? (
        <div className="exchange-viewport" {...viewport.props}>
          <JsonTree value={value} flush />
        </div>
      ) : (
        <RawJsonView text={raw} label={label} {...viewport.props} />
      )}
      <ViewportHandle viewport={viewport} label={label} />
    </div>
  );
}
