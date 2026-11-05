import { ErrorDetails, WarningDetails } from './ErrorDetails.jsx';
import React, { useEffect, useRef, useState } from 'react';

import { Icon, Modal } from './ui.jsx';
import { ANNOTATION_LIMITS } from './imageAnnotations.js';
import ResultMenu from './ResultMenu.jsx';
import './LibraryAnnotations.css';

export function LibraryAnnotationFilters({
  annotations,
  value,
  onChange,
  onManage,
}) {
  const favorites = annotations.memberCounts.favorites;
  const canChange = annotations.durable && annotations.status === 'ready';
  const selectedCollection =
    value.kind === 'collection'
      ? annotations.collections.find((item) => item.id === value.id)
      : null;
  const selectedLabel =
    selectedCollection?.name ??
    (value.kind === 'favorites' ? 'Favorites' : 'All');
  const items = [
    {
      id: 'all',
      label: 'All images',
      checked: value.kind === 'all',
      onSelect: () => onChange({ kind: 'all' }),
    },
    {
      id: 'favorites',
      label: 'Favorites',
      hint: `${favorites} ${favorites === 1 ? 'image' : 'images'}`,
      checked: value.kind === 'favorites',
      disabled: !canChange,
      onSelect: () => onChange({ kind: 'favorites' }),
    },
    ...annotations.collections.map((collection) => {
      const count =
        annotations.memberCounts.collections.get(collection.id) ?? 0;
      return {
        id: `collection:${collection.id}`,
        label: collection.name,
        hint: `${count} ${count === 1 ? 'image' : 'images'}`,
        checked: value.kind === 'collection' && value.id === collection.id,
        disabled: !canChange,
        onSelect: () => onChange({ kind: 'collection', id: collection.id }),
      };
    }),
    {
      id: 'manage',
      label: 'Manage collections',
      icon: 'gear',
      disabled: !canChange,
      onSelect: () => onManage(document.activeElement),
    },
  ];
  if (annotations.status === 'unavailable') {
    items.push({
      id: 'unavailable',
      label: 'Favorites and collections are unavailable in this browser',
      disabled: true,
      onSelect: () => {},
    });
  } else if (annotations.status === 'error') {
    items.push({
      id: 'error',
      label:
        annotations.error || 'Favorites and collections could not be loaded',
      disabled: true,
      onSelect: () => {},
    });
    items.push({
      id: 'retry',
      label: 'Retry favorites and collections',
      icon: 'refresh',
      onSelect: annotations.refresh,
    });
  } else if (annotations.status === 'loading') {
    items.push({
      id: 'loading',
      label: 'Loading favorites and collections…',
      disabled: true,
      onSelect: () => {},
    });
  }
  return (
    <>
      {annotations.status === 'error' ||
      annotations.status === 'unavailable' ? (
        <WarningDetails
          warning={
            annotations.errorDetail ??
            (annotations.error ||
              'Favorites and collections are unavailable in this browser')
          }
        />
      ) : null}
      <ResultMenu
        items={items}
        compact
        label={`Filter images: ${selectedLabel}`}
        triggerClassName="btn library-filter-trigger"
        triggerIcon={
          <>
            <span>{selectedLabel}</span>
            <Icon name="chevron" size={15} />
          </>
        }
        heading="Filter images"
      />
    </>
  );
}

function CollectionManager({ annotations, onClose }) {
  const [name, setName] = useState('');
  const [editing, setEditing] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const cancelConfirm = useRef(null);
  const cancelEdit = useRef(null);
  const closeButton = useRef(null);
  const removeOpeners = useRef(new Map());

  const cancelRemoval = (id) => {
    setConfirming(null);
    requestAnimationFrame(() => removeOpeners.current.get(id)?.focus());
  };

  useEffect(() => {
    if (confirming) cancelConfirm.current?.focus();
  }, [confirming]);
  useEffect(() => {
    if (editing) cancelEdit.current?.focus();
  }, [editing]);

  async function create(event) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    const result = await annotations.createCollection(name);
    setBusy(false);
    if (!result.persisted) setMessage(annotations.refusal(result.reason));
    else {
      setName('');
      requestAnimationFrame(() => closeButton.current?.focus());
    }
  }

  async function rename() {
    if (!editing) return;
    setBusy(true);
    setMessage('');
    const result = await annotations.renameCollection(
      editing.collection,
      editing.name,
    );
    setBusy(false);
    if (!result.persisted) setMessage(annotations.refusal(result.reason));
    else {
      setEditing(null);
      requestAnimationFrame(() => closeButton.current?.focus());
    }
  }

  async function remove() {
    if (!confirming) return;
    setBusy(true);
    setMessage('');
    const result = await annotations.removeCollection(confirming.collection);
    setBusy(false);
    if (!result.persisted) setMessage(annotations.refusal(result.reason));
    else {
      setConfirming(null);
      requestAnimationFrame(() => closeButton.current?.focus());
    }
  }

  return (
    <Modal
      label="Manage collections"
      onClose={onClose}
      locked={busy}
      className="collection-manager"
    >
      <div className="dialog-bar">
        <h2>Collections</h2>
        <button
          ref={closeButton}
          type="button"
          className="icon-btn"
          aria-label="Close collections"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      <form className="collection-create" onSubmit={create}>
        <label className="inline-field grow">
          <span>New collection</span>
          <input
            className="field"
            value={name}
            aria-describedby="collection-name-count"
            onChange={(event) => {
              if (
                Array.from(event.target.value).length <= ANNOTATION_LIMITS.name
              )
                setName(event.target.value);
            }}
            placeholder="Collection name"
          />
          <span id="collection-name-count" className="count">
            {Array.from(name).length}/{ANNOTATION_LIMITS.name}
          </span>
        </label>
        <button
          type="submit"
          className="btn primary"
          disabled={
            !name.trim() ||
            busy ||
            annotations.status !== 'ready' ||
            annotations.collections.length >= ANNOTATION_LIMITS.collections
          }
        >
          <Icon name="plus" size={18} /> Add
        </button>
      </form>
      {annotations.status === 'loading' ? (
        <p className="empty" role="status">
          Loading collections…
        </p>
      ) : annotations.status === 'error' ? (
        <div className="alert" role="alert">
          <span>
            <ErrorDetails
              error={annotations.errorDetail ?? annotations.error}
            />
            {annotations.error}
          </span>
          <button type="button" className="btn" onClick={annotations.refresh}>
            Retry
          </button>
        </div>
      ) : annotations.collections.length ? (
        <ul className="collection-list">
          {annotations.collections.map((collection) => {
            const count =
              annotations.memberCounts.collections.get(collection.id) ?? 0;
            const isEditing = editing?.collection.id === collection.id;
            const isConfirming = confirming?.collection.id === collection.id;
            return (
              <li key={collection.id} className="collection-row">
                {isEditing ? (
                  <form
                    className="collection-rename"
                    onSubmit={(event) => {
                      event.preventDefault();
                      rename();
                    }}
                  >
                    <label
                      className="sr-only"
                      htmlFor={`collection-${collection.id}`}
                    >
                      Collection name
                    </label>
                    <input
                      id={`collection-${collection.id}`}
                      className="field"
                      value={editing.name}
                      aria-describedby={`collection-name-count-${collection.id}`}
                      onChange={(event) => {
                        if (
                          Array.from(event.target.value).length <=
                          ANNOTATION_LIMITS.name
                        )
                          setEditing({ ...editing, name: event.target.value });
                      }}
                    />
                    <span
                      id={`collection-name-count-${collection.id}`}
                      className="count"
                    >
                      {Array.from(editing.name).length}/{ANNOTATION_LIMITS.name}
                    </span>
                    <button
                      type="submit"
                      className="btn primary"
                      disabled={!editing.name.trim() || busy}
                    >
                      Save
                    </button>
                    <button
                      ref={cancelEdit}
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() => setEditing(null)}
                    >
                      Cancel
                    </button>
                  </form>
                ) : (
                  <>
                    <div className="collection-row-name">
                      <strong>{collection.name}</strong>
                      <span className="count">
                        {count} {count === 1 ? 'image' : 'images'}
                      </span>
                    </div>
                    {isConfirming ? (
                      <div
                        className="collection-remove-confirm"
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') {
                            event.preventDefault();
                            event.stopPropagation();
                            cancelRemoval(collection.id);
                          }
                        }}
                      >
                        <p>
                          Remove “{collection.name}”? Images remain in the
                          Library.
                        </p>
                        <button
                          ref={cancelConfirm}
                          type="button"
                          className="btn"
                          disabled={busy}
                          onClick={() => cancelRemoval(collection.id)}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="btn danger"
                          disabled={busy}
                          onClick={remove}
                        >
                          {busy ? 'Removing…' : 'Remove collection'}
                        </button>
                      </div>
                    ) : (
                      <div className="collection-row-actions">
                        <button
                          type="button"
                          className="btn"
                          onClick={() => {
                            setMessage('');
                            setEditing({ collection, name: collection.name });
                          }}
                        >
                          Rename
                        </button>
                        <button
                          ref={(node) => {
                            if (node)
                              removeOpeners.current.set(collection.id, node);
                            else removeOpeners.current.delete(collection.id);
                          }}
                          type="button"
                          className="btn danger"
                          onClick={() => {
                            setMessage('');
                            setConfirming({ collection });
                          }}
                        >
                          Remove
                        </button>
                      </div>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="empty">No collections yet.</p>
      )}
      {annotations.collections.length >= ANNOTATION_LIMITS.collections ? (
        <p className="count collection-limit-note">
          <WarningDetails warning="Collection limit reached." />
          Collection limit reached.
        </p>
      ) : null}
      {message ? (
        <p className="error-text" role="alert">
          <ErrorDetails error={message} />
          {message}
        </p>
      ) : null}
      <div className="collection-footer">
        <button type="button" className="btn" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}

export default CollectionManager;
