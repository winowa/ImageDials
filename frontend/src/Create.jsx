import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import { ControlList } from './Controls.jsx';
import IdeasPopover from './Ideas.jsx';
import { ExchangeDialog } from './LlmExchange.jsx';
import { pageExchanges } from './llmExchange.js';
import PromptSplit, { usePromptSplit } from './PromptSplit.jsx';
import Walkthrough from './Walkthrough.jsx';
import { ImportPanel, useDropTarget } from './Import.jsx';
import References from './References.jsx';
import ResultMenu from './ResultMenu.jsx';
import ControlPresets from './ControlPresets.jsx';
import { ErrorDetails, WarningDetails } from './ErrorDetails.jsx';
import { localDiagnostic } from './diagnostics.js';
import { useHistoryReveal } from './historyReveal.js';
import { historyShortcut, shortcutLabels } from './draftHistory.js';
import { GROUP } from './controls.js';
import {
  appliesToEdit,
  baseDimensions,
  DRAFT_KIND,
  EDIT_NEEDS_REFERENCE,
} from './references.js';
import { requestFraming } from './outputFraming.js';
import {
  aspectRatioOf,
  describeImage,
  isBrowserUpload,
} from './imageRecord.js';
import { isActive, PHASE } from './jobs.js';
import {
  ASPECT_LABEL,
  ASPECTS,
  dimensionsFor,
  parseDimensions,
  SIZES_UNAVAILABLE,
} from './submission.js';
import { scrollNoticeIntoView, scrollStageIntoView } from './stageScroll.js';
import Viewer from './Viewer.jsx';
import { busyLabel, generateLabel, GenerateOptions } from './Variations.jsx';
import {
  Disclosure,
  handleStripKeys,
  Icon,
  InfoPopover,
  SavedImg,
  Tip,
} from './ui.jsx';

/** Disclosure preferences are session UI state, never draft or wire state. */
function useControlDisclosures(mode) {
  const [states, setStates] = useState({});
  const identity = (entry) =>
    JSON.stringify([mode, entry.group, entry.key, entry.wire.kind]);
  const setExpanded = useCallback(
    (entry, open) => {
      const id = JSON.stringify([
        mode,
        entry.group,
        entry.key,
        entry.wire.kind,
      ]);
      setStates((old) => ({ ...old, [id]: open }));
    },
    [mode],
  );
  return {
    isExpanded: (entry) =>
      states[identity(entry)] ?? entry.group !== GROUP.base,
    setExpanded,
    all: (entries, open) =>
      setStates((old) => ({
        ...old,
        ...Object.fromEntries(entries.map((entry) => [identity(entry), open])),
      })),
  };
}

/**
 * One header action for the panel's category disclosures: it expands every
 * category while any is collapsed, and collapses them once all are open.
 */
function PanelDisclosureActions({ entries, disclosure }) {
  const expanding =
    !entries.length || entries.some((entry) => !disclosure.isExpanded(entry));
  const label = expanding ? 'Expand all' : 'Collapse all';
  return (
    <Tip label={label}>
      <button
        type="button"
        className="icon-btn round disclosure-toggle"
        aria-label={label}
        disabled={!entries.length}
        onClick={(event) => {
          if (
            !expanding &&
            event.currentTarget
              .closest('section')
              ?.contains(document.activeElement)
          )
            event.currentTarget.focus();
          disclosure.all(entries, expanding);
        }}
      >
        <span
          key={expanding ? 'expand' : 'collapse'}
          className="disclosure-icon"
          aria-hidden="true"
        >
          <Icon name={expanding ? 'unfold' : 'fold'} />
        </span>
      </button>
    </Tip>
  );
}

/** Shared by every mode: how the prompt field submits. */
function EnterHint() {
  return (
    <li>
      <strong>Enter</strong> creates the image. <strong>Shift+Enter</strong>{' '}
      adds a new line.
    </li>
  );
}

/**
 * Reference names the selected editing model reads, in list order, from the
 * server's capability. Nothing is shown when the model publishes none.
 */
function editReferenceNames(prompting, count) {
  const labels = prompting?.labels;
  if (!labels || typeof labels !== 'object') return [];
  const wanted = Math.max(count, 1);
  const list = labels[String(wanted)];
  return Array.isArray(list)
    ? list.filter((label) => typeof label === 'string').slice(0, wanted)
    : [];
}

/**
 * What to write for the selected mode. The content follows mode changes while
 * the popover is open; it reads draft state only and never asks a model.
 */
function PromptHelp({ studio }) {
  const kind = studio.kind ?? DRAFT_KIND.text;
  let body;
  if (kind === DRAFT_KIND.edit) {
    const count = studio.references?.refs?.length ?? 0;
    const names = editReferenceNames(studio.editCapability?.prompting, count);
    body = (
      <>
        <p className="popover-lead">
          Describe the <strong>change</strong> to make, and name what must stay
          the same.
        </p>
        <ul>
          <li>
            {count
              ? 'The first image is the base and sets the requested framing. Output dimensions can differ.'
              : 'Add the image to edit first; it becomes the base and sets the framing.'}
          </li>
          {names.length ? (
            <li>
              {count > 1 ? 'Refer to the images as ' : 'Refer to the image as '}
              {names.map((name, index) => (
                <React.Fragment key={`${name}-${index}`}>
                  {index ? ', ' : null}
                  <code>{name}</code>
                </React.Fragment>
              ))}
              {count > 1 ? ', in list order.' : '.'}
            </li>
          ) : null}
          <EnterHint />
        </ul>
      </>
    );
  } else if (kind === DRAFT_KIND.asset) {
    body = (
      <>
        <p className="popover-lead">
          Describe <strong>one object</strong> for an image-to-3D tool.
        </p>
        <ul>
          <li>
            It is shown whole and isolated on a blank black, gray or white
            background that contrasts with it.
          </li>
          <li>This makes an image only, not a 3D model.</li>
          <EnterHint />
        </ul>
      </>
    );
  } else {
    body = (
      <>
        <p className="popover-lead">
          Describe the <strong>image you want</strong> in plain words.
        </p>
        <ul>
          <li>Refine it with the controls below, then create it again.</li>
          <EnterHint />
        </ul>
      </>
    );
  }
  return (
    <InfoPopover label="About the prompt" informational>
      <div key={kind} className="prompt-help-body" data-kind={kind}>
        {body}
      </div>
    </InfoPopover>
  );
}

function OptionsHelp() {
  return (
    <InfoPopover label="About generated controls" informational>
      <p className="popover-lead">
        These controls are written for <strong>your idea</strong>. Each one
        adjusts a different detail of the picture.
      </p>
      <ul>
        <li>Choices, dropdowns and toggles pick between named looks.</li>
        <li>Sliders and text fields set an amount or a short note.</li>
        <li>Add your own choice, or remove a control you do not need.</li>
      </ul>
      <p>Selections are sent with the idea when you create the image.</p>
    </InfoPopover>
  );
}

function StandardHelp({ asset, editing }) {
  return (
    <InfoPopover label="About standard controls" informational>
      <p className="popover-lead">
        {editing ? (
          <>
            Choose what to <strong>preserve or change</strong>.
          </>
        ) : (
          <>
            These controls cover the <strong>overall look</strong>.
          </>
        )}
        {editing
          ? ' All adjustments start off.'
          : asset
            ? ' Asset controls prepare an isolated object.'
            : ''}
      </p>
      <ul>
        <li>
          {editing
            ? 'Apply only the adjustments you want. Keep them consistent with your prompt.'
            : 'Randomize changes Standard selections; off controls stay off.'}
        </li>
        <li>Reset returns every standard control to its default.</li>
      </ul>
    </InfoPopover>
  );
}

function Notice({ studio }) {
  const { notice, privateNotice } = studio;
  if (!notice && privateNotice)
    return (
      <div className="notice" data-tone="info" role="status">
        <span>{privateNotice}</span>
      </div>
    );
  if (!notice) return null;
  return (
    <div
      className="notice"
      data-tone={notice.tone}
      role={
        notice.text === studio.blockReason
          ? undefined
          : notice.tone === 'error'
            ? 'alert'
            : 'status'
      }
    >
      <span>{notice.text}</span>
      {notice.error || notice.diagnostic ? (
        notice.tone === 'error' ? (
          <ErrorDetails error={notice.error} diagnostic={notice.diagnostic} />
        ) : (
          <WarningDetails
            warning={notice.error}
            diagnostic={notice.diagnostic}
          />
        )
      ) : null}
      {notice.onAction ? (
        <button type="button" className="btn" onClick={notice.onAction}>
          {notice.actionLabel}
        </button>
      ) : null}
      <button
        type="button"
        className="icon-btn quiet"
        aria-label="Dismiss message"
        onClick={studio.dismissNotice}
      >
        <Icon name="close" size={18} />
      </button>
      {notice.details ? (
        <Disclosure title="Details">
          <pre className="final-prompt">{notice.details}</pre>
        </Disclosure>
      ) : null}
    </div>
  );
}

/**
 * Output framing, directly under the prompt. Text and Asset choose an aspect;
 * the choice is a preference that Edit leaves untouched. An edit follows its
 * base image, so it shows the base and the size requested for it instead of
 * radios that would not apply.
 */
function AspectChoices({ studio }) {
  const { draft, discovery, editing } = studio;
  if (editing) return <EditFraming studio={studio} />;
  return (
    <fieldset className="aspects" data-tour="aspect">
      <legend>Aspect ratio</legend>
      <div className="aspect-track">
        {ASPECTS.map((aspect) => {
          const size = parseDimensions(
            dimensionsFor(discovery.models.data, aspect),
          );
          const [w, h] = aspect.split(':');
          return (
            <label key={aspect} className="aspect">
              <input
                type="radio"
                name="aspect"
                value={aspect}
                aria-label={aspect}
                checked={draft.aspect === aspect}
                onChange={() => studio.setAspect(aspect)}
              />
              <span className="aspect-card">
                <i className="glyph" style={{ aspectRatio: `${w} / ${h}` }} />
                <span className="aspect-text">
                  <span>{ASPECT_LABEL[aspect]}</span>
                  <small>{aspect}</small>
                </span>
                {size ? (
                  <small className="aspect-size mono">
                    {size.width}×{size.height}
                  </small>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function EditFraming({ studio }) {
  const refs = studio.references?.refs ?? [];
  const base = baseDimensions(refs);
  const framing = requestFraming(
    studio.draft,
    refs,
    studio.discovery.models.data,
  );
  const requested = parseDimensions(framing.dimensions);
  const headingId = useId();
  return (
    <div
      className="aspects edit-framing"
      role="group"
      aria-labelledby={headingId}
      data-tour="aspect"
    >
      <span id={headingId} className="aspects-label">
        Framing
      </span>
      <div className="edit-framing-row">
        <i
          className="glyph"
          aria-hidden="true"
          style={{
            aspectRatio: base ? `${base.width} / ${base.height}` : '1 / 1',
          }}
          data-empty={base ? undefined : 'true'}
        />
        {base ? (
          <dl className="edit-framing-facts">
            <div>
              <dt>Base</dt>
              <dd className="mono">
                {base.width}×{base.height}
              </dd>
            </div>
            {requested ? (
              <div>
                <dt>Requested</dt>
                <dd>
                  {ASPECT_LABEL[framing.aspect]}{' '}
                  <span className="mono">
                    {requested.width}×{requested.height}
                  </span>
                </dd>
              </div>
            ) : null}
          </dl>
        ) : (
          <p className="edit-framing-empty">Follows the base image.</p>
        )}
      </div>
    </div>
  );
}

const KIND_CHOICES = [
  { kind: DRAFT_KIND.text, label: 'Text to image', icon: 'sparkles' },
  { kind: DRAFT_KIND.edit, label: 'Edit image', icon: 'pencil' },
  { kind: DRAFT_KIND.asset, label: 'Asset image for 3D', icon: 'cube' },
];

/**
 * Text to image, Edit or Asset image: one radio group (arrow keys move the
 * choice, one Tab stop). Edit holds the references; leaving it parks them.
 */
function KindToggle({ studio }) {
  const name = `kind-${useId()}`;
  const editable = Boolean(studio.editCapability?.enabled);
  const parked = studio.parkedReferences ?? 0;
  return (
    <fieldset
      className="kind-toggle"
      data-tour="mode"
      style={{
        '--kind-index': Math.max(
          0,
          KIND_CHOICES.findIndex((choice) => choice.kind === studio.kind),
        ),
      }}
    >
      <legend className="sr-only">Generation mode</legend>
      {KIND_CHOICES.map((choice) => {
        const unavailable = choice.kind === DRAFT_KIND.edit && !editable;
        const kept =
          choice.kind === DRAFT_KIND.edit &&
          parked &&
          studio.kind !== choice.kind
            ? parked
            : 0;
        const tip = unavailable
          ? 'Image editing is unavailable on this server'
          : kept
            ? `${choice.label} (${kept === 1 ? '1 reference kept' : `${kept} references kept`})`
            : choice.label;
        return (
          <Tip key={choice.kind} label={tip}>
            <label
              className="kind-option"
              data-checked={studio.kind === choice.kind || undefined}
              data-unavailable={unavailable || undefined}
            >
              <input
                type="radio"
                name={name}
                value={choice.kind}
                aria-label={tip}
                checked={studio.kind === choice.kind}
                disabled={unavailable && studio.kind !== choice.kind}
                onChange={() => {
                  if (!unavailable) studio.setKind(choice.kind);
                }}
              />
              <Icon name={choice.icon} />
              {kept ? (
                <span className="kind-badge mono" aria-hidden="true">
                  {kept}
                </span>
              ) : null}
            </label>
          </Tip>
        );
      })}
    </fieldset>
  );
}

/** Space kept between the docked Generate and the viewport or column edge. */
const DOCK_GAP = 12;
const DOCK_MOTION = { duration: 320, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' };

const calm = () =>
  Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/**
 * Generate docks while its place has scrolled off the top: the same element
 * is pinned to the top edge of the screen, right-aligned with the prompt
 * column (below the safe area and the visible viewport's top), and returns
 * when its place scrolls back. Below the fold it stays inline, including
 * first paint and a keyboard-reduced visual viewport.
 * Position only; layout never changes.
 */
function useGenerateDock({ slot, dock, column }) {
  const [docked, setDocked] = useState(false);
  const dockedRef = useRef(false);
  const from = useRef(null);
  const motion = useRef(null);
  // A passive effect: the column's ref (an ancestor) is attached by then.
  useEffect(() => {
    const origin = slot.current;
    const el = dock.current;
    const col = column.current;
    if (!origin || !el || !col) return undefined;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const root = document.documentElement;
      const viewport = window.visualViewport;
      const top = viewport?.offsetTop ?? 0;
      const bottom = top + (viewport?.height ?? window.innerHeight);
      const place = origin.getBoundingClientRect();
      const area = col.getBoundingClientRect();
      // Only an origin above the visible viewport docks; below-fold content
      // must not acquire a floating action on first paint.
      const next = place.top < top - 1;
      const header = document
        .querySelector('.app-header')
        ?.getBoundingClientRect();
      const headerBottom =
        header && header.bottom > top && header.top < bottom
          ? header.bottom
          : top;
      const dockTop = Math.max(top, headerBottom) + DOCK_GAP;
      const box = el.getBoundingClientRect();
      const right = Math.max(
        DOCK_GAP,
        (root.clientWidth || window.innerWidth) - area.right + DOCK_GAP,
      );
      el.style.setProperty('--dock-right', `${right}px`);
      el.style.setProperty('--dock-top', `${dockTop}px`);
      el.style.setProperty(
        '--dock-max',
        `${Math.max(44, area.width - DOCK_GAP * 2)}px`,
      );
      // Focused controls stop below the docked Generate (CSS scroll-margin).
      col.style.setProperty(
        '--generate-dock-block',
        next ? `${dockTop + box.height + DOCK_GAP}px` : '0px',
      );
      col.style.setProperty(
        '--generate-dock-safe',
        next ? 'env(safe-area-inset-top, 0px)' : '0px',
      );
      if (next !== dockedRef.current) {
        // Where it is drawn now, mid-motion included, for a smooth reversal.
        from.current = {
          rect: box,
          origin: place,
          top,
          bottom,
          moving: motion.current?.playState === 'running',
        };
        dockedRef.current = next;
        setDocked(next);
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    // A control focused behind the docked Generate is moved into view.
    const focus = (event) => {
      const target = event.target;
      if (!dockedRef.current || el.contains(target)) return;
      requestAnimationFrame(() => {
        if (
          !target.isConnected ||
          document.activeElement !== target ||
          target.closest('[inert]')
        )
          return;
        const own = target.getBoundingClientRect();
        const over = el.getBoundingClientRect();
        if (
          own.top < over.bottom + DOCK_GAP &&
          own.bottom > over.top &&
          own.right > over.left &&
          own.left < over.right
        )
          window.scrollBy(0, own.top - (over.bottom + DOCK_GAP));
      });
    };
    const observer =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver(schedule)
        : null;
    observer?.observe(col);
    observer?.observe(origin);
    observer?.observe(el);
    window.addEventListener('scroll', schedule, {
      passive: true,
      capture: true,
    });
    window.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule);
    col.addEventListener('focusin', focus);
    measure();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('scroll', schedule, { capture: true });
      window.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('scroll', schedule);
      col.removeEventListener('focusin', focus);
      col.style.removeProperty('--generate-dock-block');
      col.style.removeProperty('--generate-dock-safe');
    };
  }, [slot, dock, column]);

  // Slide to the new place, then the label opens (CSS); reversed mid-way it
  // starts from where it is drawn. Reduced motion moves at once.
  useLayoutEffect(() => {
    const el = dock.current;
    const start = from.current;
    from.current = null;
    if (!el || !start || typeof el.animate !== 'function') return;
    motion.current?.cancel();
    motion.current = null;
    if (calm()) return;
    const end = el.getBoundingClientRect();
    const originShown =
      start.origin.bottom > start.top && start.origin.top < start.bottom;
    let frames;
    if (docked && !originShown && !start.moving) {
      // Its place left the screen: it drops into the dock from the top edge.
      frames = [
        {
          transform: `translateY(${-(end.height + DOCK_GAP * 2)}px)`,
          opacity: 0,
        },
        { transform: 'none', opacity: 1 },
      ];
    } else {
      const dx = start.rect.right - end.right;
      const dy =
        start.rect.top + start.rect.height / 2 - (end.top + end.height / 2);
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      frames = [
        { transform: `translate(${dx}px, ${dy}px)` },
        { transform: 'none' },
      ];
    }
    motion.current = el.animate(frames, DOCK_MOTION);
  }, [docked, dock]);
  useEffect(() => () => motion.current?.cancel(), []);
  return docked;
}

/**
 * The one Generate control: a round send button beside Ideas, which docks
 * as a labelled pill (with its images-per-request menu) at the top of the
 * screen while its place has scrolled off. Disabled reasons are named under the prompt and in the pill.
 */
function GenerateDock({ studio, statusId, column }) {
  const slot = useRef(null);
  const dock = useRef(null);
  const docked = useGenerateDock({ slot, dock, column });
  const { draft, job, blockReason, basedOn } = studio;
  const active = isActive(job);
  const label = active
    ? busyLabel(job)
    : generateLabel(studio, { regenerate: Boolean(basedOn) });
  const split = Boolean(studio.variations?.capability);
  const disabled = !draft.prompt.trim() || active || Boolean(blockReason);
  // At rest the reason is under the prompt; docked, the pill names it too.
  const reason = docked && !active && blockReason ? blockReason : null;
  return (
    <span ref={slot} className="generate-slot" data-split={split || undefined}>
      <div
        ref={dock}
        className="generate-dock"
        data-docked={docked || undefined}
        data-busy={active || undefined}
      >
        <Tip label={label} hidden={docked}>
          <button
            type="button"
            className="generate-btn"
            data-tour="generate"
            aria-label={label}
            aria-describedby={statusId}
            disabled={disabled}
            onClick={() => studio.submit({ explicit: true })}
          >
            <span className="generate-icon" aria-hidden="true">
              {active ? (
                <span className="generate-spinner" />
              ) : (
                <Icon name="send" />
              )}
            </span>
            <span className="generate-text" aria-hidden="true">
              <span className="generate-text-inner">
                <span key={label} className="generate-label">
                  {label}
                </span>
                {reason ? (
                  <small className="generate-reason">{reason}</small>
                ) : null}
              </span>
            </span>
          </button>
        </Tip>
        <GenerateOptions studio={studio} />
      </div>
    </span>
  );
}

/** Why Generate is unavailable, or what it is doing, under the prompt. */
function GenerateStatus({ studio, statusId }) {
  const { job, blockReason } = studio;
  const active = isActive(job);
  const routine =
    blockReason?.endsWith('…') || blockReason === EDIT_NEEDS_REFERENCE;
  const cause =
    blockReason === SIZES_UNAVAILABLE
      ? studio.discovery.models.error
      : studio.capacityError?.message === blockReason
        ? studio.capacityError
        : null;
  return (
    <div
      id={statusId}
      className="status-line generate-status"
      aria-live="polite"
    >
      {active ? (
        <span>{busyLabel(job)}</span>
      ) : blockReason ? (
        <span className={routine ? '' : 'error-text'}>
          {blockReason}
          {!routine ? (
            <WarningDetails
              warning={cause}
              diagnostic={
                cause
                  ? undefined
                  : localDiagnostic({
                      category: 'validation',
                      reason: blockReason,
                      facts: { Mode: studio.kind },
                    })
              }
            />
          ) : null}
          {blockReason === SIZES_UNAVAILABLE ? (
            <RetrySizes studio={studio} />
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

function PromptCard({ studio, area, tourRoot, onNewDraft, statusId, column }) {
  const shortcuts = shortcutLabels();
  const { draft, job, blockReason } = studio;
  // In Edit every dropped image is a reference; elsewhere a drop loads the
  // file's saved settings, like Load image.
  const drop = useDropTarget((file, files) =>
    studio.editing ? studio.addReferenceFiles(files) : studio.importImage(file),
  );
  const pickIdea = (idea) => {
    studio.pickSuggestion(idea);
    area.current?.focus();
  };
  const active = isActive(job);
  const canSubmit = Boolean(draft.prompt.trim()) && !active && !blockReason;

  const keys = (event) => {
    // Enter submits; Shift+Enter is a newline; Enter confirming an IME
    // composition (keyCode 229 on some browsers) must not submit.
    if (event.key !== 'Enter' || event.shiftKey) return;
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (canSubmit) studio.submit({ explicit: true });
  };

  const jumpToResult = () =>
    document.getElementById('result')?.scrollIntoView({
      behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth',
      block: 'start',
    });

  return (
    <section
      className="panel prompt-card"
      aria-label="Prompt"
      data-dragging={drop.dragging}
      {...drop.props}
    >
      <div className="panel-head">
        <h2>Your prompt</h2>
        <PromptHelp studio={studio} />
        <Walkthrough rootRef={tourRoot} />
        <ResultMenu
          label="Draft actions"
          compact
          triggerIcon={<Icon name="history" />}
          items={[
            {
              id: 'undo-draft',
              label: studio.historyState.undoLabel
                ? `Undo ${studio.historyState.undoLabel.toLowerCase()}`
                : 'Undo',
              hint: shortcuts.undo,
              disabled: !studio.historyState.canUndo,
              onSelect: studio.undoDraft,
            },
            {
              id: 'redo-draft',
              label: studio.historyState.redoLabel
                ? `Redo ${studio.historyState.redoLabel.toLowerCase()}`
                : 'Redo',
              hint: shortcuts.redo,
              disabled: !studio.historyState.canRedo,
              onSelect: studio.redoDraft,
            },
          ]}
        />
        <span className="sr-only" aria-live="polite" aria-atomic="true">
          {studio.historyStep
            ? `${studio.historyStep.direction === 'undo' ? 'Undid' : 'Redid'} ${studio.historyStep.label}.`
            : ''}
        </span>
        <button
          type="button"
          className="pill-btn"
          onClick={onNewDraft ?? studio.newDraft}
        >
          <Icon name="refresh" size={18} />
          New draft
        </button>
      </div>
      <div className="prompt-wrap">
        <label htmlFor="prompt" className="sr-only">
          Image idea
        </label>
        <textarea
          id="prompt"
          ref={area}
          className="prompt-field"
          rows={4}
          value={draft.prompt}
          maxLength={4000}
          data-tour="prompt"
          placeholder={
            studio.editing
              ? 'Describe the change to make.'
              : 'Describe the image you want.'
          }
          onChange={(event) => studio.setPrompt(event.target.value)}
          onKeyDown={keys}
        />
        <div
          className="prompt-bar"
          onPointerDown={(event) => {
            // Blank space in the row belongs to the text above it.
            if (event.target !== event.currentTarget) return;
            event.preventDefault();
            area.current?.focus();
          }}
        >
          <KindToggle studio={studio} />
          <div
            className="prompt-tools"
            role="group"
            aria-label="Prompt actions"
          >
            <IdeasPopover studio={studio} onPick={pickIdea} />
            <GenerateDock studio={studio} statusId={statusId} column={column} />
          </div>
        </div>
      </div>
      <GenerateStatus studio={studio} statusId={statusId} />
      <AspectChoices studio={studio} />
      <ImportPanel
        studio={studio}
        renderAction={(action) => (
          // Edit takes images as references only, so Load image is not offered.
          <References
            studio={studio}
            leadingAction={studio.editing ? null : action}
          />
        )}
      />
      <Notice studio={studio} />
      <button type="button" className="pill-btn jump" onClick={jumpToResult}>
        <Icon name="down" size={18} />
        Go to image
      </button>
    </section>
  );
}

/** Size lookups can be retried without leaving the page. */
function RetrySizes({ studio }) {
  return (
    <>
      {' '}
      <button
        type="button"
        className="link-btn"
        onClick={studio.discovery.reloadModels}
      >
        Retry
      </button>
    </>
  );
}

function Skeleton({ rows = 3 }) {
  return (
    <div className="skeleton" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} style={{ '--i': i }} />
      ))}
    </div>
  );
}

/** Appends new controls to the end of the generated list. */
function MoreControls({ studio }) {
  const { additional } = studio;
  const loading = additional.status === 'loading';
  let status = null;
  if (additional.status === 'error')
    status = (
      <p className="control-status error-text" role="alert">
        More controls failed: {additional.error.message}{' '}
        <ErrorDetails error={additional.error} />
        <button type="button" className="link-btn" onClick={studio.addControls}>
          Retry
        </button>
      </p>
    );
  else if (additional.status === 'added')
    status = (
      <p className="control-status" role="status">
        {additional.added === 1
          ? 'Added 1 control.'
          : `Added ${additional.added} controls.`}
      </p>
    );
  else if (studio.controlsFull)
    status = (
      <p className="control-status" role="status">
        The control limit is reached.
      </p>
    );
  return (
    <div className="more-controls">
      <button
        type="button"
        className="pill-btn dashed"
        aria-busy={loading}
        disabled={loading || !studio.canAddControls}
        onClick={studio.addControls}
      >
        <Icon name="spark" size={16} />
        {loading ? 'Adding controls…' : 'More controls'}
      </button>
      {status}
    </div>
  );
}

function OptionsCard({ studio, disclosure }) {
  const [staleOpen, setStaleOpen] = useState(false);
  const [retainedOpen, setRetainedOpen] = useState(true);
  const retainedId = useId();
  const staleId = useId();
  const { draft, dynamic, entries } = studio;
  // Arrived controls stay hidden while their reveal is held (usable already).
  const generated = studio.revealHeld
    ? []
    : entries.filter((e) => e.group === GROUP.generated);
  const retained = generated.filter((entry) => entry.retained);
  const current = generated.filter((entry) => !entry.retained);
  const visible = current.filter(
    (entry) =>
      !studio.dynamicStale ||
      (studio.editing
        ? appliesToEdit(entry)
        : entry.enabled !== false && entry.intentClass === 'manual'),
  );
  const stale = current.filter((entry) => !visible.includes(entry));
  const loading = dynamic.status === 'loading' || studio.revealHeld;
  const exchanges = useMemo(
    () =>
      pageExchanges({
        dynamic,
        additionalMetadata: studio.additionalMetadata,
        stale: studio.dynamicStale,
      }),
    [dynamic, studio.additionalMetadata, studio.dynamicStale],
  );
  const hasEvidence = exchanges.some((item) => item.state !== 'unavailable');
  const [inspecting, setInspecting] = useState(null);
  const inspectTrigger = useRef(null);
  const openExchange = (event) =>
    setInspecting({ opener: event.currentTarget });
  const closeExchange = () => {
    const { opener } = inspecting;
    setInspecting(null);
    // The failure link leaves with the failure; the header button remains.
    requestAnimationFrame(() =>
      (opener?.isConnected ? opener : inspectTrigger.current)?.focus(),
    );
  };
  return (
    <section
      className="panel options-card"
      aria-label="Generated controls"
      aria-busy={loading}
      data-tour="options"
    >
      <div className="panel-head">
        <h2>Generated controls</h2>
        <span className="control-count">
          {generated.length} generated · {entries.length} of{' '}
          {studio.controlLimit ?? 30} controls
        </span>
        <OptionsHelp />
        <span className="head-actions">
          <PanelDisclosureActions entries={generated} disclosure={disclosure} />
          {generated.length || hasEvidence ? (
            <Tip label="Request and response">
              <button
                ref={inspectTrigger}
                type="button"
                className="icon-btn round"
                aria-label="Show controls request and response"
                aria-haspopup="dialog"
                onClick={openExchange}
              >
                <Icon name="braces" />
              </button>
            </Tip>
          ) : null}
          <Tip label="Regenerate options">
            <button
              type="button"
              className="icon-btn round head-end"
              aria-label="Regenerate options"
              disabled={!draft.prompt.trim() || loading}
              onClick={studio.regenerateOptions}
            >
              <Icon name="refresh" />
            </button>
          </Tip>
        </span>
      </div>
      <div
        className="status-line"
        aria-live={
          studio.capacityError?.message === studio.blockReason
            ? 'off'
            : 'polite'
        }
      >
        {dynamic.status === 'error' ? (
          <span className="error-text">
            {studio.capacityError?.message ??
              `Options failed: ${dynamic.error.message}`}{' '}
            <ErrorDetails error={studio.capacityError ?? dynamic.error} />
            <button
              type="button"
              className="link-btn"
              onClick={studio.regenerateOptions}
            >
              Retry
            </button>
            {hasEvidence && !studio.capacityError ? (
              <button
                type="button"
                className="link-btn"
                aria-haspopup="dialog"
                onClick={openExchange}
              >
                Request and response
              </button>
            ) : null}
          </span>
        ) : studio.dynamicStale ? (
          <span>
            {studio.editing
              ? 'Options for an earlier idea or reference set.'
              : 'Options for an earlier idea.'}
          </span>
        ) : null}
      </div>
      {loading && !generated.length ? (
        <Skeleton />
      ) : generated.length ? (
        <div
          className="control-panel"
          data-loading={loading}
          data-stale={studio.dynamicStale}
        >
          <ControlList
            entries={visible}
            editors={studio}
            removable
            disclosure={disclosure}
          />
          {stale.length ? (
            <>
              <button
                type="button"
                className="style-toggle stale-toggle"
                aria-expanded={staleOpen}
                aria-controls={staleId}
                onClick={() => setStaleOpen(!staleOpen)}
              >
                <span className="category-chevron" aria-hidden="true">
                  <Icon name="chevron" size={18} />
                </span>
                Options for the earlier idea ({stale.length})
              </button>
              <div
                id={staleId}
                className="category-body"
                data-collapsed={!staleOpen || undefined}
                inert={!staleOpen}
                aria-hidden={!staleOpen || undefined}
              >
                <div className="category-inner">
                  <ControlList
                    entries={stale}
                    editors={studio}
                    removable
                    disclosure={disclosure}
                  />
                </div>
              </div>
            </>
          ) : null}
          {retained.length ? (
            <section
              className="retained-controls"
              aria-label={`Kept from earlier options (${retained.length})`}
            >
              <h3>
                <button
                  type="button"
                  className="style-toggle"
                  aria-expanded={retainedOpen}
                  aria-controls={retainedId}
                  onClick={() => setRetainedOpen(!retainedOpen)}
                >
                  <span className="category-chevron" aria-hidden="true">
                    <Icon name="chevron" size={18} />
                  </span>
                  Kept from earlier options ({retained.length})
                </button>
              </h3>
              <div
                id={retainedId}
                className="category-body"
                data-collapsed={!retainedOpen || undefined}
                inert={!retainedOpen}
                aria-hidden={!retainedOpen || undefined}
              >
                <div className="category-inner">
                  <ControlList
                    entries={retained}
                    editors={studio}
                    removable
                    disclosure={disclosure}
                  />
                </div>
              </div>
            </section>
          ) : null}
          <MoreControls studio={studio} />
        </div>
      ) : (
        <div className="empty-panel">
          <p>
            {dynamic.status === 'ready'
              ? 'No idea-specific options were returned.'
              : 'Options for your idea appear here.'}
          </p>
        </div>
      )}
      {inspecting ? (
        <ExchangeDialog
          exchanges={exchanges}
          title="Controls request and response"
          onClose={closeExchange}
        />
      ) : null}
    </section>
  );
}

/** Standard selections stay visible in every mode; categories disclose independently. */
function StandardCard({ studio, disclosure }) {
  const { draft, entries, base } = studio;
  const standard = entries.filter((e) => e.group === GROUP.base);
  const asset = draft.mode === 'asset-image';
  const editing = Boolean(studio.editing);
  const title = asset && !editing ? 'Asset controls' : 'Standard controls';
  return (
    <section
      className="panel standard-card"
      aria-label={title}
      aria-busy={base.status === 'loading'}
      data-editing={editing || undefined}
    >
      <div className="panel-head">
        <h2>{title}</h2>
        <StandardHelp asset={asset} editing={editing} />
        {studio.standardSummary ? (
          <span className="control-count">
            {studio.standardSummary.total} controls
            {studio.standardSummary.pending
              ? ` · ${studio.standardSummary.pending} choosing`
              : ''}
            {studio.standardSummary.suggested
              ? ` · ${studio.standardSummary.suggested} suggested`
              : ''}
            {studio.standardSummary.manual
              ? ` · ${studio.standardSummary.manual} manual`
              : ''}
            {studio.standardSummary.disabled +
            studio.standardSummary.suggestedOff
              ? ` · ${studio.standardSummary.disabled + studio.standardSummary.suggestedOff} model decides`
              : ''}
          </span>
        ) : null}
        <ControlPresets
          studio={studio}
          lead={
            <PanelDisclosureActions
              entries={standard}
              disclosure={disclosure}
            />
          }
        >
          {!editing ? (
            <Tip label="Randomize Standard selections. Off controls stay off.">
              <button
                type="button"
                className="icon-btn round"
                aria-label="Randomize standard controls"
                disabled={!standard.length || base.status === 'loading'}
                onClick={studio.randomizeBase}
              >
                <svg
                  viewBox="0 0 24 24"
                  width="20"
                  height="20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="m17 3 4 4-4 4M3 7h3c5 0 7 10 12 10h3m-4-4 4 4-4 4M3 17h3c2 0 4-2 5-4m3-3c1-2 3-3 4-3h3" />
                </svg>
              </button>
            </Tip>
          ) : null}
          <Tip label="Reset standard controls">
            <button
              type="button"
              className="icon-btn round head-end"
              aria-label="Reset standard controls"
              disabled={!standard.length}
              onClick={studio.resetBase}
            >
              <Icon name="undo" />
            </button>
          </Tip>
        </ControlPresets>
      </div>
      <div className="standard-body">
        <div className="style-inner">
          {base.status === 'loading' && !standard.length ? (
            <Skeleton rows={4} />
          ) : standard.length ? (
            <div className="control-panel">
              <ControlList
                entries={standard}
                editors={studio}
                disclosure={disclosure}
              />
            </div>
          ) : (
            <div
              className="empty-panel"
              role={base.error ? 'alert' : undefined}
            >
              <p>
                {base.error
                  ? `Standard controls could not be loaded: ${base.error.message}`
                  : 'No standard controls are loaded.'}
              </p>
              {base.error ? <ErrorDetails error={base.error} /> : null}
              <button type="button" className="btn" onClick={studio.reloadBase}>
                <Icon name="refresh" size={18} />
                Load standard controls
              </button>
              {base.error?.details ? (
                <Disclosure title="Details">
                  <pre className="final-prompt">{base.error.details}</pre>
                </Disclosure>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

const PENDING_TAG = {
  [PHASE.preview]: 'Preview',
  [PHASE.failed]: 'Failed',
  [PHASE.lost]: 'Stalled',
};
const PENDING_VERB = {
  [PHASE.preview]: 'Preview ready',
  [PHASE.failed]: 'Failed',
  [PHASE.lost]: 'Status unavailable',
};

/** Concise accessible name of an item that is not a saved image yet. */
const pendingName = (image) =>
  `${PENDING_VERB[image.client_pending.phase] ?? 'Generating'}: ${image.title}`;

/** The picture of a pending item: its preview, else the result it replaces. */
function PendingMedia({ pending }) {
  if (pending.preview?.image_url)
    return <img src={pending.preview.image_url} alt="" />;
  if (pending.previous) return <SavedImg image={pending.previous} />;
  return <span className="thumb-blank" aria-hidden="true" />;
}

/**
 * Keeps the strip where the person left it when items are inserted ahead of
 * the visible ones (an accepted job, a finished image, a refresh). The first
 * visible item is measured while the previous commit is still on screen, then
 * put back at the same offset after the update. The target is absolute, so a
 * browser's own scroll-snap adjustment cannot be applied twice. Nothing moves
 * while the strip is at its start.
 */
function useStablePosition(ref, items, holdStart = false) {
  const hasItems = items.length > 0;
  const anchor = useRef(null);
  const holdRef = useRef(holdStart);
  const measure = useCallback(() => {
    const strip = ref.current;
    const left = strip?.scrollLeft ?? 0;
    // At the very start only rows that can arrive before it need holding.
    const first =
      strip &&
      (left > 0 || holdRef.current) &&
      [...strip.children].find((n) => n.offsetLeft + n.offsetWidth > left);
    anchor.current = first
      ? { key: first.dataset.key, x: first.offsetLeft - left }
      : null;
  }, [ref]);
  // Every scroll refreshes the anchor, so it describes the last stable view.
  useEffect(() => {
    const strip = ref.current;
    strip?.addEventListener('scroll', measure, { passive: true });
    return () => strip?.removeEventListener('scroll', measure);
  }, [ref, measure, hasItems]);
  useLayoutEffect(() => {
    const strip = ref.current;
    const saved = anchor.current;
    const li =
      strip && saved
        ? [...strip.children].find((n) => n.dataset.key === saved.key)
        : null;
    const target = li ? li.offsetLeft - saved.x : null;
    // Absolute, so a browser's own scroll-snap adjustment is not applied twice.
    if (target !== null && Math.abs(strip.scrollLeft - target) > 1)
      strip.scrollLeft = target;
    holdRef.current = holdStart;
    measure();
  }, [ref, items, measure, holdStart]);
  return measure;
}

/** The most thumbnails in the strip's DOM, whatever history holds. */
export const STRIP_DOM_LIMIT = 132;
/** Items a range moves by when it reaches its edge. */
const STRIP_RANGE_STEP = 44;

const stripKey = (image) => image.client_key ?? describeImage(image).key;

/**
 * The part of the history in the DOM, plus edge loading: nearing an end of the
 * mounted range first moves the range, then asks for the adjacent page. The
 * range follows an item, so a new item ahead of it does not move what is shown.
 */
function useStripRange(ref, items, center, historyWindow) {
  const [startKey, setStartKey] = useState(null);
  const found = startKey
    ? items.findIndex((image) => stripKey(image) === startKey)
    : 0;
  let start = Math.max(0, found);
  const centerIndex = center
    ? items.findIndex((image) => stripKey(image) === center.key)
    : -1;
  if (
    centerIndex >= 0 &&
    (centerIndex < start || centerIndex >= start + STRIP_DOM_LIMIT)
  )
    start = Math.max(0, centerIndex - Math.floor(STRIP_DOM_LIMIT / 2));
  start = Math.min(start, Math.max(0, items.length - STRIP_DOM_LIMIT));
  const end = Math.min(items.length, start + STRIP_DOM_LIMIT);
  const shown = items.slice(start, end);
  const moveTo = useCallback(
    (index) => setStartKey(index > 0 ? stripKey(items[index]) : null),
    [items],
  );

  const latest = useRef({});
  useLayoutEffect(() => {
    latest.current = { start, end, total: items.length, moveTo, historyWindow };
  });
  const mounted = shown.length > 0;
  const check = useCallback(() => {
    const strip = ref.current;
    if (!strip?.clientWidth) return;
    const {
      start: from,
      end: to,
      total,
      moveTo: move,
      historyWindow: win,
    } = latest.current;
    const margin = strip.clientWidth;
    if (strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - margin) {
      if (to < total) move(from + STRIP_RANGE_STEP);
      else if (win?.hasLater && !win.busy) win.loadLater();
    }
    if (strip.scrollLeft <= margin) {
      if (from > 0) move(Math.max(0, from - STRIP_RANGE_STEP));
      else if (win?.hasEarlier && !win.busy) win.loadEarlier();
    }
  }, [ref]);
  useEffect(() => {
    const strip = ref.current;
    strip?.addEventListener('scroll', check, { passive: true });
    return () => strip?.removeEventListener('scroll', check);
  }, [ref, check, mounted]);
  // A page that landed, or a refresh that took over a load, re-checks the edge.
  const busy = historyWindow?.busy ?? false;
  useEffect(() => {
    if (!busy) check();
  }, [check, busy, items]);
  return { shown, start, end, total: items.length, moveTo };
}

/**
 * Centers one history item for a request, once. The request waits until the
 * item's element is mounted; after centering it is reported done, so later
 * refreshes, selection and remounts leave the strip alone. Declared after
 * `useStablePosition`, so its absolute position is the last one set.
 */
function useCenterOnce(ref, items, request, onDone) {
  const done = useRef(null);
  useLayoutEffect(() => {
    const strip = ref.current;
    if (!request || done.current === request.token || !strip) return;
    const li = [...strip.children].find((n) => n.dataset.key === request.key);
    if (!li) return;
    done.current = request.token;
    // Snapping aligns items to their start; this one must hold the center.
    li.style.scrollSnapAlign = 'center';
    strip.scrollLeft = Math.max(
      0,
      li.offsetLeft - (strip.clientWidth - li.offsetWidth) / 2,
    );
    onDone?.();
  }, [ref, items, request, onDone]);
}

/**
 * Saved images in newest-first order. Choosing one restores its full draft
 * (prompt, controls, provenance, mode and nearest size). The strip preserves
 * manual browsing, except for a newly completed selected result, revealed
 * once within this strip only. Arrows, Home/End and Page Up/Down navigate
 * it by keyboard; touch scrolls it natively.
 */
const Carousel = React.forwardRef(function Carousel(
  { studio, center, onCentered },
  ref,
) {
  const { history: images, current, historyWindow, restoring } = studio;
  const list = useRef(null);
  const [revealed, setRevealed] = useState(null);
  const reveal =
    studio.historyReveal !== revealed ? studio.historyReveal : null;
  // The selected completion can lead an older catalog window. Its synthetic
  // head must not cause repeated earlier-page fetches across the missing gap.
  const stripWindow = studio.historyCompletionPinned
    ? { ...historyWindow, hasEarlier: false }
    : historyWindow;
  const range = useStripRange(list, images, reveal ?? center, stripWindow);
  const measurePosition = useStablePosition(
    list,
    range.shown,
    range.start > 0 || Boolean(historyWindow?.hasEarlier),
  );
  useCenterOnce(list, range.shown, center, onCentered);
  useHistoryReveal(list, range.shown, reveal, (request) => {
    measurePosition();
    range.moveTo(range.start);
    setRevealed(request);
    studio.historyRevealed?.(request);
  });
  // Home and End reach the ends of the history, loading them when needed.
  const pendingFocus = useRef(null);
  useLayoutEffect(() => {
    const strip = list.current;
    const wanted = pendingFocus.current;
    if (!wanted || !strip || historyWindow?.busy) return;
    pendingFocus.current = null;
    const buttons = strip.querySelectorAll('button:not(:disabled)');
    const target =
      wanted === 'first' ? buttons[0] : buttons[buttons.length - 1];
    strip.scrollLeft = wanted === 'first' ? 0 : strip.scrollWidth;
    target?.focus({ preventScroll: true });
  });
  const keys = (event) => {
    const toStart = event.key === 'Home';
    if (toStart || event.key === 'End') {
      event.preventDefault();
      const wanted = toStart ? 'first' : 'last';
      pendingFocus.current = wanted;
      range.moveTo(toStart ? 0 : Math.max(0, images.length - STRIP_DOM_LIMIT));
      if (toStart && historyWindow?.hasEarlier) historyWindow.loadFirst();
      else if (!toStart && historyWindow?.hasLater) historyWindow.loadLast();
      // Nothing may change: focus still moves to the end that was asked for.
      else setFocusTick((n) => n + 1);
      return;
    }
    handleStripKeys(event);
  };
  const [, setFocusTick] = useState(0);
  if (!images.length) return null;
  return (
    <section ref={ref} className="carousel panel" aria-label="Saved images">
      <ul ref={list} onKeyDown={keys}>
        {range.shown.map((image) => {
          const view = describeImage(image);
          const local = isBrowserUpload(image);
          const pending = image.client_pending;
          const key = image.client_key ?? view.key;
          return (
            <li key={key} data-key={key}>
              <button
                type="button"
                className="thumb"
                data-pending={pending ? pending.phase : undefined}
                aria-label={
                  pending
                    ? pendingName(image)
                    : local
                      ? `${view.title} (imported, not saved)`
                      : view.title
                }
                aria-current={current === image}
                aria-busy={restoring === view.key || undefined}
                style={{
                  aspectRatio:
                    aspectRatioOf(image) ??
                    (view.requestedSize
                      ? `${view.requestedSize.width} / ${view.requestedSize.height}`
                      : undefined),
                }}
                onClick={() => studio.restore(image)}
              >
                {pending ? (
                  <PendingMedia pending={pending} />
                ) : (
                  <SavedImg image={image} />
                )}
                {pending ? (
                  <span className="thumb-tag">
                    {PENDING_TAG[pending.phase] ?? 'Generating'}
                  </span>
                ) : local ? (
                  <span className="thumb-tag">Imported</span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
});

/** Share of the strip that must be on screen for it to count as visible. */
const CAROUSEL_VISIBLE_RATIO = 0.4;

/**
 * True while the element is inside both its scrolling pane and the viewport.
 * IntersectionObserver clips against every scrolling ancestor and the
 * viewport, and reports again on scroll, resize and rotation. Without it
 * (old browsers, test DOMs) the element counts as visible and nothing shows.
 */
function useOnScreen(ref, active) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const node = ref.current;
    if (!active || !node || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      ([entry]) =>
        setVisible(
          entry.isIntersecting &&
            entry.intersectionRatio >= CAROUSEL_VISIBLE_RATIO,
        ),
      { threshold: [0, 0.2, CAROUSEL_VISIBLE_RATIO, 0.7, 1] },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, active]);
  return visible;
}

/**
 * Brings the saved-image strip into view when it is clipped by the sticky
 * pane or below the fold. Only an explicit press moves anything.
 */
function HistoryShortcut({ target, show }) {
  if (!show) return null;
  const go = () => {
    const strip = target.current;
    if (!strip) return;
    const calm = window.matchMedia?.(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    strip.scrollIntoView({
      behavior: calm ? 'auto' : 'smooth',
      block: 'nearest',
      inline: 'nearest',
    });
    // Focus lands on the selected image (or the first) without moving the strip.
    const thumb =
      strip.querySelector('.thumb[aria-current="true"]') ??
      strip.querySelector('.thumb');
    thumb?.focus({ preventScroll: true });
  };
  return createPortal(
    <div className="history-shortcut">
      <Tip label="Show saved images">
        <button
          type="button"
          className="icon-btn round"
          aria-label="Show saved images"
          onClick={go}
        >
          <Icon name="history" />
        </button>
      </Tip>
    </div>,
    document.body,
  );
}

export default function Create({
  studio,
  center = null,
  onCentered,
  onNewDraft,
}) {
  const area = useRef(null);
  const column = useRef(null);
  const carousel = useRef(null);
  const root = useRef(null);
  const split = usePromptSplit(root);
  const layoutId = useId();
  const statusId = `generate-status-${layoutId}`;
  const disclosure = useControlDisclosures(studio.draft.mode);
  const promptId = `create-prompt-${layoutId}`;
  const stageId = `create-stage-${layoutId}`;
  const shortcuts = shortcutLabels();
  useEffect(() => {
    const onKeyDown = (event) => {
      const action = historyShortcut(event, { apple: shortcuts.apple });
      if (!action) return;
      const available =
        action === 'undo'
          ? studio.historyState.canUndo
          : studio.historyState.canRedo;
      if (!available) return;
      event.preventDefault();
      if (action === 'undo') studio.undoDraft();
      else studio.redoDraft();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [studio, shortcuts.apple]);
  const hasHistory = studio.history.length > 0;
  const onScreen = useOnScreen(carousel, hasHistory);
  const showShortcut = hasHistory && !onScreen;
  // Only an explicit Generate request moves the page, once the layout settled.
  const { scrollRequest } = studio;
  useEffect(() => {
    if (!scrollRequest) return undefined;
    let outer = 0;
    let inner = 0;
    outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() =>
        scrollRequest.target === 'stage'
          ? scrollStageIntoView()
          : scrollNoticeIntoView(),
      );
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [scrollRequest]);
  const edit = (image) => {
    studio.restore(image);
    requestAnimationFrame(() => area.current?.focus());
  };
  return (
    <div
      className="studio"
      ref={root}
      data-split-layout={split.layout}
      data-split-resizable={split.bounds.resizable}
      style={{
        gridTemplateColumns: split.columns,
        columnGap: split.columnGap,
      }}
    >
      <div className="studio-main" id={promptId} ref={column}>
        <PromptCard
          studio={studio}
          area={area}
          tourRoot={root}
          onNewDraft={onNewDraft}
          statusId={statusId}
          column={column}
        />
        <OptionsCard studio={studio} disclosure={disclosure} />
        <StandardCard studio={studio} disclosure={disclosure} />
      </div>
      <PromptSplit id={promptId} separator={split.separator} />
      <div className="studio-side" id={stageId}>
        <Viewer studio={studio} onEdit={edit} />
        {studio.historyWindow?.error ? (
          <div className="alert" role="alert">
            <span>{studio.historyWindow.error.message}</span>
            <ErrorDetails error={studio.historyWindow.error} />
            <button
              type="button"
              className="btn"
              onClick={studio.historyWindow.retry}
            >
              <Icon name="refresh" size={18} />
              Retry
            </button>
          </div>
        ) : null}
        <Carousel
          ref={carousel}
          studio={studio}
          center={center}
          onCentered={onCentered}
        />
      </div>
      <HistoryShortcut target={carousel} show={showShortcut} />
    </div>
  );
}
