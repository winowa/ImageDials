import { ErrorDetails } from './ErrorDetails.jsx';

import React, { useEffect, useRef, useState } from 'react';

import { describeImage, isBakedWatermark, isLocalOnly } from './imageRecord.js';
import { saveBlob } from './printing.js';
import { Icon } from './ui.jsx';
import { watermarkedFileName } from './WatermarkPanel.jsx';

/**
 * The download actions of the current result. With the watermark on, the
 * primary Download is the separately prepared PNG (made from this browser's
 * watermark content); the original stays one explicit, labelled action. A
 * failed prepare is reported and never falls back to the original.
 */
export default function ResultDownload({ image, watermark, name }) {
  const [state, setState] = useState({ busy: false, error: null });
  const controller = useRef(null);
  useEffect(() => () => controller.current?.abort(), []);
  const view = describeImage(image);
  const prepared =
    watermark.visible &&
    Boolean(watermark.settings) &&
    !isBakedWatermark(image) &&
    (isLocalOnly(image) ? watermark.localAvailable : watermark.preparable);
  const original = (
    <a className="btn" href={view.originalUrl} download={name}>
      <Icon name="download" size={18} />
      {prepared ? 'Download original' : 'Download'}
    </a>
  );
  if (!prepared) return original;

  const download = async () => {
    if (controller.current) return;
    const mine = new AbortController();
    controller.current = mine;
    setState({ busy: true, error: null });
    try {
      const result = await watermark.prepare(image, { signal: mine.signal });
      saveBlob(result.blob, watermarkedFileName(name));
      setState({ busy: false, error: null });
    } catch (error) {
      if (error?.name !== 'AbortError') setState({ busy: false, error });
    } finally {
      if (controller.current === mine) controller.current = null;
    }
  };

  return (
    <>
      <button
        type="button"
        className="btn primary"
        aria-label="Download watermarked"
        aria-busy={state.busy}
        disabled={state.busy}
        onClick={download}
      >
        <Icon name="download" size={18} />
        Download
      </button>
      {original}
      {state.error ? (
        <span className="error-text" role="alert">
          <ErrorDetails error={state.error} />
          {state.error.message}
        </span>
      ) : null}
    </>
  );
}
