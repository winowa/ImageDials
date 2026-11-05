import React, { useRef, useState } from 'react';

import { ErrorDetails, WarningDetails } from './ErrorDetails.jsx';
import { IMPORT_PHASE } from './importFlow.js';
import { Icon, InfoPopover } from './ui.jsx';

const hasFiles = (event) =>
  Array.from(event.dataTransfer?.types ?? []).includes('Files');

/**
 * Drop handling for the element it is spread onto. The handler receives the
 * first file and every dropped file. The chooser buttons are the keyboard and
 * touch alternative.
 * @param {(file: File, files: File[]) => void} onFile first file, then all dropped
 */
export function useDropTarget(onFile) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  return {
    dragging,
    props: {
      onDragEnter: (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        depth.current += 1;
        setDragging(true);
      },
      onDragOver: (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      },
      onDragLeave: (event) => {
        if (!hasFiles(event)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setDragging(false);
      },
      onDrop: (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        depth.current = 0;
        setDragging(false);
        const files = Array.from(event.dataTransfer.files ?? []);
        if (files.length) onFile(files[0], files);
      },
    },
  };
}

/** Chooser button plus the local preview and status of the latest import. */
export function ImportPanel({ studio, renderAction }) {
  const input = useRef(null);
  const { importState: state } = studio;
  const types = studio.discovery.capabilities.data?.uploads?.image_mime_types;
  const busy = state.phase === IMPORT_PHASE.analyzing;
  const message =
    state.message === 'Generating image…'
      ? studio.job?.phase === 'complete'
        ? 'Image generated.'
        : studio.job?.phase === 'failed'
          ? 'Image generation failed.'
          : studio.job?.phase === 'lost'
            ? 'Check generation status.'
            : state.message
      : state.message;
  const accept =
    Array.isArray(types) && types.length ? types.join(',') : 'image/*';

  const choose = (event) => {
    const [file] = event.target.files;
    event.target.value = '';
    if (file) studio.importImage(file);
  };
  const action = (
    <button
      type="button"
      className="pill-btn load-image"
      aria-busy={busy}
      onClick={() => input.current?.click()}
    >
      <Icon name="upload" size={18} />
      Load image
    </button>
  );

  return (
    <div className="import" aria-label="Image inputs" role="group">
      <input
        ref={input}
        className="sr-only"
        type="file"
        accept={accept}
        tabIndex={-1}
        aria-hidden="true"
        onChange={choose}
      />
      {renderAction ? renderAction(action) : action}
      {state.phase !== IMPORT_PHASE.idle || state.previewUrl ? (
        <div className="import-status" data-phase={state.phase}>
          {state.previewUrl ? (
            <img
              className="import-thumb"
              src={state.previewUrl}
              alt="Imported image preview"
            />
          ) : null}
          <div className="import-text">
            {busy ? (
              <p role={state.progress ? undefined : 'status'}>
                Reading {state.fileName}
                {state.choosingControls ? ' and choosing controls' : ''}…
              </p>
            ) : state.error ? (
              <div className="import-error" role="alert">
                <p className="error-text">
                  <ErrorDetails error={state.error} />
                  {state.error.message}
                </p>
                <button
                  type="button"
                  className="link-btn"
                  onClick={studio.retryImport}
                >
                  Retry import
                </button>
              </div>
            ) : state.message ? (
              <p role="status">{message}</p>
            ) : null}
            {state.controlsWarning ? (
              <div role="status">
                <WarningDetails warning={state.controlsWarning} />
                <span>{state.controlsWarning.message}</span>
                <button
                  type="button"
                  className="link-btn"
                  onClick={studio.retryImportControls}
                  disabled={busy}
                >
                  Retry image controls
                </button>
              </div>
            ) : null}
            {state.metadataNotice ? (
              <p role="status">
                <WarningDetails warning={state.metadataNotice} />
                {state.metadataNotice}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            className="icon-btn quiet"
            aria-label={busy ? 'Cancel import' : 'Dismiss import'}
            onClick={studio.dismissImport}
          >
            <Icon name="close" size={18} />
          </button>
          {state.description ? (
            <section
              className="import-description"
              aria-label="Image description"
            >
              <div className="import-description-head">
                <strong>Image description</strong>
                <InfoPopover label="About this description">
                  <p>
                    {state.descriptionStatus?.message ||
                      'A visual description of the imported image. It stays available even when saved settings or an embedded prompt were restored.'}
                  </p>
                  {state.descriptionStatus?.provider ? (
                    <p>
                      {state.descriptionStatus.provider}
                      {state.descriptionStatus.model
                        ? ` · ${state.descriptionStatus.model}`
                        : ''}
                    </p>
                  ) : null}
                </InfoPopover>
              </div>
              <p>{state.description}</p>
              <button
                type="button"
                className="btn"
                onClick={() => studio.useImportDescription(state.description)}
              >
                Use as prompt
              </button>
              {['unavailable', 'error'].includes(
                state.descriptionStatus?.status,
              ) ? (
                <span>
                  <WarningDetails warning={state.descriptionStatus} />
                  <button
                    type="button"
                    className="link-btn"
                    onClick={studio.retryImportDescription}
                    disabled={busy}
                  >
                    Retry description
                  </button>
                </span>
              ) : null}
            </section>
          ) : state.descriptionStatus?.status === 'unavailable' ||
            state.descriptionStatus?.status === 'error' ? (
            <div className="import-description" role="status">
              <span>
                <WarningDetails warning={state.descriptionStatus} />
                {state.descriptionStatus.message || 'Description unavailable.'}
              </span>
              <button
                type="button"
                className="link-btn"
                onClick={studio.retryImportDescription}
                disabled={busy}
              >
                Retry description
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
