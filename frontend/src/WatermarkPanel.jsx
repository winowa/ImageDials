import { preserveError } from './diagnostics.js';
import { ErrorDetails, WarningDetails } from './ErrorDetails.jsx';

import React, { useEffect, useRef, useState } from 'react';

import { describeImage, isBakedWatermark, isLocalOnly } from './imageRecord.js';
import { readOriginalBytes } from './originalBytes.js';
import { printBlob, saveBlob } from './printing.js';
import { Disclosure, Icon } from './ui.jsx';

const ACTION = { analyze: 'analyze', download: 'download', print: 'print' };

const BUSY_LABEL = {
  [ACTION.analyze]: 'Analyzing…',
  [ACTION.download]: 'Preparing download…',
  [ACTION.print]: 'Preparing print…',
};

const aborted = (error) => error?.name === 'AbortError';

/** `title.png` → `title-watermarked.png`. */
export const watermarkedFileName = (originalName) =>
  originalName.replace(/(\.png)?$/i, '-watermarked.png');

/** What the panel says about the prepared file. */
function preparedLabel(image, local, keptHere) {
  const kept = local ? image.local_watermark?.prepared : keptHere;
  if (kept === 'stored') return 'Saved in this browser';
  if (kept === 'memory') return 'Kept until the tab closes';
  return 'None';
}

const cornerLabel = (corner) => corner.replace('-', ' ');

/**
 * Per-image watermark actions under the image: the visibility choice, the real
 * analysis and prepared-file status, and the watermarked download and browser
 * print. Analysis and the prepared file are separate facts and shown so.
 * @param {object} props
 * @param {object} props.image library record
 * @param {object} props.watermark the shared watermark state (`useWatermark`)
 * @param {boolean} props.show
 * @param {(show: boolean) => void} props.onShow
 * @param {boolean} props.canDownload
 * @param {boolean} props.canPrint
 * @param {string} props.originalName file name of the original download
 * @param {{download: Function, busy: boolean}|null} [props.original] the
 *   original-file download (`useOriginalDownload`)
 * @param {object} [props.sources] where original bytes are read from
 */
export default function WatermarkPanel({
  image,
  watermark,
  show,
  onShow,
  canDownload,
  canPrint,
  originalName,
  original = null,
  sources = {},
}) {
  const [action, setAction] = useState(null);
  const [keptHere, setKeptHere] = useState(null);
  const [failure, setFailure] = useState(null);
  const [note, setNote] = useState(null);
  const run = useRef({ controller: null });
  const alive = useRef(true);
  const view = describeImage(image);
  const baked = isBakedWatermark(image);
  const canPrepare =
    !baked &&
    (isLocalOnly(image) ? watermark.localAvailable : watermark.preparable);
  const ready = Boolean(watermark.settings);
  // With the watermark on, the primary download is the prepared copy.
  const preparedPrimary = show && canPrepare;
  const corner = image.print_watermark?.position?.corner;
  const analyzed = Boolean(image.print_watermark_key);
  const local = isLocalOnly(image);

  // What a shared image already has stored here (one small read per image).
  useEffect(() => {
    if (local || !watermark.inspect) return undefined;
    let current = true;
    watermark.inspect(image).then(
      (found) => current && setKeptHere(found?.prepared ?? null),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [image, local, watermark]);

  useEffect(() => {
    alive.current = true;
    const current = run.current;
    return () => {
      alive.current = false;
      current.controller?.abort();
    };
  }, []);

  /** One action at a time; leaving the dialog cancels it and drops its result. */
  const perform = async (name, work) => {
    if (run.current.controller) return;
    const controller = new AbortController();
    run.current.controller = controller;
    // The busy button is disabled, which drops focus; give it back afterwards.
    const opener = document.activeElement;
    setAction(name);
    setFailure(null);
    setNote(null);
    try {
      const outcome = await work(controller.signal);
      const state = outcome?.persistence?.state;
      if (alive.current && state)
        setKeptHere(state === 'not-stored' ? null : state);
      // A prepared file the browser could not keep was still made and used.
      if (alive.current && outcome?.persistence?.state === 'not-stored')
        setNote(`Not saved in this browser. ${outcome.persistence.message}`);
    } catch (error) {
      if (!aborted(error) && alive.current) setFailure(preserveError(error));
    } finally {
      run.current.controller = null;
      if (alive.current) {
        setAction(null);
        requestAnimationFrame(() => {
          if (alive.current && opener?.isConnected)
            opener.focus({ preventScroll: true });
        });
      }
    }
  };

  const analyze = () =>
    perform(ACTION.analyze, (signal) =>
      watermark.analyze(image, { force: analyzed, signal }),
    );

  const download = () =>
    perform(ACTION.download, async (signal) => {
      // The prepared copy only: a failed prepare never falls back to the original.
      const prepared = await watermark.prepare(image, { signal });
      saveBlob(prepared.blob, watermarkedFileName(originalName));
      return prepared;
    });

  const downloadOriginal = () => original?.download();

  const print = () =>
    perform(ACTION.print, async (signal) => {
      if (baked) {
        // A baked copy already carries its mark; print its own pixels.
        const blob = await readOriginalBytes(image, { signal, ...sources });
        await printBlob(blob, { size: view.size });
        return null;
      }
      const prepared = await watermark.prepare(image, { signal });
      // The prepared image's own size decides the orientation.
      await printBlob(prepared.blob, { size: prepared.size ?? view.size });
      return prepared;
    });

  const busy = action !== null;
  return (
    <div className="wm-panel" role="group" aria-label="Watermark">
      <label className="check-row">
        <input
          type="checkbox"
          checked={show}
          disabled={baked}
          onChange={(event) => onShow(event.target.checked)}
        />
        <span className="check-label">Watermark</span>
      </label>
      {baked ? (
        <p className="wm-progress">
          The watermark is part of this image’s pixels. This switch cannot
          remove it.
        </p>
      ) : null}
      <dl className="wm-status">
        <dt>Analysis</dt>
        <dd>
          {analyzed && corner
            ? `Corner ${cornerLabel(corner)}`
            : 'Not analyzed'}
        </dd>
        <dt>Prepared file</dt>
        <dd>{baked ? 'Not needed' : preparedLabel(image, local, keptHere)}</dd>
      </dl>
      {image.print_watermark?.provenance?.regeneration ? (
        <Disclosure title="Regeneration details">
          <p>{image.print_watermark.provenance.regeneration.placement}</p>
          <p>{image.print_watermark.provenance.regeneration.colors}</p>
        </Disclosure>
      ) : null}
      <div className="wm-actions">
        <button
          type="button"
          className="btn"
          disabled={busy || !ready || baked}
          aria-busy={action === ACTION.analyze}
          onClick={analyze}
        >
          <Icon name="scan" size={18} />
          {analyzed ? 'Regenerate' : 'Analyze'}
        </button>
        {canDownload && preparedPrimary ? (
          <button
            type="button"
            className="btn primary"
            aria-label="Download watermarked"
            disabled={busy || !ready}
            aria-busy={action === ACTION.download}
            onClick={download}
          >
            <Icon name="download" size={18} />
            Download
          </button>
        ) : null}
        {canDownload && original ? (
          <button
            type="button"
            className={preparedPrimary ? 'btn' : 'btn primary'}
            aria-label="Download original"
            aria-busy={original.busy}
            disabled={original.busy}
            onClick={downloadOriginal}
          >
            <Icon name="download" size={18} />
            {preparedPrimary ? 'Download original' : 'Download'}
          </button>
        ) : null}
        {canPrint && (baked || canPrepare) ? (
          <button
            type="button"
            className="btn"
            disabled={busy || !ready}
            aria-busy={action === ACTION.print}
            onClick={print}
          >
            <Icon name="print" size={18} />
            Print
          </button>
        ) : null}
      </div>
      {busy ? (
        <p className="wm-progress" role="status">
          {BUSY_LABEL[action]}
        </p>
      ) : null}
      {original?.error ? (
        <p className="error-text" role="alert">
          <ErrorDetails error={original.error} />
          The original could not be downloaded. {original.error.message}
        </p>
      ) : null}
      {note ? (
        <p className="wm-progress" role="status">
          <WarningDetails warning={note} />
          {note}
        </p>
      ) : null}
      {failure ? (
        <div className="alert" role="alert">
          <span>
            <ErrorDetails error={failure} />
            {failure.message}
          </span>
        </div>
      ) : null}
    </div>
  );
}
