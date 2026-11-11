import {
  ErrorDetails,
  WarningDetails,
} from '../../shared/diagnostics/ErrorDetails.jsx';
import {
  preserveError,
  localDiagnostic,
} from '../../shared/diagnostics/diagnostics.js';
import React, { useMemo, useRef, useState } from 'react';

import {
  hasPlacement,
  normalizeText,
  placementOf,
} from './watermarkGeometry.js';
import { inspectSvg } from './watermarkSvg.js';
import { Icon, Modal, Segmented, Tip } from '../../shared/ui/ui.jsx';
import { SavedImg } from '../../data/media/SavedImg.jsx';

/** Images shown in the preview grid. */
const PREVIEW_IMAGE_COUNT = 4;
const BYTES_PER_KIB = 1024;

const TYPE_OPTIONS = [
  { value: 'text', label: 'Text' },
  { value: 'svg', label: 'SVG' },
];

/** The editable form of saved settings. */
const draftFrom = (settings) => ({
  type: settings.type,
  text: settings.text ?? '',
  svgMarkup: settings.svg_markup ?? '',
  recolor: settings.svg_recolor !== false,
});

const sameDraft = (a, b) =>
  a.type === b.type &&
  a.text === b.text &&
  a.svgMarkup === b.svgMarkup &&
  a.recolor === b.recolor;

/** Content check for the active mode: `{ok, body}` or `{ok: false, error}`. */
function checkDraft(draft, limits) {
  if (draft.type === 'text') {
    const text = normalizeText(draft.text, limits);
    return text.ok
      ? { ok: true, body: { type: 'text', text: text.text } }
      : text;
  }
  const svg = inspectSvg(draft.svgMarkup, limits);
  return svg.ok
    ? {
        ok: true,
        body: {
          type: 'svg',
          svg_markup: draft.svgMarkup,
          svg_recolor: draft.recolor,
        },
      }
    : svg;
}

/** Preview images: analyzed ones first, so previews use their real placement. */
const previewImages = (images) =>
  [
    ...images.filter(hasPlacement),
    ...images.filter((image) => !hasPlacement(image)),
  ].slice(0, PREVIEW_IMAGE_COUNT);

/**
 * Editor for the watermark content of THIS browser. Edits live only in this
 * dialog and its local preview; nothing is kept until Save, and Cancel (or
 * closing) leaves the stored choice as it was. Reset removes the stored choice
 * so the server defaults apply. Neither reaches the server's shared settings.
 * @param {object} props
 * @param {object} props.settings effective settings with `limits` and `rendering`
 * @param {object[]} props.images library records for the preview
 * @param {(body: object) => Promise<{persisted?: boolean}|unknown>} props.onSave
 *   rejects with the server's reason
 * @param {() => Promise<unknown>} [props.onReset] removes the stored choice
 * @param {boolean} [props.custom] whether a stored choice exists
 * @param {() => void} props.onClose
 */
export default function WatermarkSettings({
  settings,
  images,
  onSave,
  onReset = null,
  custom = false,
  onClose,
}) {
  const saved = useMemo(() => draftFrom(settings), [settings]);
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [fileError, setFileError] = useState(null);
  const [pageOnly, setPageOnly] = useState(false);
  const fileInput = useRef(null);
  const { limits, rendering } = settings;
  const dirty = !sameDraft(draft, saved);
  const checked = useMemo(() => checkDraft(draft, limits), [draft, limits]);
  const previewSettings = useMemo(
    () =>
      checked.ok
        ? {
            type: checked.body.type,
            text: checked.body.text,
            svg_markup: checked.body.svg_markup,
            svg_recolor: checked.body.svg_recolor,
            limits,
            rendering,
          }
        : null,
    [checked, limits, rendering],
  );
  const defaultPlacement = useMemo(
    () => placementOf(null, rendering),
    [rendering],
  );
  const samples = useMemo(() => previewImages(images), [images]);
  const watermark = useMemo(
    () => ({ settings: previewSettings, placement: defaultPlacement }),
    [previewSettings, defaultPlacement],
  );
  const edit = (patch) => {
    setDraft((current) => ({ ...current, ...patch }));
    setSaveError(null);
    setFileError(null);
  };

  const save = async () => {
    if (!checked.ok || saving) return;
    setSaving(true);
    setSaveError(null);
    let outcome;
    try {
      outcome = await onSave(checked.body);
    } catch (error) {
      setSaveError(preserveError(error));
      setSaving(false);
      return;
    }
    // Content the browser would not keep still applies to this page.
    if (outcome?.persisted === false) {
      setPageOnly(true);
      setSaving(false);
      return;
    }
    onClose();
  };

  const reset = async () => {
    if (!onReset || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onReset();
    } catch (error) {
      setSaveError(preserveError(error));
      setSaving(false);
      return;
    }
    onClose();
  };

  const readFile = async (event) => {
    const [file] = event.target.files;
    event.target.value = '';
    if (!file) return;
    if (file.size > limits.max_svg_bytes) {
      setFileError(`${file.name} is over ${limits.max_svg_bytes} bytes.`);
      return;
    }
    try {
      edit({ svgMarkup: await file.text() });
    } catch {
      setFileError(`${file.name} could not be read.`);
    }
  };

  const message =
    saveError?.message ?? fileError ?? (checked.ok ? null : checked.error);
  const svgLimit = `${Math.round(limits.max_svg_bytes / BYTES_PER_KIB)} KiB`;

  return (
    <Modal
      label="Watermark"
      onClose={onClose}
      locked={saving}
      pressClosesBackdrop={!dirty}
      className="wm-dialog"
    >
      <div className="wm-editor">
        <form
          className="wm-form"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <div className="wm-form-head">
            <h2>Watermark</h2>
            <span className="wm-scope">This browser only</span>
            <Tip label="Close">
              <button
                type="button"
                className="icon-btn round"
                aria-label="Close watermark settings"
                disabled={saving}
                onClick={onClose}
              >
                <Icon name="close" />
              </button>
            </Tip>
          </div>
          <Segmented
            legend="Content type"
            name="watermark-type"
            value={draft.type}
            options={TYPE_OPTIONS}
            onChange={(type) => edit({ type })}
            disabled={saving}
          />
          {draft.type === 'text' ? (
            <label className="wm-field">
              <span className="field-label">Text</span>
              <textarea
                className="field wm-text"
                rows={4}
                spellCheck={false}
                value={draft.text}
                aria-describedby="wm-hint"
                aria-invalid={!checked.ok}
                disabled={saving}
                onChange={(event) => edit({ text: event.target.value })}
              />
              <span id="wm-hint" className="wm-hint">
                Up to {limits.max_lines} lines, {limits.max_line_length}{' '}
                characters each
              </span>
            </label>
          ) : (
            <div className="wm-field">
              <label className="wm-field">
                <span className="field-label">SVG markup</span>
                <textarea
                  className="field wm-text"
                  rows={6}
                  spellCheck={false}
                  value={draft.svgMarkup}
                  aria-describedby="wm-hint"
                  aria-invalid={!checked.ok}
                  disabled={saving}
                  onChange={(event) => edit({ svgMarkup: event.target.value })}
                />
              </label>
              <span id="wm-hint" className="wm-hint">
                Up to {svgLimit}. Scripts and external resources are not
                allowed.
              </span>
              <div className="wm-svg-tools">
                <input
                  ref={fileInput}
                  className="sr-only"
                  type="file"
                  accept=".svg,image/svg+xml"
                  tabIndex={-1}
                  aria-hidden="true"
                  onChange={readFile}
                />
                <button
                  type="button"
                  className="btn"
                  disabled={saving}
                  onClick={() => fileInput.current?.click()}
                >
                  <Icon name="upload" size={18} />
                  Choose SVG file
                </button>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={draft.recolor}
                    disabled={saving}
                    onChange={(event) =>
                      edit({ recolor: event.target.checked })
                    }
                  />
                  <span className="check-label">Recolor artwork</span>
                </label>
              </div>
            </div>
          )}
          <p className="wm-message" role="status" aria-live="polite">
            {message ? (
              <ErrorDetails
                error={saveError ?? message}
                diagnostic={
                  saveError?.diagnostic ??
                  localDiagnostic({
                    category: fileError ? 'file' : 'validation',
                    reason: message,
                  })
                }
              />
            ) : pageOnly ? (
              <WarningDetails warning="Applied to this page only. The browser would not store it." />
            ) : null}
            {message ??
              (pageOnly
                ? 'Applied to this page only. The browser would not store it.'
                : null)}
          </p>
          <div className="wm-form-actions">
            <button
              type="submit"
              className="btn primary"
              disabled={!checked.ok || saving}
              aria-busy={saving}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={saving}
              onClick={onClose}
            >
              {pageOnly ? 'Close' : 'Cancel'}
            </button>
            {onReset ? (
              <button
                type="button"
                className="btn"
                disabled={saving || !custom}
                onClick={reset}
              >
                <Icon name="undo" size={18} />
                Reset to default
              </button>
            ) : null}
          </div>
        </form>
        <div className="wm-previews" aria-label="Preview">
          {samples.length ? (
            <ul className="wm-preview-grid">
              {samples.map((image) => (
                <li key={image.id ?? `${image.storage_id}/${image.filename}`}>
                  <span className="wm-preview-media">
                    <SavedImg image={image} watermark={watermark} />
                  </span>
                  {hasPlacement(image) ? null : (
                    <span className="wm-preview-note">
                      Not analyzed · default placement
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">No saved images to preview.</p>
          )}
        </div>
      </div>
    </Modal>
  );
}
