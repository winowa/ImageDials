import React from 'react';

import {
  ErrorDetails,
  WarningDetails,
} from '../../shared/diagnostics/ErrorDetails.jsx';
import { Icon } from '../../shared/ui/ui.jsx';

/**
 * Loading, error and empty states shared by the screens that browse saved
 * images. Once images are displayed, a failed refresh never replaces them: it
 * is reported beside them with a retry.
 */
export default function LibraryGate({ images, reload, children }) {
  const hasImages = images.items.length > 0;
  // `keepContent`: the screen reports its own empty/loading state, so controls
  // in use (a search field being typed in) are never unmounted.
  const showChildren = hasImages || images.keepContent === true;
  if (images.status === 'loading' && !showChildren)
    return (
      <p className="empty" role="status">
        Loading saved images…
      </p>
    );
  if (images.status === 'error' && !showChildren)
    return (
      <div className="empty">
        <p className="error-text" role="alert">
          <ErrorDetails error={images.errorDetail ?? images.error} />
          {images.error}
        </p>
        <button type="button" className="btn" onClick={reload}>
          <Icon name="refresh" size={18} />
          Retry
        </button>
      </div>
    );
  const cacheWarning = images.cacheWarning ? (
    <div className="alert" role="status">
      <span>
        <WarningDetails
          warning={images.cacheWarningDetail ?? images.cacheWarning}
        />
        {images.cacheWarning}
      </span>
    </div>
  ) : null;
  if (!showChildren)
    return (
      <>
        {cacheWarning}
        <p className="empty" role="status">
          No saved images yet.
        </p>
      </>
    );
  return (
    <>
      {cacheWarning}
      {images.status === 'error' ? (
        <div className="alert" role="alert">
          <span>
            <WarningDetails warning={images.errorDetail ?? images.error} />
            {images.error}
            {hasImages ? ' The images shown may be out of date.' : ''}
          </span>
          <button type="button" className="btn" onClick={reload}>
            <Icon name="refresh" size={18} />
            Retry
          </button>
        </div>
      ) : null}
      {children}
    </>
  );
}
