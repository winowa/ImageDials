import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import KeptReferencesDialog, { RemoveKeptConfirm } from './KeptReferences.jsx';
import {
  baseDimensions,
  editSummary,
  overLimitReason,
  REF_STATUS,
} from './references.js';
import ResultMenu from '../../shared/ui/ResultMenu.jsx';
import RegionEditor from './RegionEditor.jsx';
import { Icon, InfoPopover, Tip } from '../../shared/ui/ui.jsx';
import {
  ErrorDetails,
  WarningDetails,
} from '../../shared/diagnostics/ErrorDetails.jsx';
import { localDiagnostic } from '../../shared/diagnostics/diagnostics.js';
import './References.css';

const hasFiles = (event) =>
  Array.from(event.dataTransfer?.types ?? []).includes('Files');

const reducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? true;

/** Accept list for the reference chooser. */
function acceptOf(uploads) {
  const listed = uploads?.image_mime_types;
  const allowed = ['image/png', 'image/jpeg', 'image/webp'];
  const types = Array.isArray(listed)
    ? allowed.filter((t) => listed.includes(t))
    : allowed;
  return (types.length ? types : allowed).join(',');
}

/**
 * Slides list items from where they were to where they are after a reorder
 * or removal (FLIP). Nothing moves with reduced motion.
 */
function useReorderMotion(list, order) {
  const last = useRef(new Map());
  const motions = useRef([]);
  const lastWidth = useRef(null);
  useLayoutEffect(() => {
    const node = list.current;
    if (!node) return;
    // Measure resting positions relative to the list. Caption/prompt arrivals,
    // scrolling and rotation must not compound a running FLIP transform.
    motions.current.forEach((animation) => animation.cancel());
    motions.current = [];
    const layout = node.getBoundingClientRect();
    const sameWidth =
      lastWidth.current !== null &&
      Math.abs(lastWidth.current - layout.width) < 1;
    const next = new Map();
    for (const item of node.children) {
      const key = item.dataset.ref;
      const box = item.getBoundingClientRect();
      const position = {
        left: box.left - layout.left,
        top: box.top - layout.top,
      };
      next.set(key, position);
      const before = last.current.get(key);
      if (
        !before ||
        !sameWidth ||
        reducedMotion() ||
        typeof item.animate !== 'function'
      )
        continue;
      const dx = before.left - position.left;
      const dy = before.top - position.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      motions.current.push(
        item.animate(
          [
            { transform: `translate(${dx}px, ${dy}px)` },
            { transform: 'translate(0, 0)' },
          ],
          { duration: 240, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' },
        ),
      );
    }
    last.current = next;
    lastWidth.current = layout.width;
    return () => motions.current.forEach((animation) => animation.cancel());
  }, [list, order]);
}

function ReferenceStatus({ item, index, onRetry, onReattach }) {
  const input = useRef(null);
  if (item.status === REF_STATUS.missing || item.status === REF_STATUS.error)
    return (
      <div className="ref-status" data-tone="error">
        <p role="alert">
          {item.status === REF_STATUS.missing
            ? 'Original file needed to edit.'
            : (item.analysisError ?? 'This file could not be read.')}
          <ErrorDetails
            error={item.analysisFailure}
            diagnostic={
              item.analysisFailure?.diagnostic ??
              localDiagnostic({
                category: 'reference-file',
                reason: item.analysisError ?? 'Original file needed to edit.',
              })
            }
            label={`Reference ${index + 1} error details`}
          />
        </p>
        {item.attachError ? (
          <p className="error-text" role="alert">
            {item.attachError}
            <ErrorDetails
              error={item.attachFailure}
              label={`Reference ${index + 1} attachment details`}
            />
          </p>
        ) : null}
        {item.checking ? (
          <p className="ref-status" role="status" data-busy="true">
            Checking file…
          </p>
        ) : null}
        {item.status === REF_STATUS.missing ? (
          <>
            <input
              ref={input}
              className="sr-only"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(event) => {
                const [file] = event.target.files;
                event.target.value = '';
                if (file) onReattach(item.id, file);
              }}
            />
            <button
              type="button"
              className="btn"
              aria-label={`Attach original for reference ${index + 1}`}
              disabled={item.checking}
              onClick={() => input.current?.click()}
            >
              <Icon name="upload" size={18} />
              Attach original
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn"
            aria-label={`Retry reference ${index + 1}`}
            onClick={() => onRetry(item.id)}
          >
            <Icon name="refresh" size={18} />
            Retry
          </button>
        )}
      </div>
    );
  if (item.status === REF_STATUS.resolving)
    return (
      <p className="ref-status" role="status">
        Finding original…
      </p>
    );
  if (item.analyzing || item.status === REF_STATUS.reading)
    return (
      <p className="ref-status" role="status" data-busy="true">
        {item.converting ? 'Preparing smaller copy…' : 'Describing…'}
      </p>
    );
  return (
    <>
      {item.description ? (
        <div className="ref-desc-row">
          <p className="ref-desc">{item.description}</p>
          <InfoPopover label={`Reference ${index + 1} description`}>
            <p>{item.description}</p>
          </InfoPopover>
        </div>
      ) : null}
      {item.analysisError ? (
        <div className="ref-status" data-tone="warning">
          <p role="status">
            Not described: {item.analysisError}
            <WarningDetails
              warning={item.analysisFailure}
              label={`Reference ${index + 1} description warning`}
            />
          </p>
          <button
            type="button"
            className="btn"
            aria-label={`Retry reference ${index + 1}`}
            onClick={() => onRetry(item.id)}
          >
            <Icon name="refresh" size={18} />
            Retry
          </button>
        </div>
      ) : null}
    </>
  );
}

export function referencePromptLabel(prompting, count, index) {
  const labels = prompting?.labels?.[String(count)];
  return Array.isArray(labels) && typeof labels[index] === 'string'
    ? labels[index]
    : null;
}

/** A bookmark: the file is kept. */
function KeepGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="icon icon-keep"
    >
      <path d="M7 4h10a1 1 0 0 1 1 1v15l-6-4-6 4V5a1 1 0 0 1 1-1Z" />
    </svg>
  );
}

function MoreGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="currentColor"
      aria-hidden="true"
      className="icon icon-more"
    >
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </svg>
  );
}

/** Whether, and how well, the file is kept in this browser. */
function KeepStatus({ item, kept, keep, onRetry, onManage, onDismiss }) {
  if (keep?.status === 'saving')
    return (
      <p className="ref-status" role="status" data-busy="true">
        Keeping…
      </p>
    );
  if (keep?.status === 'failed')
    return (
      <div className="ref-status" data-tone="error">
        <p role="alert">
          {keep.message}
          <ErrorDetails
            error={keep.error}
            diagnostic={
              keep.diagnostic ??
              localDiagnostic({
                category: 'reference-storage',
                reason: keep.message,
              })
            }
            label="Keep reference details"
          />
        </p>
        {keep.retry ? (
          <button
            type="button"
            className="btn"
            aria-label={`Retry keeping ${item.name}`}
            onClick={onRetry}
          >
            <Icon name="refresh" size={18} />
            Retry
          </button>
        ) : null}
        {keep.manage ? (
          <button type="button" className="btn" onClick={onManage}>
            Kept files
          </button>
        ) : null}
        <button
          type="button"
          className="icon-btn quiet"
          aria-label={`Dismiss message for ${item.name}`}
          onClick={onDismiss}
        >
          <Icon name="close" size={18} />
        </button>
      </div>
    );
  if (kept)
    return (
      <p className="ref-kept">
        <Icon name="check" size={16} />
        Kept in this browser
      </p>
    );
  return null;
}

/**
 * One reference. Its own actions sit behind one menu: keep in this browser,
 * move earlier or later (the keyboard and touch way to reorder) and remove
 * from the draft. Removing from the draft never removes a kept copy.
 */
export function ReferenceItem({
  item,
  index,
  count,
  prompting,
  references,
  retained = null,
  regionEdit = null,
  onRemove = null,
  onManage = null,
  onOpenRegion = null,
}) {
  const label = index === 0 ? 'Base' : `Reference ${index + 1}`;
  const promptLabel = referencePromptLabel(prompting, count, index);
  const [confirming, setConfirming] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  const [forgetError, setForgetError] = useState(null);
  const row = useRef(null);
  const size = item.dimensions;
  const kept = retained?.find(item.source?.sha256 ?? item.sha256) ?? null;
  const keep = retained?.keeps?.[item.id] ?? null;
  const saving = keep?.status === 'saving';
  const keepable =
    Boolean(retained?.ready) &&
    Boolean(item.blob) &&
    item.status === REF_STATUS.ready &&
    !item.checking;

  const machineName =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.[a-z0-9]+)?$/i.test(
      item.name ?? '',
    );
  const menu = [];
  if (keepable) {
    if (kept)
      menu.push({
        id: 'forget',
        label: 'Remove kept copy',
        icon: 'trash',
        hint: 'The draft keeps its file',
        onSelect: () => {
          setForgetError(null);
          setConfirming(true);
        },
      });
    else {
      const blocked = !retained.available
        ? 'Browser storage unavailable'
        : item.analyzing
          ? 'Wait for the description'
          : null;
      menu.push({
        id: 'keep',
        label: 'Keep in this browser',
        icon: <KeepGlyph />,
        busy: saving,
        disabled: saving || Boolean(blocked),
        hint: saving ? 'Keeping…' : (blocked ?? undefined),
        onSelect: () => retained.keep(item.id),
      });
    }
  }
  if (index === 0 && regionEdit?.availability?.available)
    menu.push({
      id: 'region-edit',
      label: regionEdit.selection
        ? 'Edit region selection'
        : 'Edit part of image',
      icon: 'edit',
      onSelect: onOpenRegion,
    });
  if (index === 0 && regionEdit?.selection)
    menu.push({
      id: 'region-clear',
      label: 'Clear region selection',
      icon: 'close',
      onSelect: regionEdit.clear,
    });
  if (index > 0)
    menu.push({
      id: 'earlier',
      label: 'Move earlier',
      icon: 'prev',
      onSelect: () => references.move(item.id, -1),
    });
  if (index < count - 1)
    menu.push({
      id: 'later',
      label: 'Move later',
      icon: 'next',
      onSelect: () => references.move(item.id, 1),
    });
  menu.push({
    id: 'remove',
    label: 'Remove from draft',
    icon: 'close',
    hint: kept ? 'The kept copy stays' : undefined,
    onSelect: () => (onRemove ?? references.remove)(item.id),
  });

  const forget = async () => {
    if (!kept) return;
    setForgetting(true);
    setForgetError(null);
    const result = await retained.remove(kept);
    setForgetting(false);
    if (result.removed) {
      setConfirming(false);
      requestAnimationFrame(() =>
        row.current?.querySelector('[aria-haspopup="menu"]')?.focus(),
      );
    } else setForgetError(result.message);
  };

  return (
    <li
      ref={row}
      className="ref-item"
      data-ref={item.id}
      data-status={item.status}
      aria-label={`${label}: ${item.name}`}
    >
      <div className="ref-media">
        {item.url ? (
          <img src={item.url} alt="" />
        ) : (
          <span className="ref-blank" aria-hidden="true">
            <Icon name="upload" />
          </span>
        )}
        <span className="ref-index" aria-hidden="true">
          {index + 1}
        </span>
      </div>
      <div className="ref-text">
        <div className="ref-title">
          <strong>{label}</strong>
          {promptLabel ? (
            <code className="ref-prompt-label">{promptLabel}</code>
          ) : null}
          {machineName ? (
            <details className="ref-file-details">
              <summary>File details</summary>
              <span className="ref-name">{item.name}</span>
            </details>
          ) : (
            <span className="ref-name">{item.name}</span>
          )}
          {size ? (
            <span className="ref-size mono">
              {size.width}×{size.height}
            </span>
          ) : null}
        </div>
        {item.source && size ? (
          <p className="ref-status" role="status">
            Sent as {size.width}×{size.height} (original {item.source.width}×
            {item.source.height}). Smaller model copy; original bytes unchanged.
            <WarningDetails
              diagnostic={localDiagnostic({
                category: 'reference-adaptation',
                reason:
                  'A smaller model copy is used. Original bytes are unchanged.',
                facts: {
                  source: `${item.source.width}×${item.source.height}`,
                  modelCopy: `${size.width}×${size.height}`,
                  bytes: item.blob?.size,
                  byteBudget: item.source.max_normalized_bytes,
                  sourceSHA256: item.source.sha256,
                  modelSHA256: item.sha256,
                },
              })}
              label={`Reference ${index + 1} model copy details`}
            />
          </p>
        ) : null}
        <ReferenceStatus
          item={item}
          index={index}
          onRetry={references.retryAnalysis}
          onReattach={references.reattach}
        />
        {retained ? (
          <KeepStatus
            item={item}
            kept={kept}
            keep={keep}
            onRetry={() => retained.keep(item.id)}
            onManage={onManage ?? (() => {})}
            onDismiss={() => retained.dismissKeep(item.id)}
          />
        ) : null}
        {index === 0 && regionEdit?.selection ? (
          <span className="ref-region-status" role="status">
            {regionEdit.availability.available
              ? `${Array.isArray(regionEdit.selection.shapes) ? regionEdit.selection.shapes.length : 0} selected shape${regionEdit.selection.shapes?.length === 1 ? '' : 's'}`
              : `${regionEdit.availability.reason} Clear the region selection to continue.`}
            {!regionEdit.availability.available ? (
              <WarningDetails
                diagnostic={localDiagnostic({
                  category: 'region-validation',
                  reason: regionEdit.availability.reason,
                })}
                label="Region selection availability details"
              />
            ) : null}
          </span>
        ) : index === 0 && regionEdit?.notice ? (
          <span className="ref-region-status" role="status">
            {regionEdit.notice}
            <WarningDetails
              diagnostic={localDiagnostic({
                category: 'region-validation',
                reason: regionEdit.notice,
              })}
              label="Region selection warning details"
            />
          </span>
        ) : null}
        {confirming && kept ? (
          <RemoveKeptConfirm
            name={kept.name || item.name}
            busy={forgetting}
            error={forgetError}
            onConfirm={forget}
            onCancel={() => {
              setConfirming(false);
              requestAnimationFrame(() =>
                row.current?.querySelector('[aria-haspopup="menu"]')?.focus(),
              );
            }}
          />
        ) : null}
      </div>
      <div className="ref-actions">
        <ResultMenu
          compact
          triggerIcon={<MoreGlyph />}
          label={`Actions for reference ${index + 1}`}
          items={menu}
        />
      </div>
    </li>
  );
}

function Proposal({ studio }) {
  const { proposal, refs, signature } = studio.references;
  // A proposal belongs to the reference set it was made for.
  if (!proposal || !refs.length || proposal.signature !== signature)
    return null;
  const prompt = studio.draft.prompt;
  if (proposal.kind === 'applied') {
    if (prompt !== proposal.text) return null;
    return (
      <div className="ref-proposal" role="status">
        <span>Prompt updated from reference {proposal.index}.</span>
        <button
          type="button"
          className="btn"
          onClick={studio.references.undoProposal}
        >
          <Icon name="undo" size={18} />
          Undo
        </button>
        <button
          type="button"
          className="icon-btn quiet"
          aria-label="Dismiss prompt update"
          onClick={studio.references.dismissProposal}
        >
          <Icon name="close" size={18} />
        </button>
      </div>
    );
  }
  return (
    <div className="ref-proposal" data-kind="offered" role="status">
      <div className="ref-proposal-text">
        <span>Suggested prompt from reference {proposal.index}</span>
        <p className="prose">{proposal.text}</p>
      </div>
      <button
        type="button"
        className="btn primary"
        onClick={studio.references.acceptProposal}
      >
        Use
      </button>
      <button
        type="button"
        className="icon-btn quiet"
        aria-label="Dismiss suggested prompt"
        onClick={studio.references.dismissProposal}
      >
        <Icon name="close" size={18} />
      </button>
    </div>
  );
}

/**
 * The optional prompt suggestion could not be made. The references are fine
 * and Generate is unaffected; this only offers the suggestion again.
 */
function PromptNotice({ studio }) {
  const {
    promptNotice: notice,
    retryPrompt,
    dismissPromptNotice,
  } = studio.references;
  if (!notice) return null;
  const waiting = notice.retrying;
  return (
    <div
      className="ref-proposal ref-notice"
      data-tone="warning"
      data-busy={waiting ? 'true' : undefined}
      role="status"
    >
      <Icon name="warning" size={18} />
      <span key={notice.failures} className="ref-notice-text">
        {waiting ? 'Asking for a prompt suggestion…' : notice.message}
      </span>
      <span className="ref-notice-actions">
        <WarningDetails
          warning={notice.failure}
          diagnostic={notice.diagnostic}
          label="Prompt suggestion details"
        />
        <button
          type="button"
          className="btn"
          disabled={waiting || !notice.ready}
          onClick={retryPrompt}
        >
          <Icon name="refresh" size={18} />
          Retry prompt
        </button>
        <button
          type="button"
          className="icon-btn quiet"
          aria-label="Dismiss prompt warning"
          onClick={dismissPromptNotice}
        >
          <Icon name="close" size={18} />
        </button>
      </span>
    </div>
  );
}

/** Which controls the edit applies; everything else keeps the source. */
function EditControlsSummary({ studio }) {
  const { entries } = studio;
  if (!studio.editing || !entries.length) return null;
  const { applied, kept } = editSummary(entries);
  return (
    <div className="edit-summary" role="status">
      <span>
        {applied
          ? `${applied} ${applied === 1 ? 'adjustment' : 'adjustments'} applied`
          : 'No controls applied'}
        {kept ? ` · ${kept} kept from the source` : ''}
      </span>
      {applied ? (
        <button
          type="button"
          className="link-btn"
          onClick={studio.keepAllSources}
        >
          Keep all
        </button>
      ) : null}
    </div>
  );
}

function safeGuidanceHref(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function PromptingHelp({ prompting, retention = false }) {
  if (!prompting && !retention) return null;
  prompting = prompting ?? {};
  const counts = Object.keys(prompting.labels ?? {})
    .map(Number)
    .filter((count) => Number.isInteger(count) && count > 1)
    .sort((a, b) => a - b);
  const tagLabels = prompting.labels?.[String(counts.at(-1))] ?? [];
  const multiSource = prompting.example_multiple;
  const multiExample = multiSource?.replace(
    /\{(\d+)\}/g,
    (_, n) => prompting.labels?.['2']?.[Number(n) - 1] ?? `{${n}}`,
  );
  const singleExample = prompting.example_single?.replace(
    /\{(\d+)\}/g,
    (_, n) => prompting.labels?.['1']?.[Number(n) - 1] ?? `{${n}}`,
  );
  const guidanceHref = safeGuidanceHref(prompting.guidance_url);
  return (
    <InfoPopover
      label="Image editing prompt guidance"
      panelClassName="reference-prompt-help"
    >
      {retention ? (
        <p>
          Draft files are saved in this browser across reloads. New draft clears
          them. Kept copies remain available separately.
        </p>
      ) : null}
      <p className="reference-prompt-model">
        <strong>{prompting.model || prompting.strategy}</strong>
        {Number.isInteger(prompting.max_references) &&
        prompting.max_references > 0 ? (
          <span className="reference-prompt-max">
            {' '}
            · up to {prompting.max_references} image
            {prompting.max_references === 1 ? '' : 's'}
          </span>
        ) : null}
      </p>
      {tagLabels.length ? (
        <p className="reference-prompt-tags">
          <strong>Multi-image tags, in order</strong>
          <br />
          {tagLabels.map((tag, index) => (
            <React.Fragment key={`${tag}-${index}`}>
              {index ? ' ' : null}
              <code>{tag}</code>
            </React.Fragment>
          ))}
        </p>
      ) : null}
      {guidanceHref ? (
        <a
          className="btn reference-prompt-guide"
          href={guidanceHref}
          target="_blank"
          rel="noopener noreferrer"
        >
          Official prompting guide
          <span aria-hidden="true">↗</span>
        </a>
      ) : null}
      {Array.isArray(prompting.guidance) ? (
        <ul>
          {prompting.guidance.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {multiExample ? (
        <p>
          <strong>Example:</strong> {multiExample}
        </p>
      ) : null}
      {singleExample && !multiExample ? (
        <p>
          <strong>One image:</strong> {singleExample}
        </p>
      ) : null}
    </InfoPopover>
  );
}

/**
 * Ordered image references for the draft: add, describe, reorder, remove and
 * reattach. Dropping files here adds references; dropping elsewhere on the
 * prompt card imports settings.
 */
export default function References({ studio, leadingAction = null }) {
  const { editCapability: capability, references, retained } = studio;
  const { refs, problem } = references;
  const input = useRef(null);
  const list = useRef(null);
  const addRef = useRef(null);
  const keptButton = useRef(null);
  const [managing, setManaging] = useState(false);
  const [regionEditorOpen, setRegionEditorOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  useReorderMotion(list, JSON.stringify(refs.map((r) => r.id)));
  // References belong to Edit; Text and Asset show the Load image action only.
  const editKind = Boolean(studio.editing) || refs.length > 0;
  if ((!capability || !editKind) && !refs.length && !leadingAction) return null;
  const showReferenceActions =
    editKind && (Boolean(capability) || refs.length > 0);
  const enabled = Boolean(capability?.enabled);
  const max = capability?.maxReferences ?? 0;
  const full = refs.length >= max;
  // A smaller limit after a model change keeps every file and says what to do.
  const overLimit = overLimitReason(refs, capability);
  const canvas = baseDimensions(refs);
  const uploads = studio.discovery.capabilities.data?.uploads;
  const prompting = capability?.prompting;

  const choose = (event) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length) studio.addReferenceFiles(files);
  };
  const drop =
    enabled && editKind
      ? {
          onDragEnter: (event) => {
            if (!hasFiles(event)) return;
            event.preventDefault();
            event.stopPropagation();
            depth.current += 1;
            setDragging(true);
          },
          onDragOver: (event) => {
            if (!hasFiles(event)) return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = 'copy';
          },
          onDragLeave: (event) => {
            if (!hasFiles(event)) return;
            event.stopPropagation();
            depth.current = Math.max(0, depth.current - 1);
            if (!depth.current) setDragging(false);
          },
          onDrop: (event) => {
            if (!hasFiles(event)) return;
            event.preventDefault();
            event.stopPropagation();
            depth.current = 0;
            setDragging(false);
            studio.addReferenceFiles(Array.from(event.dataTransfer.files));
          },
        }
      : {};

  /** Remove from the draft; focus moves to a neighbour, never to the page. */
  const removeFocused = (id) => {
    const at = refs.findIndex((ref) => ref.id === id);
    const neighbour = refs[at + 1] ?? refs[at - 1] ?? null;
    references.remove(id);
    requestAnimationFrame(() => {
      const row = neighbour
        ? list.current?.querySelector(
            `[data-ref="${CSS.escape(neighbour.id)}"]`,
          )
        : null;
      (row?.querySelector('[aria-haspopup="menu"]') ?? addRef.current)?.focus();
    });
  };
  const keptCount = retained?.items?.length ?? 0;
  const closeKept = () => {
    setManaging(false);
    requestAnimationFrame(() =>
      (keptButton.current ?? addRef.current)?.focus(),
    );
  };

  const addButton = (
    <button
      ref={addRef}
      type="button"
      className="pill-btn reference-add"
      disabled={!enabled || full}
      onClick={() => input.current?.click()}
    >
      <Icon name="plus" size={18} />
      Add reference
    </button>
  );

  return (
    <section
      className="references"
      aria-label={showReferenceActions ? 'References' : undefined}
      data-dragging={dragging}
      data-editing={refs.length > 0}
      {...drop}
    >
      <div className="references-head">
        {leadingAction}
        <input
          ref={input}
          className="sr-only"
          type="file"
          multiple
          accept={acceptOf(uploads)}
          tabIndex={-1}
          aria-hidden="true"
          onChange={choose}
        />
        {showReferenceActions ? (
          <span className="reference-add-actions">
            {enabled ? (
              addButton
            ) : (
              <Tip label="Image editing is unavailable on this server">
                {addButton}
              </Tip>
            )}
            {enabled ? (
              <PromptingHelp
                prompting={prompting}
                retention={refs.length > 0}
              />
            ) : null}
          </span>
        ) : null}
        {showReferenceActions && retained?.available && keptCount ? (
          <button
            ref={keptButton}
            type="button"
            className="pill-btn"
            aria-label={`Kept references (${keptCount})`}
            aria-haspopup="dialog"
            onClick={() => setManaging(true)}
          >
            <Icon name="history" size={18} />
            Kept
            <span className="references-kept-count mono">{keptCount}</span>
          </button>
        ) : null}
        {refs.length ? (
          <>
            <span
              className="references-count"
              data-over={overLimit ? 'true' : undefined}
            >
              {max ? `${refs.length} of ${max}` : refs.length} references
            </span>
          </>
        ) : null}
      </div>
      {problem ? (
        <p className="error-text references-problem" role="alert">
          {problem}
          <ErrorDetails
            diagnostic={references.problemDiagnostic}
            label="Reference validation details"
          />
        </p>
      ) : null}
      {studio.draftReferencePersistence?.notice ? (
        <p className="ref-status" data-tone="warning" role="status">
          {studio.draftReferencePersistence.notice.message}
          <WarningDetails
            diagnostic={studio.draftReferencePersistence.notice.diagnostic}
            label="Draft reference storage details"
          />
        </p>
      ) : null}
      {overLimit ? (
        <p className="error-text references-limit" role="status">
          {overLimit}
          <WarningDetails
            diagnostic={localDiagnostic({
              category: 'reference-validation',
              reason: overLimit,
              facts: { attached: refs.length, limit: max },
            })}
            label="Reference limit details"
          />
        </p>
      ) : null}
      {refs.length ? (
        <ol ref={list} className="ref-list">
          {refs.map((item, index) => (
            <ReferenceItem
              key={item.id}
              item={item}
              index={index}
              count={refs.length}
              prompting={prompting}
              references={references}
              retained={retained}
              onRemove={removeFocused}
              onManage={() => setManaging(true)}
              regionEdit={studio.regionEdit ?? null}
              onOpenRegion={() => {
                if (studio.regionEdit?.openEditor()) setRegionEditorOpen(true);
              }}
            />
          ))}
        </ol>
      ) : null}
      {canvas ? (
        <p className="references-canvas">
          Base image{' '}
          <span className="mono">
            {canvas.width}×{canvas.height}
          </span>
          . Aspect and framing follow the base.
        </p>
      ) : null}
      <Proposal studio={studio} />
      <PromptNotice studio={studio} />
      <EditControlsSummary studio={studio} />
      {managing && retained
        ? createPortal(
            <KeptReferencesDialog
              retained={retained}
              urls={studio.urls}
              onClose={closeKept}
            />,
            document.body,
          )
        : null}
      {regionEditorOpen && studio.regionEdit?.open && studio.regionEdit.base
        ? createPortal(
            <RegionEditor
              key={`${studio.regionEdit.base.sha256}:${studio.regionEdit.base.dimensions?.width}x${studio.regionEdit.base.dimensions?.height}`}
              base={studio.regionEdit.base}
              selection={studio.regionEdit.selection}
              capability={studio.regionEdit.capability}
              urls={studio.regionEdit.urls}
              onApply={(selection) => {
                studio.regionEdit.apply(selection);
                setRegionEditorOpen(false);
                requestAnimationFrame(() =>
                  list.current
                    ?.querySelector('[aria-haspopup="menu"]')
                    ?.focus({ preventScroll: true }),
                );
              }}
              onClose={() => {
                setRegionEditorOpen(false);
                studio.regionEdit.closeEditor();
                requestAnimationFrame(() =>
                  (
                    list.current?.querySelector('[aria-haspopup="menu"]') ??
                    addRef.current
                  )?.focus({ preventScroll: true }),
                );
              }}
            />,
            document.body,
          )
        : null}
    </section>
  );
}
