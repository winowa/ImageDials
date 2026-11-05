import { WarningDetails } from './ErrorDetails.jsx';
import React, { useState } from 'react';

import { identityOf } from './useImageAnnotations.js';
import ResultMenu from './ResultMenu.jsx';

/** Menu items to merge into an existing result More menu. */
export function imageAnnotationMenuItems({ image, annotations, onResult }) {
  const identity = identityOf(image);
  if (!identity) return [];
  const entry = annotations.entryFor(image);
  const available = annotations.durable && annotations.status === 'ready';
  const unavailableHint = !annotations.durable
    ? 'Browser storage is unavailable'
    : annotations.status === 'loading'
      ? 'Loading saved marks'
      : annotations.status === 'error'
        ? 'Saved marks could not be read'
        : undefined;
  const change = async (operation) => {
    const result = await operation();
    onResult?.(
      result?.persisted
        ? 'Saved in this browser.'
        : (annotations.refusal(result?.reason) ??
            'The change could not be saved.'),
    );
    return result;
  };
  const items = [
    {
      id: 'favorite',
      icon: entry.favorite ? 'check' : 'bookmark',
      label: entry.favorite ? 'Remove from favorites' : 'Add to favorites',
      disabled: !available,
      hint: unavailableHint,
      onSelect: () =>
        change(() => annotations.setFavorite(identity, !entry.favorite)),
    },
  ];
  if (annotations.collections.length) {
    items.push({
      id: 'collections-heading',
      label: 'Collections',
      disabled: true,
    });
    items.push(
      ...annotations.collections.map((collection) => {
        const included = entry.collectionIds.includes(collection.id);
        return {
          id: `collection:${collection.id}`,
          icon: included ? 'check' : 'plus',
          label: included
            ? `Remove from ${collection.name}`
            : `Add to ${collection.name}`,
          disabled: !available,
          hint: unavailableHint,
          onSelect: () =>
            change(() =>
              annotations.setMembership(identity, collection.id, !included),
            ),
        };
      }),
    );
  } else {
    items.push({
      id: 'no-collections',
      label: 'Create a collection in Library Filters',
      disabled: true,
    });
  }
  return items;
}

/** Reusable contextual actions for a saved image; no permanent card buttons. */
export function ImageAnnotationActions({
  image,
  annotations,
  compact = false,
}) {
  const [notice, setNotice] = useState('');
  const items = imageAnnotationMenuItems({
    image,
    annotations,
    onResult: setNotice,
  });

  return (
    <div className="annotation-actions">
      {items.length ? (
        <ResultMenu
          compact={compact}
          label="Saved image actions"
          items={items}
        />
      ) : null}
      {notice ? (
        <span className="annotation-action-status" role="status">
          {notice !== 'Saved in this browser.' ? (
            <WarningDetails warning={notice} />
          ) : null}
          {notice}
        </span>
      ) : null}
    </div>
  );
}
