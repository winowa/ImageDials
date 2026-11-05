import React from 'react';

import { ErrorDetails, WarningDetails } from './ErrorDetails.jsx';
import { localDiagnostic, jobDiagnostic } from './diagnostics.js';
import { imageKey } from './imageRecord.js';
import { PHASE } from './jobs.js';
import ResultMenu from './ResultMenu.jsx';
import { libraryRecordFromResult } from './submission.js';
import { Disclosure, Icon, SavedImg } from './ui.jsx';
import { GROUP_STATUS, groupStatusText } from './variationGroups.js';
import './Variations.css';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The Generate action's own name, which states how many images it asks for. */
export function generateLabel(studio, { regenerate = false } = {}) {
  const count = studio.variations?.count ?? 1;
  if (count > 1)
    return studio.editing
      ? `Generate ${count} edits`
      : `Generate ${count} images`;
  if (studio.editing) return 'Generate edit';
  return regenerate ? 'Regenerate' : 'Generate image';
}

/** The busy Generate label: which image of a group is being made. */
export function busyLabel(job) {
  if (job.phase === PHASE.preparing) return 'Preparing options…';
  if (job.group && job.group.index !== null)
    return `Generating image ${job.group.index + 1} of ${job.group.count}…`;
  return 'Generating…';
}

/**
 * How many images one explicit Generate asks for, behind a compact options
 * button joined to Generate. Shown only when the server offers variations.
 */
export function GenerateOptions({ studio }) {
  const v = studio.variations;
  if (!v?.capability) return null;
  const counts = Array.from({ length: v.capability.max }, (_, i) => i + 1);
  return (
    <ResultMenu
      compact
      label="Generate options"
      heading="Images per request"
      triggerClassName="btn primary generate-options"
      triggerIcon={
        <span className="result-menu-chevron" aria-hidden="true">
          <Icon name="chevron" size={18} />
        </span>
      }
      items={counts.map((count) => {
        const block = count > 1 ? v.blockFor(count) : null;
        return {
          id: `count-${count}`,
          label: plural(count, 'image', 'images'),
          checked: v.count === count,
          disabled: Boolean(block) && v.count !== count,
          hint:
            block && v.count !== count
              ? 'Not enough room in this browser'
              : undefined,
          onSelect: () => v.setCount(count),
        };
      })}
    />
  );
}

/** The saved item in history for a group child, when it is listed. */
function itemFor(history, slot) {
  if (!slot.jobId) return null;
  return (
    history.find(
      (item) =>
        item.generation_job_id === slot.jobId ||
        item.client_pending?.jobId === slot.jobId,
    ) ?? null
  );
}

const SLOT_STATE = {
  [PHASE.complete]: 'complete',
  [PHASE.failed]: 'failed',
  [PHASE.lost]: 'active',
  [PHASE.preview]: 'active',
  [PHASE.running]: 'active',
  [PHASE.accepted]: 'queued',
};

function slotState(slot, lead) {
  const phase = slot.job?.phase;
  if (!phase) return 'unknown';
  if (phase === PHASE.running || phase === PHASE.preview)
    return slot === lead ? 'active' : 'queued';
  return SLOT_STATE[phase] ?? 'queued';
}

const STATE_TEXT = {
  complete: 'ready',
  failed: 'failed',
  active: 'being made',
  queued: 'waiting',
  unknown: 'unavailable',
};

/** Whether the selected item is one of this group's results or provisional items. */
function belongsTo(group, current) {
  if (!group || !current) return false;
  if (current.variation?.group_id === group.id) return true;
  return group.slots.some(
    (slot) =>
      slot.jobId &&
      (current.generation_job_id === slot.jobId ||
        current.client_pending?.jobId === slot.jobId),
  );
}

/**
 * Siblings of a saved variation that are listed in history, from their own
 * immutable variation metadata. Read-only: no frozen request exists here.
 */
function listedSiblings(history, current) {
  const own = current?.variation;
  if (!own?.group_id || !(own.count > 1)) return null;
  const slots = Array.from({ length: own.count }, (_, index) => ({
    index,
    item:
      history.find(
        (item) =>
          !item.client_pending &&
          item.variation?.group_id === own.group_id &&
          item.variation.index === index,
      ) ?? null,
  }));
  return { id: own.group_id, count: own.count, slots };
}

function SlotButton({ index, count, state, item, result, current, onSelect }) {
  const name = `Variation ${index + 1} of ${count}, ${STATE_TEXT[state]}`;
  const image = item ?? result;
  const selected = Boolean(
    item &&
    current &&
    imageKey(current) === imageKey(item) &&
    (current.local_added_at ?? null) === (item.local_added_at ?? null),
  );
  const media =
    state === 'complete' && image ? (
      <SavedImg image={image} />
    ) : item?.client_pending?.preview?.image_url ? (
      <img src={item.client_pending.preview.image_url} alt="" />
    ) : null;
  return (
    <li data-state={state}>
      <button
        type="button"
        className="variation-slot"
        data-state={state}
        aria-label={name}
        aria-pressed={item ? selected : undefined}
        disabled={!item}
        onClick={() => item && onSelect(item)}
      >
        {media ? (
          <span className="variation-media">{media}</span>
        ) : (
          <span className="variation-placeholder" aria-hidden="true">
            {state === 'failed' ? (
              <Icon name="close" size={18} />
            ) : (
              <span className="variation-dot" />
            )}
          </span>
        )}
        <span className="variation-index" aria-hidden="true">
          {index + 1}
        </span>
      </button>
    </li>
  );
}

/**
 * The results of one Generate that asked for several images: compact
 * selectable slots under the stage, bounded progress, and an explicit retry
 * of failed slots only. Shown while the group is being made or one of its
 * images is selected.
 */
export default function Variations({ studio }) {
  const v = studio.variations;
  const history = studio.history ?? [];
  const { current, job } = studio;
  const group = v?.group ?? null;
  const live =
    group &&
    (v.summary.status === GROUP_STATUS.running ||
      group.lost ||
      belongsTo(group, current) ||
      (job?.group && job.group.id === group.id));
  // Choosing a sibling only changes what is shown; the draft stays as it is.
  const choose = (item) => studio.select(item.client_key ?? imageKey(item));

  if (live) {
    const { summary } = v;
    const status = groupStatusText(group);
    const failed = summary.failed;
    const error = group.slots.find((slot) => slot.job?.error)?.job.error;
    const settled = summary.status !== GROUP_STATUS.running && !group.lost;
    return (
      <section
        className="variations"
        aria-label="Variations"
        data-status={group.lost ? 'lost' : summary.status}
      >
        <div className="variations-head">
          <p className="variations-status" role="status" aria-live="polite">
            {status}
          </p>
          {group.lost ? (
            <button type="button" className="btn" onClick={v.resume}>
              <Icon name="refresh" size={18} />
              Check again
            </button>
          ) : null}
          {settled && failed && v.canRetry ? (
            <button
              type="button"
              className="btn"
              onClick={v.retry}
              disabled={v.retrying || undefined}
            >
              <Icon name="refresh" size={18} />
              {failed === summary.total
                ? `Retry all ${failed}`
                : `Retry ${failed} failed`}
            </button>
          ) : null}
          {v.retrying ? (
            <span className="variations-busy" role="status">
              Sending retry…
            </span>
          ) : null}
        </div>
        <ol className="variations-slots" aria-label="Variation results">
          {group.slots.map((slot) => {
            const state = slotState(slot, summary.lead);
            const result =
              slot.job?.phase === PHASE.complete
                ? libraryRecordFromResult(slot.job.result)
                : null;
            return (
              <SlotButton
                key={`${slot.index}:${slot.jobId ?? 'none'}`}
                index={slot.index}
                count={group.count}
                state={state}
                item={itemFor(history, slot)}
                result={result}
                current={current}
                onSelect={choose}
              />
            );
          })}
        </ol>
        {group.lost ? (
          <p className="variations-note" role="alert">
            {group.lost}
            <WarningDetails
              diagnostic={
                group.lostDiagnostic ??
                localDiagnostic({
                  category: 'job',
                  reason: group.lost,
                  facts: { 'Group ID': group.id },
                })
              }
            />
          </p>
        ) : null}
        {settled && failed ? (
          <div className="variations-note" role="alert">
            <span>
              {error ?? 'Generation failed.'}
              {failed && !group.frozen
                ? ' Retry needs the original request, which is not kept after a reload.'
                : ''}
            </span>
            <ErrorDetails
              diagnostic={jobDiagnostic({
                jobId: group.slots.find((slot) => slot.job?.error)?.jobId,
                record: group.slots.find((slot) => slot.job?.error)?.job,
                reason: error ?? 'Generation failed.',
              })}
            />
          </div>
        ) : null}
        {v.retryError ? (
          <div className="variations-note" role="alert">
            <span>{v.retryError.text}</span>
            <ErrorDetails
              diagnostic={
                v.retryError.diagnostic ??
                localDiagnostic({
                  category: 'job',
                  reason: v.retryError.text,
                  data: v.retryError.details,
                })
              }
            />
            <button
              type="button"
              className="icon-btn quiet"
              aria-label="Dismiss retry message"
              onClick={v.dismissRetryError}
            >
              <Icon name="close" size={18} />
            </button>
            {v.retryError.details ? (
              <Disclosure title="Details">
                <pre className="final-prompt">{v.retryError.details}</pre>
              </Disclosure>
            ) : null}
          </div>
        ) : null}
      </section>
    );
  }

  const siblings = listedSiblings(history, current);
  if (!siblings || siblings.slots.filter((s) => s.item).length < 2) return null;
  const listed = siblings.slots.filter((s) => s.item).length;
  return (
    <section className="variations" aria-label="Variations" data-status="saved">
      <div className="variations-head">
        <p className="variations-status">
          {listed === siblings.count
            ? plural(siblings.count, 'variation', 'variations')
            : `${listed} of ${siblings.count} variations listed`}
        </p>
      </div>
      <ol className="variations-slots" aria-label="Variation results">
        {siblings.slots.map((slot) => (
          <SlotButton
            key={slot.index}
            index={slot.index}
            count={siblings.count}
            state={slot.item ? 'complete' : 'unknown'}
            item={slot.item}
            result={null}
            current={current}
            onSelect={choose}
          />
        ))}
      </ol>
    </section>
  );
}

export const variationBadge = (image) =>
  image?.variation?.count > 1
    ? `Variation ${image.variation.index + 1} of ${image.variation.count}`
    : null;
