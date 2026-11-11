import React, { useEffect, useId, useMemo, useRef, useState } from 'react';

import {
  isCustom,
  KIND,
  overridesFromValues,
  PROVIDER_GROUPS,
  usesServerKey,
  validateValues,
  valuesFor,
} from '../../data/api/providerSettings.js';
import KeptReferencesDialog from '../references/KeptReferences.jsx';
import { limitText, usageText } from '../references/retainedReferences.js';
import { Icon, Modal, Tip } from '../../shared/ui/ui.jsx';
import './SettingsPanel.css';
import {
  ErrorDetails,
  WarningDetails,
} from '../../shared/diagnostics/ErrorDetails.jsx';
import { localDiagnostic } from '../../shared/diagnostics/diagnostics.js';
import {
  readPreference,
  writePreference,
} from '../../shared/browser/preferences.js';
import {
  LIBRARY_PAGE_SIZES,
  LIBRARY_DEFAULT_PAGE_SIZE,
} from '../../data/records/browse.js';
import WatermarkSettings from '../watermarks/WatermarkSettings.jsx';

const sameOverrides = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** What the key field means right now, including where the server key applies. */
function keyStatus({ name, value, values, defaults }) {
  if (value.trim()) return 'Custom key, kept in this browser.';
  if (usesServerKey(name, values, defaults)) return 'Server key in use.';
  if (!defaults?.keys_configured?.[name]) return 'No server key is set.';
  return 'No key is sent to this endpoint.';
}

function Field({ field, group, state }) {
  const { values, errors, defaults, revealed, onChange, onReset, onReveal } =
    state;
  const id = useId();
  const noteId = `${id}-note`;
  const value = values[field.name];
  const isKey = field.kind === KIND.key;
  const custom = isCustom(field.name, value, defaults);
  const error = errors[field.name];
  const shown = revealed.has(field.name);
  const resetLabel = `Reset ${group.title} ${field.label.toLowerCase()} to default`;
  return (
    <div className="settings-field" data-custom={custom}>
      <label className="field-label" htmlFor={id}>
        {field.label}
        <span className="settings-badge">{custom ? 'Custom' : 'Default'}</span>
      </label>
      <div className="settings-input">
        <input
          id={id}
          className="field"
          name={field.name}
          type={isKey && !shown ? 'password' : 'text'}
          value={value}
          autoComplete={isKey ? 'new-password' : 'off'}
          autoCapitalize="off"
          spellCheck={false}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={error || isKey ? noteId : undefined}
          onChange={(event) => onChange(field.name, event.target.value)}
        />
        {isKey ? (
          <Tip label={shown ? 'Hide key' : 'Show key'}>
            <button
              type="button"
              className="icon-btn quiet"
              aria-label={`${shown ? 'Hide' : 'Show'} ${group.title} key`}
              aria-pressed={shown}
              onClick={() => onReveal(field.name)}
            >
              <Icon name={shown ? 'eye-off' : 'eye'} size={20} />
            </button>
          </Tip>
        ) : null}
        <Tip label="Reset to default">
          <button
            type="button"
            className="icon-btn quiet settings-reset"
            aria-label={resetLabel}
            disabled={!custom}
            onClick={() => onReset(field.name)}
          >
            <Icon name="undo" size={20} />
          </button>
        </Tip>
      </div>
      {error || isKey ? (
        <p
          id={noteId}
          className={error ? 'error-text settings-note' : 'settings-note'}
          role={error ? 'alert' : undefined}
        >
          {error ?? keyStatus({ name: field.name, value, values, defaults })}
          {error ? (
            <ErrorDetails
              diagnostic={localDiagnostic({
                category: 'provider-validation',
                reason: error,
                facts: { field: field.label, provider: group.title },
              })}
            />
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

function ImageFacts({ defaults }) {
  const providers = defaults?.providers;
  if (!providers) return null;
  return (
    <dl className="settings-facts">
      <div>
        <dt>Protocol</dt>
        <dd>{providers.IMAGE_PROVIDER || 'unknown'}</dd>
      </div>
      <div>
        <dt>Model</dt>
        <dd>{providers.IMAGE_MODEL_NAME || 'unknown'}</dd>
      </div>
    </dl>
  );
}

/**
 * Browser-private provider settings. Edits stay in a draft until Save; Cancel,
 * Escape and the close button discard them. Fields start at the server's
 * defaults and each can be reset on its own.
 */
export default function SettingsPanel({
  settings,
  watermark = null,
  retained = null,
  urls = null,
  images = [],
  onClose,
}) {
  const { overrides, defaults, loadDefaults, save, storageAvailable } =
    settings;
  const titleId = useId();
  const [tab, setTab] = useState('language');
  const tabRefs = useRef({});
  const formRef = useRef(null);
  const tabs = [
    ['language', 'Language'],
    ['image', 'Generation'],
    ['editing', 'Editing'],
    ['description', 'Description'],
    ['browsing', 'Browsing'],
    ...(watermark ? [['watermark', 'Watermark']] : []),
    ...(retained?.ready ? [['kept', 'Files']] : []),
  ];
  const panelProps = (id) => ({
    role: 'tabpanel',
    id: `${titleId}-panel-${id}`,
    'aria-labelledby': `${titleId}-tab-${id}`,
    hidden: tab !== id,
    inert: tab !== id ? true : undefined,
  });
  const [initialBrowsing] = useState(() => ({
    showTour: readPreference('show-tour', false, (value) => value === true),
    playing: readPreference('gallery-playing', null, (value) =>
      typeof value === 'boolean' ? value : null,
    ),
    pageSize: readPreference(
      'library-page-size',
      LIBRARY_DEFAULT_PAGE_SIZE,
      (value) =>
        LIBRARY_PAGE_SIZES.includes(value) ? value : LIBRARY_DEFAULT_PAGE_SIZE,
    ),
  }));
  const [browsing, setBrowsing] = useState(initialBrowsing);
  const [values, setValues] = useState(null);
  const [revealed, setRevealed] = useState(() => new Set());
  const [result, setResult] = useState(null);
  const loaded = useRef(false);
  const [editingMark, setEditingMark] = useState(false);
  const editor = useRef(null);
  const [managingKept, setManagingKept] = useState(false);
  const keptButton = useRef(null);

  useEffect(() => {
    loadDefaults();
  }, [loadDefaults]);

  // The draft starts from the freshly read defaults, once per opening.
  useEffect(() => {
    if (defaults.status !== 'ready' || loaded.current) return;
    loaded.current = true;
    setValues(valuesFor(overrides, defaults.data));
  }, [defaults, overrides]);

  const errors = useMemo(
    () => (values ? validateValues(values, defaults.data) : {}),
    [values, defaults.data],
  );
  const pending = useMemo(
    () => (values ? overridesFromValues(values, defaults.data) : overrides),
    [values, defaults.data, overrides],
  );
  const dirty =
    Boolean(values) &&
    (!sameOverrides(pending, overrides) ||
      !sameOverrides(browsing, initialBrowsing));
  const blocked = !values || !dirty;

  const state = {
    values: values ?? {},
    errors,
    defaults: defaults.data,
    revealed,
    onChange: (name, value) => {
      setResult(null);
      setValues((prev) => ({ ...prev, [name]: value }));
    },
    onReset: (name) => {
      const fresh = valuesFor({}, defaults.data);
      setValues((prev) => ({ ...prev, [name]: fresh[name] }));
    },
    onReveal: (name) =>
      setRevealed((prev) => {
        const next = new Set(prev);
        if (!next.delete(name)) next.add(name);
        return next;
      }),
  };

  const commit = () => {
    if (blocked) return;
    const invalid = Object.keys(errors)[0];
    if (invalid) {
      const group = PROVIDER_GROUPS.find((item) =>
        item.fields.some((field) => field.name === invalid),
      );
      setTab(group.id);
      requestAnimationFrame(() =>
        formRef.current?.elements.namedItem(invalid)?.focus(),
      );
      return;
    }
    const outcome = save(pending);
    let browsingPersisted = true;
    if (browsing.showTour !== initialBrowsing.showTour)
      browsingPersisted =
        writePreference('show-tour', browsing.showTour) && browsingPersisted;
    if (browsing.playing !== initialBrowsing.playing)
      browsingPersisted =
        writePreference('gallery-playing', browsing.playing) &&
        browsingPersisted;
    if (browsing.pageSize !== initialBrowsing.pageSize)
      browsingPersisted =
        writePreference('library-page-size', browsing.pageSize) &&
        browsingPersisted;
    if (outcome.persisted && browsingPersisted) onClose();
    else setResult('unsaved');
  };

  const unavailable = !storageAvailable || result === 'unsaved';

  return (
    <>
      <Modal
        label="Settings"
        locked={editingMark || managingKept}
        onClose={onClose}
        pressClosesBackdrop
        className="settings-dialog"
      >
        <div
          className="dialog-bar settings-bar"
          inert={editingMark || managingKept ? true : undefined}
        >
          <h2 id={titleId} className="settings-title">
            Settings
          </h2>
          <Tip label="Close">
            <button
              type="button"
              className="icon-btn quiet"
              aria-label="Close settings"
              onClick={onClose}
            >
              <Icon name="close" size={20} />
            </button>
          </Tip>
        </div>
        <form
          ref={formRef}
          inert={editingMark || managingKept ? true : undefined}
          className="settings-body"
          aria-labelledby={titleId}
          onSubmit={(event) => {
            event.preventDefault();
            commit();
          }}
        >
          <div
            className="settings-tabs"
            role="tablist"
            aria-label="Settings sections"
          >
            {tabs.map(([id, label], index) => (
              <button
                key={id}
                type="button"
                role="tab"
                id={`${titleId}-tab-${id}`}
                aria-controls={`${titleId}-panel-${id}`}
                aria-selected={tab === id}
                tabIndex={tab === id ? 0 : -1}
                ref={(node) => {
                  tabRefs.current[id] = node;
                }}
                onClick={() => setTab(id)}
                onKeyDown={(event) => {
                  let next;
                  if (event.key === 'ArrowRight')
                    next = (index + 1) % tabs.length;
                  if (event.key === 'ArrowLeft')
                    next = (index - 1 + tabs.length) % tabs.length;
                  if (event.key === 'Home') next = 0;
                  if (event.key === 'End') next = tabs.length - 1;
                  if (next === undefined) return;
                  event.preventDefault();
                  setTab(tabs[next][0]);
                  tabRefs.current[tabs[next][0]]?.focus();
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="settings-content">
            {defaults.status === 'error' && !values ? (
              <div className="notice" data-tone="error" role="alert">
                <span>
                  Server defaults could not be read: {defaults.error?.message}
                  <ErrorDetails error={defaults.error} />
                </span>
                <button type="button" className="btn" onClick={loadDefaults}>
                  Retry
                </button>
              </div>
            ) : null}
            {!values && defaults.status !== 'error' ? (
              <p className="settings-note" role="status">
                Reading defaults…
              </p>
            ) : null}
            {values
              ? PROVIDER_GROUPS.map((group) => (
                  <section key={group.id} {...panelProps(group.id)}>
                    <fieldset className="settings-group">
                      <legend>{group.title}</legend>
                      {group.id === 'editing' ? (
                        defaults.data?.editing ? (
                          <label className="settings-route">
                            Editing provider
                            <select
                              className="field"
                              aria-label="Editing provider"
                              value={values.IMAGE_EDIT_ROUTE}
                              onChange={(event) =>
                                state.onChange(
                                  'IMAGE_EDIT_ROUTE',
                                  event.target.value,
                                )
                              }
                            >
                              <option value="generation">
                                Same as generation model
                              </option>
                              <option value="separate">
                                Separate editing endpoint
                              </option>
                            </select>
                            {values.IMAGE_EDIT_ROUTE === 'separate' ? (
                              <span className="settings-note">
                                Uses the server’s editing model and workflow.
                              </span>
                            ) : null}
                          </label>
                        ) : (
                          <p className="settings-note">
                            This server does not support a separate editing
                            provider.
                          </p>
                        )
                      ) : null}
                      {group.fields
                        .filter(
                          () =>
                            group.id !== 'editing' ||
                            (defaults.data?.editing &&
                              values.IMAGE_EDIT_ROUTE === 'separate'),
                        )
                        .map((field) => (
                          <Field
                            key={field.name}
                            field={field}
                            group={group}
                            state={state}
                          />
                        ))}
                      {group.id === 'image' ? (
                        <ImageFacts defaults={defaults.data} />
                      ) : null}
                    </fieldset>
                  </section>
                ))
              : null}
            <section {...panelProps('browsing')}>
              <div className="settings-browsing">
                <fieldset className="settings-group">
                  <legend>Help</legend>
                  <label className="settings-checkbox">
                    <input
                      type="checkbox"
                      checked={browsing.showTour}
                      onChange={(event) =>
                        setBrowsing((prev) => ({
                          ...prev,
                          showTour: event.target.checked,
                        }))
                      }
                    />
                    Show tour button
                  </label>
                </fieldset>
                <fieldset className="settings-group">
                  <legend>Gallery</legend>
                  <label>
                    Automatic playback
                    <select
                      className="field"
                      value={
                        browsing.playing === null
                          ? 'system'
                          : String(browsing.playing)
                      }
                      onChange={(event) =>
                        setBrowsing((prev) => ({
                          ...prev,
                          playing:
                            event.target.value === 'system'
                              ? null
                              : event.target.value === 'true',
                        }))
                      }
                    >
                      <option value="system">
                        Follow reduced motion preference
                      </option>
                      <option value="true">Play on open</option>
                      <option value="false">Pause on open</option>
                    </select>
                  </label>
                </fieldset>
                <fieldset className="settings-group">
                  <legend>Library</legend>
                  <label>
                    Images per page
                    <select
                      className="field"
                      value={browsing.pageSize}
                      onChange={(event) =>
                        setBrowsing((prev) => ({
                          ...prev,
                          pageSize: Number(event.target.value),
                        }))
                      }
                    >
                      {LIBRARY_PAGE_SIZES.map((count) => (
                        <option key={count} value={count}>
                          {count}
                        </option>
                      ))}
                    </select>
                  </label>
                </fieldset>
              </div>
            </section>
            {watermark ? (
              <section {...panelProps('watermark')}>
                <fieldset className="settings-group" data-section="watermark">
                  <legend>Watermark</legend>
                  <div
                    className="settings-field"
                    data-custom={watermark.local.custom}
                  >
                    <span className="field-label">
                      Content
                      <span className="settings-badge">
                        {watermark.local.custom ? 'Custom' : 'Default'}
                      </span>
                    </span>
                    <div className="settings-input">
                      <Tip label="Edit watermark">
                        <button
                          ref={editor}
                          type="button"
                          className="btn"
                          disabled={!watermark.settings}
                          onClick={() => setEditingMark(true)}
                        >
                          <Icon name="stamp" size={18} />
                          Edit watermark
                        </button>
                      </Tip>
                    </div>
                    <p className="settings-note">
                      {watermark.local.invalid
                        ? `Stored content no longer validates: ${watermark.local.invalid}`
                        : watermark.settings
                          ? watermark.settings.type === 'svg'
                            ? 'SVG artwork'
                            : `“${(watermark.settings.text ?? '').split('\n').join(' / ')}”`
                          : 'Reading defaults…'}
                      {watermark.local.invalid ? (
                        <WarningDetails
                          diagnostic={localDiagnostic({
                            category: 'watermark-validation',
                            reason: watermark.local.invalid,
                          })}
                        />
                      ) : null}
                    </p>
                  </div>
                </fieldset>
              </section>
            ) : null}
            {retained?.ready ? (
              <section {...panelProps('kept')}>
                <fieldset className="settings-group" data-section="kept">
                  <legend>Kept references</legend>
                  <div className="settings-field">
                    <span className="field-label">Stored in this browser</span>
                    {retained.status === 'error' ? (
                      <div className="settings-input">
                        <p className="error-text settings-note" role="alert">
                          {retained.error}
                          <ErrorDetails error={retained.error} />
                        </p>
                        <button
                          type="button"
                          className="btn"
                          onClick={retained.refresh}
                        >
                          Retry
                        </button>
                      </div>
                    ) : retained.available ? (
                      <div className="settings-input">
                        <p className="settings-note" data-field="kept-usage">
                          {retained.usage
                            ? retained.items.length
                              ? usageText(retained.usage)
                              : `None kept · ${limitText(retained.usage)}`
                            : 'Reading kept files…'}
                        </p>
                        <button
                          ref={keptButton}
                          type="button"
                          className="btn"
                          aria-haspopup="dialog"
                          disabled={!retained.items.length}
                          onClick={() => setManagingKept(true)}
                        >
                          <Icon name="history" size={18} />
                          Manage
                        </button>
                      </div>
                    ) : (
                      <p className="settings-note">
                        This browser is not storing files here.
                      </p>
                    )}
                  </div>
                </fieldset>
              </section>
            ) : null}
            {unavailable ? (
              <div className="notice" data-tone="info" role="status">
                <span>
                  {result === 'unsaved'
                    ? 'Applied to this page only. The browser would not store it.'
                    : 'This browser blocks storage. Changes last until the page reloads.'}
                  <WarningDetails
                    diagnostic={localDiagnostic({
                      category: 'browser-storage',
                      reason: 'Browser preferences could not be persisted.',
                    })}
                  />
                </span>
              </div>
            ) : null}
          </div>
          <div className="settings-actions">
            <button type="button" className="btn" onClick={onClose}>
              {result === 'unsaved' ? 'Close' : 'Cancel'}
            </button>
            <button type="submit" className="btn primary" disabled={blocked}>
              Save
            </button>
          </div>
        </form>
      </Modal>
      {managingKept && retained ? (
        <KeptReferencesDialog
          retained={retained}
          urls={urls}
          onClose={() => {
            setManagingKept(false);
            // Manage is disabled once nothing is kept: focus the dialog then.
            requestAnimationFrame(() => {
              const button = keptButton.current;
              (button && !button.disabled
                ? button
                : button?.closest('[role="dialog"]')
              )?.focus();
            });
          }}
        />
      ) : null}
      {editingMark && watermark?.settings ? (
        <WatermarkSettings
          settings={watermark.settings}
          images={images}
          onSave={watermark.saveSettings}
          onReset={watermark.resetSettings}
          custom={watermark.local.custom}
          onClose={() => {
            setEditingMark(false);
            requestAnimationFrame(() => editor.current?.focus());
          }}
        />
      ) : null}
    </>
  );
}
