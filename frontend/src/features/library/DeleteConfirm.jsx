import React, { useEffect, useRef } from 'react';

import { describeImage, isLocalOnly } from '../../data/records/imageRecord.js';
import { STORAGE_STATE } from '../../data/storage/privateHistory.js';
import { ErrorDetails } from '../../shared/diagnostics/ErrorDetails.jsx';
import { Icon } from '../../shared/ui/ui.jsx';

/**
 * Explicit delete confirmation that names the image. Failure keeps the
 * confirmation open and shows the reason; cancelling changes nothing.
 */
export function DeleteConfirm({
  image,
  busy,
  error,
  diagnostic,
  onConfirm,
  onCancel,
}) {
  const { title } = describeImage(image);
  const local = isLocalOnly(image);
  const cancel = useRef(null);
  useEffect(() => {
    cancel.current?.focus();
  }, []);
  return (
    <div
      className="confirm"
      role="group"
      aria-label={`${local ? 'Remove' : 'Delete'} ${title}`}
    >
      <p className="confirm-text">
        {local ? (
          <>
            Remove <strong>{title}</strong> from this browser? This cannot be
            undone; nothing is deleted on the server.
            {image.local_storage &&
            image.local_storage.state !== STORAGE_STATE.STORED &&
            image.local_storage.held ? (
              <>
                {' '}
                It is not stored in this browser, so the copy held in this tab
                is lost.
              </>
            ) : null}
          </>
        ) : (
          <>
            Delete <strong>{title}</strong>? This cannot be undone.
          </>
        )}
      </p>
      {error ? (
        <p className="error-text" role="alert">
          <ErrorDetails error={error} diagnostic={diagnostic} />
          {error}
        </p>
      ) : null}
      <div className="confirm-actions">
        <button
          type="button"
          className="btn danger"
          disabled={busy}
          onClick={onConfirm}
        >
          <Icon name="trash" size={18} />
          {local ? 'Remove from browser' : 'Delete'}
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
