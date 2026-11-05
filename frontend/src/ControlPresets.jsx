/**
 * Named presets for the Standard controls, behind one menu in their header:
 * apply, save the current values, and manage (rename, replace, remove).
 * Presets live in this browser only. Applying is one undo step that changes
 * Standard values alone; the prompt, references, aspect and generated
 * controls stay as they are.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { ErrorDetails, WarningDetails } from './ErrorDetails.jsx';
import { localDiagnostic } from './diagnostics.js';
import { GROUP } from './controls.js';
import { applyPreset, capturePreset, PRESET_LIMITS } from './controlPresets.js';
import ResultMenu from './ResultMenu.jsx';
import { formatBytes } from './retainedReferences.js';
import { formatMoment, Icon, Modal, Tip } from './ui.jsx';
import { presetRefusal, useControlPresets } from './useControlPresets.js';
import './ControlPresets.css';

const MODE_LABEL = { image: 'Image', 'asset-image': 'Asset image' };
const SKIP_REASON = {
  missing: 'not in these controls',
  kind: 'control type changed',
  choice: 'saved choice is no longer offered',
  'custom-conflict': 'custom choice conflicts with an existing one',
  value: 'saved value is outside the current range',
};
const SUCCESS_MS = 5000;
const lower = (name) => name.trim().toLocaleLowerCase('en-US');
const codePoints = (text) => Array.from(text).length;
const byName = (a, b) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
const controlCount = (n) => `${n} control${n === 1 ? '' : 's'}`;

/** What applying would do now, without changing anything. */
function previewFit(preset, mode, entries, editing = false) {
  try {
    const { applied, skipped, reason } = applyPreset(preset, {
      mode,
      entries,
      editing,
    });
    return { applied, total: preset.controls.length, skipped, reason };
  } catch {
    return {
      applied: 0,
      total: preset.controls.length,
      skipped: [],
      bad: true,
    };
  }
}

function fitHint(fit) {
  if (fit.bad) return 'Cannot be read';
  if (fit.reason === 'mode') return 'For another mode';
  if (!fit.applied) return 'Nothing here matches';
  if (fit.applied < fit.total)
    return `${fit.applied} of ${fit.total} controls apply`;
  return undefined;
}

/** A readable name for a skipped control, from the current list when it is there. */
function skippedLabel(item, entries) {
  const entry = entries.find(
    (e) => e.group === GROUP.base && e.wire.id === item.id,
  );
  if (entry?.wire.label) return entry.wire.label;
  const words = item.id.replace(/[-_]+/g, ' ').trim();
  return words ? words[0].toLocaleUpperCase() + words.slice(1) : item.id;
}

function SkippedList({ skipped, entries }) {
  if (!skipped?.length) return null;
  return (
    <ul className="preset-skipped">
      {skipped.map((item) => (
        <li key={`${item.id}:${item.reason}`}>
          <strong>{skippedLabel(item, entries)}</strong>
          {`: ${SKIP_REASON[item.reason] ?? 'not applied'}`}
        </li>
      ))}
    </ul>
  );
}

/** Confirmation with Cancel focused first; Escape cancels it alone. */
function PresetConfirm({
  label,
  children,
  confirmLabel,
  danger = false,
  busy = false,
  blocked = false,
  error = null,
  onConfirm,
  onCancel,
}) {
  const cancel = useRef(null);
  useEffect(() => {
    cancel.current?.focus();
  }, []);
  return (
    <div
      className="confirm preset-confirm"
      role="group"
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || busy) return;
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }}
    >
      <p className="confirm-text">{children}</p>
      {error ? (
        <p className="error-text" role="alert">
          {error}
          <ErrorDetails error={error} />
        </p>
      ) : null}
      <div className="confirm-actions">
        <button
          type="button"
          className={`btn ${danger ? 'danger' : 'primary'}`}
          disabled={busy || blocked}
          aria-busy={busy || undefined}
          onClick={onConfirm}
        >
          {danger ? <Icon name="trash" size={18} /> : null}
          {confirmLabel}
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

function DialogBar({ title, closeLabel, onClose }) {
  return (
    <div className="dialog-bar">
      <h2 className="preset-dialog-title">{title}</h2>
      <Tip label="Close">
        <button
          type="button"
          className="icon-btn quiet"
          aria-label={closeLabel}
          onClick={onClose}
        >
          <Icon name="close" size={20} />
        </button>
      </Tip>
    </div>
  );
}

/** Name the current values; an existing name is replaced only after asking. */
function SavePresetDialog({
  mode,
  entries,
  editing,
  presets,
  onSaved,
  onClose,
}) {
  const [name, setName] = useState('');
  const [conflict, setConflict] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const field = useRef(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    field.current?.focus();
    return () => {
      live.current = false;
    };
  }, []);

  const captured = useMemo(() => {
    try {
      return capturePreset({ name: 'preset', mode, entries, editing });
    } catch {
      return null;
    }
  }, [mode, entries, editing]);
  const labels = entries
    .filter((e) => e.group === GROUP.base)
    .map((e) => e.wire.label)
    .filter((label) => !captured?.skipped.includes(label));
  const tooLong = codePoints(name.trim()) > PRESET_LIMITS.name;
  // The conflict is the row seen when it was found; a newer revision means
  // another tab changed it, and that replacement is no longer what was asked.
  const current = conflict
    ? presets.items.find((p) => p.id === conflict.id)
    : null;
  const conflictChanged =
    conflict && (!current || current.revision !== conflict.revision);

  const finish = (result, skipped) => {
    if (!live.current) return;
    setBusy(false);
    if (result.persisted) {
      onSaved(result.entry, skipped);
      return;
    }
    setError(presetRefusal(result.reason, { limits: PRESET_LIMITS }));
  };

  const build = () => {
    try {
      return capturePreset({ name: name.trim(), mode, entries, editing });
    } catch {
      setError(presetRefusal('invalid'));
      return null;
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    if (busy || !name.trim() || tooLong) return;
    setError(null);
    const same = presets.items.find(
      (p) => p.mode === mode && lower(p.name) === lower(name),
    );
    if (same) {
      setConflict({ id: same.id, revision: same.revision, name: same.name });
      return;
    }
    const built = build();
    if (!built) return;
    setBusy(true);
    const result = await presets.save(built.preset);
    if (!live.current) return;
    if (!result.persisted && result.reason === 'duplicate-name') {
      // Another tab used the name meanwhile: ask before replacing it.
      setBusy(false);
      const answer = await presets.refresh();
      if (!live.current) return;
      const found = answer?.items.find(
        (p) => p.mode === mode && lower(p.name) === lower(name),
      );
      if (found)
        setConflict({
          id: found.id,
          revision: found.revision,
          name: found.name,
        });
      else setError(presetRefusal('duplicate-name'));
      return;
    }
    finish(result, built.skipped);
  };

  const replace = async () => {
    const built = build();
    if (!built) return;
    setBusy(true);
    setError(null);
    const result = await presets.save(built.preset, conflict);
    if (live.current && result.persisted) setConflict(null);
    finish(result, built.skipped);
  };

  return (
    <Modal label="Save preset" onClose={onClose} className="preset-dialog">
      <DialogBar
        title="Save preset"
        closeLabel="Close save preset"
        onClose={onClose}
      />
      <form className="preset-form" onSubmit={submit} noValidate>
        <label className="field-label" htmlFor="preset-name">
          Preset name
        </label>
        <input
          id="preset-name"
          ref={field}
          className="field"
          type="text"
          autoComplete="off"
          value={name}
          aria-invalid={tooLong || undefined}
          aria-describedby="preset-name-note"
          disabled={busy || Boolean(conflict)}
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
        />
        <p className="preset-note" id="preset-name-note">
          {tooLong
            ? `Use at most ${PRESET_LIMITS.name} characters.`
            : `${MODE_LABEL[mode]} mode: ${labels.join(', ') || 'no controls'}. The prompt, references and generated controls are not saved.`}
        </p>
        {captured?.skipped.length ? (
          <p className="preset-note">
            Not saved: {captured.skipped.join(', ')} (no stable identity).
          </p>
        ) : null}
        {error && !conflict ? (
          <p className="error-text" role="alert">
            {error}
            <ErrorDetails error={error} />
          </p>
        ) : null}
        {conflict ? (
          <PresetConfirm
            label={`Replace ${conflict.name}`}
            confirmLabel="Replace"
            busy={busy}
            blocked={conflictChanged}
            error={
              conflictChanged
                ? 'This preset changed in another tab. Cancel to review it.'
                : error
            }
            onConfirm={replace}
            onCancel={() => {
              setConflict(null);
              setError(null);
              requestAnimationFrame(() => field.current?.focus());
            }}
          >
            A {MODE_LABEL[mode].toLowerCase()} preset named{' '}
            <strong>{conflict.name}</strong> exists. Replace it with the current
            values?
          </PresetConfirm>
        ) : (
          <div className="confirm-actions preset-actions">
            <button
              type="submit"
              className="btn primary"
              disabled={busy || !name.trim() || tooLong || !captured}
              aria-busy={busy || undefined}
            >
              <Icon name="bookmark" size={18} />
              Save
            </button>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
          </div>
        )}
      </form>
    </Modal>
  );
}

function PresetRow({ item, mode, entries, editing, presets, onApply, onGone }) {
  const [action, setAction] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [name, setName] = useState(item.name);
  const menu = useRef(null);
  const field = useRef(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    if (action?.kind === 'rename') field.current?.select();
  }, [action]);

  const here = item.mode === mode;
  const fit = here ? previewFit(item, mode, entries) : null;
  const hasStandard = entries.some((e) => e.group === GROUP.base);
  const changed = action && action.revision !== item.revision;
  const begin = (kind) => {
    setMessage(null);
    setName(item.name);
    setAction({ kind, revision: item.revision });
  };
  const end = () => {
    setAction(null);
    setMessage(null);
    requestAnimationFrame(() => menu.current?.focus());
  };
  const seen = () => ({ id: item.id, revision: action.revision });
  const settle = (result) => {
    if (!live.current) return false;
    setBusy(false);
    if (result.persisted) return true;
    setMessage(presetRefusal(result.reason, { limits: PRESET_LIMITS }));
    return false;
  };

  const rename = async (event) => {
    event.preventDefault();
    const next = name.trim();
    if (!next || codePoints(next) > PRESET_LIMITS.name || busy) return;
    if (next === item.name) {
      end();
      return;
    }
    if (
      presets.items.some(
        (p) =>
          p.id !== item.id &&
          p.mode === item.mode &&
          lower(p.name) === lower(next),
      )
    ) {
      setMessage(presetRefusal('duplicate-name'));
      return;
    }
    setBusy(true);
    setMessage(null);
    const result = await presets.save(
      { name: next, mode: item.mode, controls: item.controls },
      seen(),
    );
    if (settle(result)) end();
  };

  const replace = async () => {
    let built;
    try {
      built = capturePreset({ name: item.name, mode, entries, editing });
    } catch {
      setMessage(presetRefusal('invalid'));
      return;
    }
    setBusy(true);
    setMessage(null);
    const result = await presets.save(built.preset, seen());
    if (settle(result)) end();
  };

  const remove = async () => {
    setBusy(true);
    setMessage(null);
    const result = await presets.remove({
      id: item.id,
      revision: action.revision,
    });
    if (settle(result)) onGone();
  };

  const menuItems = [
    ...(here
      ? [
          {
            id: 'apply',
            label: 'Apply',
            icon: 'check',
            hint: fitHint(fit),
            disabled: !fit.applied,
            onSelect: () => onApply(item),
          },
        ]
      : []),
    {
      id: 'rename',
      label: 'Rename…',
      icon: 'edit',
      onSelect: () => begin('rename'),
    },
    ...(here && hasStandard
      ? [
          {
            id: 'replace',
            label: 'Replace with current values…',
            icon: 'refresh',
            onSelect: () => begin('replace'),
          },
        ]
      : []),
    {
      id: 'remove',
      label: 'Remove…',
      icon: 'trash',
      onSelect: () => begin('remove'),
    },
  ];
  const changedNote = changed
    ? 'This preset changed in another tab. Cancel to review it.'
    : message;

  return (
    <li className="preset-item" data-busy={busy || undefined} data-here={here}>
      <div className="preset-head">
        <span className="preset-title">
          <strong className="preset-name">{item.name}</strong>
          <span className="preset-meta">
            {[
              here ? null : `${MODE_LABEL[item.mode]} mode`,
              controlCount(item.controls.length),
              here && fit.applied < fit.total ? fitHint(fit) : null,
              formatMoment(item.updatedAt),
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </span>
        <ResultMenu
          ref={menu}
          compact
          label={`Actions for preset ${item.name}`}
          triggerIcon={<MoreDots />}
          items={
            action
              ? menuItems.map((entry) => ({ ...entry, disabled: true }))
              : menuItems
          }
        />
      </div>
      {action?.kind === 'rename' ? (
        <form
          className="preset-rename"
          onSubmit={rename}
          noValidate
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || busy) return;
            event.preventDefault();
            event.stopPropagation();
            end();
          }}
        >
          <label className="sr-only" htmlFor={`rename-${item.id}`}>
            New name for {item.name}
          </label>
          <input
            id={`rename-${item.id}`}
            ref={field}
            className="field"
            type="text"
            autoComplete="off"
            value={name}
            disabled={busy}
            aria-invalid={
              codePoints(name.trim()) > PRESET_LIMITS.name || undefined
            }
            onChange={(event) => {
              setName(event.target.value);
              setMessage(null);
            }}
          />
          {changedNote ? (
            <p className="error-text" role="alert">
              {changedNote}
              <WarningDetails warning={changedNote} />
            </p>
          ) : codePoints(name.trim()) > PRESET_LIMITS.name ? (
            <p className="error-text" role="alert">
              Use at most {PRESET_LIMITS.name} characters.
              <ErrorDetails
                diagnostic={localDiagnostic({
                  category: 'validation',
                  reason: 'Preset name exceeds the character limit.',
                  facts: {
                    'Maximum characters': PRESET_LIMITS.name,
                    'Entered characters': codePoints(name.trim()),
                  },
                })}
              />
            </p>
          ) : null}
          <div className="confirm-actions">
            <button
              type="submit"
              className="btn primary"
              disabled={
                busy ||
                changed ||
                !name.trim() ||
                codePoints(name.trim()) > PRESET_LIMITS.name
              }
            >
              Rename
            </button>
            <button type="button" className="btn" disabled={busy} onClick={end}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      {action?.kind === 'replace' ? (
        <PresetConfirm
          label={`Replace ${item.name}`}
          confirmLabel="Replace"
          busy={busy}
          blocked={changed}
          error={changedNote}
          onConfirm={replace}
          onCancel={end}
        >
          Replace <strong>{item.name}</strong> with the current Standard control
          values?
        </PresetConfirm>
      ) : null}
      {action?.kind === 'remove' ? (
        <PresetConfirm
          label={`Remove ${item.name}`}
          confirmLabel="Remove preset"
          danger
          busy={busy}
          blocked={changed}
          error={changedNote}
          onConfirm={remove}
          onCancel={end}
        >
          Remove <strong>{item.name}</strong> from this browser? This cannot be
          undone.
        </PresetConfirm>
      ) : null}
    </li>
  );
}

function MoreDots() {
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

function ManagePresetsDialog({
  mode,
  entries,
  editing,
  presets,
  onApply,
  onClose,
}) {
  const list = useRef(null);
  const items = [...presets.items].sort(
    (a, b) => (b.mode === mode) - (a.mode === mode) || byName(a, b),
  );
  const { usage } = presets;
  return (
    <Modal label="Presets" onClose={onClose} className="preset-dialog">
      <DialogBar title="Presets" closeLabel="Close presets" onClose={onClose} />
      <div className="preset-body" ref={list} tabIndex={-1}>
        {usage ? (
          <p className="preset-note">
            {`${usage.count} of ${usage.maxCount} presets · ${formatBytes(usage.bytes)} of ${formatBytes(usage.maxBytes)}`}
          </p>
        ) : null}
        {presets.status === 'error' ? (
          <div className="notice" data-tone="error" role="alert">
            <span>{presets.error}</span>
            <ErrorDetails error={presets.error} />
            <button type="button" className="btn" onClick={presets.refresh}>
              Retry
            </button>
          </div>
        ) : null}
        {presets.status === 'loading' ? (
          <p className="preset-note" role="status">
            Reading presets…
          </p>
        ) : null}
        {presets.status === 'ready' && !items.length ? (
          <p className="preset-note">No presets saved.</p>
        ) : null}
        {items.length ? (
          <ul className="preset-list" aria-label="Saved presets">
            {items.map((item) => (
              <PresetRow
                key={item.id}
                item={item}
                mode={mode}
                entries={entries}
                editing={editing}
                presets={presets}
                onApply={onApply}
                onGone={() => list.current?.focus()}
              />
            ))}
          </ul>
        ) : null}
      </div>
    </Modal>
  );
}

/** The outcome of the last preset action, until dismissed or replaced. */
function PresetStatus({ status, entries, onDismiss }) {
  if (!status) return null;
  return (
    <div
      className="preset-status"
      data-tone={status.tone}
      role={status.tone === 'error' ? 'alert' : 'status'}
    >
      <div className="preset-status-text">
        <span>{status.text}</span>
        {status.tone === 'error' ? (
          <ErrorDetails
            diagnostic={localDiagnostic({
              category: 'validation',
              reason: status.text,
              data: status.skipped,
            })}
          />
        ) : status.tone === 'partial' ? (
          <WarningDetails
            diagnostic={localDiagnostic({
              category: 'validation',
              reason: status.text,
              data: status.skipped,
            })}
          />
        ) : null}
        <SkippedList skipped={status.skipped} entries={entries} />
      </div>
      <button
        type="button"
        className="icon-btn quiet"
        aria-label="Dismiss preset message"
        onClick={onDismiss}
      >
        <Icon name="close" size={18} />
      </button>
    </div>
  );
}

/**
 * The Standard controls header's preset menu, its dialogs and its result
 * message. `children` are the header's other end actions (Reset), kept in
 * one group with the menu. `studio.controlPresets` supplies the browser store.
 */
export default function ControlPresets({
  studio,
  lead = null,
  children = null,
}) {
  const { draft, entries, applyControlEntries } = studio;
  const { mode } = draft;
  const editing = Boolean(studio.editing);
  const presets = useControlPresets(
    studio.controlPresets ?? { store: null, ready: true },
  );
  const [dialog, setDialog] = useState(null);
  const [status, setStatus] = useState(null);
  const trigger = useRef(null);
  const hasStandard = entries.some((e) => e.group === GROUP.base);

  // A full success fades on its own; anything partial or refused stays.
  useEffect(() => {
    if (status?.tone !== 'success') return undefined;
    const timer = setTimeout(() => setStatus(null), SUCCESS_MS);
    return () => clearTimeout(timer);
  }, [status]);

  const close = () => {
    setDialog(null);
    requestAnimationFrame(() => {
      // A second action can open a dialog before this frame runs. Its field
      // owns focus now; closing the earlier dialog must not steal it back.
      if (!document.querySelector('[aria-modal="true"]'))
        trigger.current?.focus();
    });
  };

  const apply = (preset) => {
    let outcome = null;
    applyControlEntries('Apply preset', (current) => {
      try {
        outcome = applyPreset(preset, { mode, entries: current, editing });
      } catch {
        outcome = null;
        return current;
      }
      return outcome.applied ? outcome.entries : current;
    });
    if (!outcome) {
      setStatus({ tone: 'error', text: `${preset.name} could not be read.` });
      return;
    }
    if (outcome.reason === 'mode') {
      setStatus({
        tone: 'error',
        text: `${preset.name} is for ${MODE_LABEL[preset.mode].toLowerCase()} mode.`,
      });
      return;
    }
    const total = outcome.applied + outcome.skipped.length;
    if (!outcome.applied) {
      setStatus({
        tone: 'error',
        text: `Nothing in ${preset.name} matches these controls.`,
        skipped: outcome.skipped,
      });
      return;
    }
    setStatus(
      outcome.skipped.length
        ? {
            tone: 'partial',
            text: `Applied ${preset.name} to ${outcome.applied} of ${total} controls.`,
            skipped: outcome.skipped,
          }
        : { tone: 'success', text: `Applied ${preset.name}.` },
    );
  };

  const forMode = presets.items.filter((p) => p.mode === mode).sort(byName);
  const elsewhere = presets.items.length - forMode.length;
  const items = [];
  if (presets.status === 'loading' && presets.durable)
    items.push({
      id: 'loading',
      label: 'Reading presets…',
      disabled: true,
      onSelect: () => {},
    });
  if (presets.status === 'error')
    items.push({
      id: 'error',
      label: 'Saved presets could not be read',
      disabled: true,
      onSelect: () => {},
    });
  for (const preset of forMode) {
    const fit = previewFit(preset, mode, entries, editing);
    items.push({
      id: `apply:${preset.id}`,
      label: `Apply ${preset.name}`,
      icon: 'check',
      hint: fitHint(fit),
      disabled: !fit.applied,
      onSelect: () => apply(preset),
    });
  }
  if (!forMode.length && elsewhere)
    items.push({
      id: 'elsewhere',
      label: `No ${MODE_LABEL[mode].toLowerCase()} presets`,
      hint: `${elsewhere} for ${MODE_LABEL[mode === 'image' ? 'asset-image' : 'image'].toLowerCase()} mode`,
      disabled: true,
      onSelect: () => {},
    });
  items.push({
    id: 'save',
    label: 'Save as preset…',
    icon: 'bookmark',
    hint: !presets.durable
      ? presets.status === 'loading'
        ? 'Opening browser storage…'
        : 'Browser storage unavailable'
      : !hasStandard
        ? 'No controls loaded'
        : presets.status === 'error'
          ? 'Saved presets could not be read'
          : undefined,
    disabled: !presets.durable || !hasStandard || presets.status === 'error',
    onSelect: () => {
      setStatus(null);
      setDialog('save');
    },
  });
  if (presets.durable && (presets.items.length || presets.status === 'error'))
    items.push({
      id: 'manage',
      label: 'Manage presets…',
      icon: 'gear',
      hint: presets.usage
        ? `${presets.usage.count} of ${presets.usage.maxCount}`
        : undefined,
      onSelect: () => {
        presets.refresh();
        setDialog('manage');
      },
    });

  return (
    <>
      <span className="head-actions">
        {lead}
        <Tip label="Presets">
          <ResultMenu
            ref={trigger}
            compact
            label="Presets"
            triggerIcon={<Icon name="bookmark" />}
            items={items}
          />
        </Tip>
        {children}
      </span>
      <PresetStatus
        status={status}
        entries={entries}
        onDismiss={() => {
          setStatus(null);
          trigger.current?.focus();
        }}
      />
      {dialog === 'save'
        ? createPortal(
            <SavePresetDialog
              mode={mode}
              entries={entries}
              editing={editing}
              presets={presets}
              onClose={close}
              onSaved={(entry, skipped) => {
                close();
                setStatus(
                  skipped.length
                    ? {
                        tone: 'partial',
                        text: `Saved ${entry.name} without ${skipped.join(', ')}.`,
                      }
                    : { tone: 'success', text: `Saved ${entry.name}.` },
                );
              }}
            />,
            document.body,
          )
        : null}
      {dialog === 'manage'
        ? createPortal(
            <ManagePresetsDialog
              mode={mode}
              entries={entries}
              editing={editing}
              presets={presets}
              onApply={(preset) => {
                close();
                apply(preset);
              }}
              onClose={close}
            />,
            document.body,
          )
        : null}
    </>
  );
}
