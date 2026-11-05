import { ErrorDetails } from './ErrorDetails.jsx';
import React, {
  memo,
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useState,
} from 'react';

import {
  CUSTOM_OPTION_MAX_CHARS,
  describeControl,
  GROUP,
  isChoiceKind,
  isKnownKind,
  isMultiChoice,
  KIND,
  optionEntries,
  selectedOptionKeys,
  sliderBounds,
} from './controls.js';
import ResultMenu from './ResultMenu.jsx';
import { unknownOrigin } from './standardSettlement.js';
import { Icon, Tip } from './ui.jsx';
import './ControlApplication.css';

/** Time a removed control animates out before it leaves the list. */
export const CONTROL_EXIT_MS = 200;

const prefersReducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? true;

function ChipChoices({ wire, labelId, onToggle, children }) {
  const name = useId();
  const multi = isMultiChoice(wire.kind);
  const selected = selectedOptionKeys(wire);
  return (
    <div
      className="chips"
      role={multi ? 'group' : 'radiogroup'}
      aria-labelledby={labelId}
    >
      {optionEntries(wire).map((option) => {
        const checked = selected.includes(option.key);
        return (
          <label key={option.key} className="chip" data-checked={checked}>
            <input
              className="chip-input"
              type={multi ? 'checkbox' : 'radio'}
              name={name}
              checked={checked}
              onChange={() => onToggle(option.key)}
              // A checked radio fires no change event, so a click on it deselects.
              onClick={() => !multi && checked && onToggle(option.key)}
            />
            <span className="chip-mark" aria-hidden="true">
              {multi ? <Icon name="check" size={14} /> : null}
            </span>
            <span>{option.label}</span>
            {option.description ? (
              <span className="sr-only">{`: ${option.description}`}</span>
            ) : null}
          </label>
        );
      })}
      {children}
    </div>
  );
}

function ChoiceList({ wire, labelId, onToggle, onSelect, children }) {
  const name = useId();
  const multi = isMultiChoice(wire.kind);
  const selected = selectedOptionKeys(wire);
  return (
    <div
      className="choices"
      role={multi ? 'group' : 'radiogroup'}
      aria-labelledby={labelId}
    >
      {optionEntries(wire).map((option) => (
        <label key={option.key} className="choice">
          <input
            type={multi ? 'checkbox' : 'radio'}
            name={name}
            checked={selected.includes(option.key)}
            onChange={() =>
              multi ? onToggle(option.key) : onSelect(option.key)
            }
          />
          <span>
            {option.label}
            {option.description ? (
              <span className="choice-desc">{option.description}</span>
            ) : null}
          </span>
        </label>
      ))}
      {children}
    </div>
  );
}

function Dropdown({ wire, labelId, onSelect, children }) {
  return (
    <div className="dropdown-row">
      <select
        className="field"
        aria-labelledby={labelId}
        value={typeof wire.value === 'string' ? wire.value : ''}
        onChange={(event) => onSelect(event.target.value || null)}
      >
        <option value="">Not set</option>
        {optionEntries(wire).map((option) => (
          <option key={option.key} value={option.key}>
            {option.label}
          </option>
        ))}
      </select>
      {children}
    </div>
  );
}

function Slider({ wire, labelId, onChange }) {
  const { min, max, step } = sliderBounds(wire);
  const id = useId();
  const valid =
    [min, max, step].every(Number.isFinite) && max > min && step > 0;
  const intervals = valid ? (max - min) / step : Infinity;
  const positions = Math.floor(intervals + 1e-9) + 1;
  const ticks =
    positions > 0 && positions <= 11
      ? Array.from({ length: positions }, (_, i) =>
          Math.min(max, min + i * step),
        )
      : [];
  const value = Number.isFinite(wire.value) ? wire.value : min;
  const unit =
    typeof wire.unit === 'string'
      ? wire.unit
      : typeof wire.units === 'string'
        ? wire.units
        : '';
  const endpoints = [wire.minLabel, wire.maxLabel].some(Boolean);
  return (
    <div className="slider-control">
      <input
        className="slider"
        type="range"
        aria-labelledby={labelId}
        aria-valuetext={`${value}${unit ? ` ${unit}` : ''}, range ${min} to ${max}${wire.minLabel ? `, ${min}: ${wire.minLabel}` : ''}${wire.maxLabel ? `, ${max}: ${wire.maxLabel}` : ''}`}
        min={min}
        max={max}
        step={step}
        value={value}
        list={ticks.length ? id : undefined}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {ticks.length ? (
        <datalist id={id}>
          {ticks.map((tick) => (
            <option key={tick} value={tick} />
          ))}
        </datalist>
      ) : null}
      {endpoints ? (
        <div className="slider-endpoints">
          <span>{wire.minLabel}</span>
          <span>{wire.maxLabel}</span>
        </div>
      ) : null}
      <output className="control-value">{describeControl(wire)}</output>
    </div>
  );
}

function TextInput({ wire, labelId, onChange }) {
  return (
    <input
      type="text"
      className="field"
      aria-labelledby={labelId}
      value={typeof wire.value === 'string' ? wire.value : ''}
      placeholder={wire.placeholder || undefined}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function Switch({ wire, labelId, onChange }) {
  const on = wire.value === true;
  return (
    <div className="switch-row">
      <button
        type="button"
        role="switch"
        className="switch"
        aria-checked={on}
        aria-labelledby={labelId}
        onClick={() => onChange(!on)}
      >
        <span className="switch-thumb" />
      </button>
      <span className="switch-text" aria-live="polite">
        {on ? (wire.trueLabel ?? 'Yes') : (wire.falseLabel ?? 'No')}
      </span>
    </div>
  );
}

function ExpansionStatus({ expansion }) {
  if (expansion?.status === 'error')
    return (
      <p className="control-status error-text" role="alert">
        More options failed: {expansion.error.message}
        <ErrorDetails error={expansion.error} />
      </p>
    );
  if (expansion?.status === 'empty')
    return (
      <p className="control-status" role="status">
        No new options were returned.
      </p>
    );
  return null;
}

/** One trailing menu; opening it never requests suggestions. */
function OptionTail({ wire, entryKey, editors }) {
  const expansion = editors.expansions?.[entryKey];
  const [custom, setCustom] = useState(false);
  const menu = useRef(null);
  return (
    <>
      <div className="option-tail">
        <ResultMenu
          ref={menu}
          label={`More ${wire.label} choices`}
          hoverFocus
          triggerClassName="pill-btn dashed"
          items={[
            {
              id: 'custom',
              label: `Add custom ${wire.label} option`,
              onSelect: () => setCustom(true),
            },
            ...(editors.expand
              ? [
                  {
                    id: 'suggest',
                    label: `More ${wire.label} options`,
                    busy: expansion?.status === 'loading',
                    onSelect: () => editors.expand(entryKey),
                  },
                ]
              : []),
          ]}
        />
        {custom ? (
          <AddCustom
            label={wire.label}
            onAdd={(text) => editors.addCustomOption(entryKey, text)}
            onClose={() => {
              setCustom(false);
              menu.current?.focus();
            }}
          />
        ) : null}
      </div>
      {expansion?.status === 'loading' ? (
        <p className="control-status" role="status">
          Adding options…
        </p>
      ) : null}
      {editors.expand ? <ExpansionStatus expansion={expansion} /> : null}
    </>
  );
}

function Unsupported({ wire }) {
  return (
    <p className="control-unsupported">
      Unsupported control type <code>{wire.kind}</code>. It is kept and sent
      unchanged.
    </p>
  );
}

/**
 * The Custom option button, which becomes its own text entry in the same place
 * in the options flow. Enter adds, Escape or Cancel closes; either returns
 * focus to the button. Shared by every choice kind.
 */
function AddCustom({ label, onAdd, onClose }) {
  const [text, setText] = useState('');
  const field = useRef(null);
  useEffect(() => {
    field.current?.focus();
  }, []);
  const close = onClose;
  const submit = (event) => {
    event.preventDefault();
    if (!text.trim()) return;
    onAdd(text);
    close();
  };
  return (
    <form
      className="add-custom"
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          close();
        }
      }}
    >
      <input
        ref={field}
        type="text"
        className="field"
        value={text}
        maxLength={CUSTOM_OPTION_MAX_CHARS}
        aria-label={`Custom ${label} option`}
        onChange={(event) => setText(event.target.value)}
      />
      <button
        type="submit"
        className="icon-btn"
        aria-label={`Add ${label} option`}
        disabled={!text.trim()}
      >
        <Icon name="plus" />
      </button>
      <button
        type="button"
        className="icon-btn quiet"
        aria-label="Cancel custom option"
        onClick={close}
      >
        <Icon name="close" />
      </button>
    </form>
  );
}

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * One on/off pattern for every mode: whether a control is applied to a text
 * or asset request, or to an edit. The wire flags stay distinct; only the
 * control is shared. A narrow card shows the check alone (the name and tip
 * still say what it does).
 */
function ApplyToggle({ pressed, name, tip, onToggle }) {
  return (
    <Tip label={tip}>
      <button
        type="button"
        className="control-apply"
        aria-pressed={pressed}
        aria-label={name}
        onClick={onToggle}
      >
        <span className="control-apply-mark" aria-hidden="true">
          <Icon name="check" size={14} />
        </span>
        <span className="control-apply-text" aria-hidden="true">
          Apply
        </span>
      </button>
    </Tip>
  );
}

/**
 * One control. `editors` is the studio's edit surface; `onRemove` is given only
 * for controls a person may dismiss.
 */
function controlPropsEqual(previous, next) {
  const previousEditors = previous.editors;
  const nextEditors = next.editors;
  const key = next.entry.key;
  return (
    previous.entry === next.entry &&
    previous.onRemove === next.onRemove &&
    previous.index === next.index &&
    previous.leaving === next.leaving &&
    previous.expanded === next.expanded &&
    previous.onExpandedChange === next.onExpandedChange &&
    previousEditors.setValue === nextEditors.setValue &&
    previousEditors.toggleOption === nextEditors.toggleOption &&
    previousEditors.addCustomOption === nextEditors.addCustomOption &&
    previousEditors.reset === nextEditors.reset &&
    previousEditors.setApplyToEdit === nextEditors.setApplyToEdit &&
    previousEditors.appliesToEdit === nextEditors.appliesToEdit &&
    previousEditors.editing === nextEditors.editing &&
    previousEditors.setEnabled === nextEditors.setEnabled &&
    previousEditors.textToggle === nextEditors.textToggle &&
    previousEditors.expansions?.[key] === nextEditors.expansions?.[key] &&
    previousEditors.expand === nextEditors.expand
  );
}

export const Control = memo(function Control({
  entry,
  editors,
  onRemove,
  index = 0,
  leaving,
  expanded: controlledExpanded,
  onExpandedChange,
}) {
  const labelId = useId();
  const summaryId = useId();
  const { wire, key } = entry;
  const { kind } = wire;
  const bodyId = useId();
  const bodyRef = useRef(null);
  const headerRef = useRef(null);
  const [localExpanded, setLocalExpanded] = useState(
    entry.group !== GROUP.base,
  );
  const expanded = controlledExpanded ?? localExpanded;
  useLayoutEffect(() => {
    if (!expanded && bodyRef.current?.contains(document.activeElement))
      headerRef.current?.focus();
  }, [expanded]);
  const expand = () => {
    if (expanded && bodyRef.current?.contains(document.activeElement))
      headerRef.current?.focus();
    if (onExpandedChange) onExpandedChange(entry, !expanded);
    else setLocalExpanded(!expanded);
  };
  const actual =
    describeControl(wire) ??
    (wire.value == null ||
    wire.value === '' ||
    (Array.isArray(wire.value) && !wire.value.length)
      ? 'Not set'
      : JSON.stringify(wire.value));
  const changed = !sameValue(wire.value, entry.initial);
  const choice = isChoiceKind(kind);
  const select = (value) => editors.setValue(key, value);
  const toggle = (option) => editors.toggleOption(key, option);
  // In an edit a control either changes the image or keeps the source.
  const editing = Boolean(editors.editing && editors.appliesToEdit);
  const applied = editing ? editors.appliesToEdit(entry) : null;
  // A text request may leave a Standard control to the model; its value stays.
  const off = !editors.editing && entry.enabled === false;
  const toggleable =
    !editors.editing &&
    Boolean(editors.setEnabled) &&
    ((editors.textToggle && entry.group === GROUP.base) || off);

  const valueSummary = editing
    ? `${applied ? 'Applied' : 'Kept from the source'} · ${actual}`
    : off
      ? 'Model decides'
      : entry.pending
        ? 'Choosing…'
        : actual;
  const summary = `${valueSummary}${unknownOrigin(entry) ? ' · From the saved image' : ''}`;
  const tail = choice ? (
    <OptionTail wire={wire} entryKey={key} editors={editors} />
  ) : null;
  let body;
  if (kind === KIND.single || kind === KIND.multi)
    body = (
      <ChipChoices wire={wire} labelId={labelId} onToggle={toggle}>
        {tail}
      </ChipChoices>
    );
  else if (kind === KIND.radio || kind === KIND.checkbox)
    body = (
      <ChoiceList
        wire={wire}
        labelId={labelId}
        onToggle={toggle}
        onSelect={select}
      >
        {tail}
      </ChoiceList>
    );
  else if (kind === KIND.dropdown)
    body = (
      <Dropdown wire={wire} labelId={labelId} onSelect={select}>
        {tail}
      </Dropdown>
    );
  else if (kind === KIND.slider)
    body = <Slider wire={wire} labelId={labelId} onChange={select} />;
  else if (kind === KIND.text)
    body = <TextInput wire={wire} labelId={labelId} onChange={select} />;
  else if (kind === KIND.binary)
    body = <Switch wire={wire} labelId={labelId} onChange={select} />;
  else body = <Unsupported wire={wire} />;

  return (
    <div
      className="control"
      data-kind={isKnownKind(kind) ? kind : 'unknown'}
      data-leaving={leaving || undefined}
      data-edit={editing ? (applied ? 'applied' : 'kept') : undefined}
      data-enabled={off ? 'false' : undefined}
      style={{ '--i': index }}
    >
      <div className="control-inner">
        <div className="control-head">
          <div className="control-title">
            <h3 className="category-title" aria-label={wire.label}>
              <button
                ref={headerRef}
                type="button"
                className="category-toggle"
                aria-expanded={expanded}
                aria-controls={bodyId}
                aria-describedby={summaryId}
                onClick={expand}
                aria-label={`${expanded ? 'Collapse' : 'Expand'} ${wire.label}`}
              >
                <span className="category-chevron" aria-hidden="true">
                  <Icon name="chevron" size={18} />
                </span>
                <span className="category-heading">
                  <span id={labelId} className="control-label">
                    {wire.label}
                  </span>
                  <span id={summaryId} className="category-summary">
                    {summary}
                  </span>
                </span>
              </button>
            </h3>
          </div>
          <span className="control-actions">
            {editing ? (
              <ApplyToggle
                pressed={Boolean(applied)}
                name={`Apply ${wire.label} to edit`}
                tip={
                  applied
                    ? 'Included in the edit instruction. Turn off to omit this adjustment.'
                    : 'Omitted from the edit instruction. Turn on to apply this adjustment.'
                }
                onToggle={() => editors.setApplyToEdit(key, !applied)}
              />
            ) : toggleable ? (
              <ApplyToggle
                pressed={!off}
                name={`Apply ${wire.label}`}
                tip={
                  off
                    ? 'The model decides. Turn on to use this value.'
                    : 'Sent with this value. Turn off to let the model decide.'
                }
                onToggle={() => editors.setEnabled(key, off)}
              />
            ) : null}
            {changed ? (
              <button
                type="button"
                className="icon-btn quiet"
                aria-label={`Reset ${wire.label}`}
                onClick={() => editors.reset(key)}
              >
                <Icon name="undo" size={18} />
              </button>
            ) : null}
            {onRemove ? (
              <button
                type="button"
                className="icon-btn quiet"
                aria-label={`Remove ${wire.label}`}
                onClick={() => onRemove(key)}
              >
                <Icon name="close" size={18} />
              </button>
            ) : null}
          </span>
        </div>
        <div
          ref={bodyRef}
          id={bodyId}
          className="category-body"
          data-collapsed={!expanded || undefined}
          inert={!expanded}
          aria-hidden={!expanded || undefined}
        >
          <div className="category-inner">
            <div className="control-body">
              <p className="category-full-value">{summary}</p>
              {wire.description ? (
                <p className="control-desc">{wire.description}</p>
              ) : null}
              {body}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}, controlPropsEqual);

/** A list of controls; removable ones animate out before they are removed. */
export function ControlList({
  entries,
  editors,
  removable = false,
  disclosure,
}) {
  const [leaving, setLeaving] = useState(() => new Set());
  const timers = useRef(new Set());
  const removeEditor = editors.remove;
  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  const remove = React.useCallback(
    (key) => {
      if (prefersReducedMotion()) {
        removeEditor(key);
        return;
      }
      setLeaving((prev) => new Set(prev).add(key));
      const timer = setTimeout(() => {
        timers.current.delete(timer);
        removeEditor(key);
        setLeaving((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }, CONTROL_EXIT_MS);
      timers.current.add(timer);
    },
    [removeEditor],
  );

  return entries.map((entry, index) => (
    <Control
      key={entry.key}
      entry={entry}
      editors={editors}
      index={Math.min(index, 8)}
      leaving={leaving.has(entry.key)}
      expanded={disclosure?.isExpanded(entry)}
      onExpandedChange={disclosure?.setExpanded}
      onRemove={removable ? remove : undefined}
    />
  ));
}
