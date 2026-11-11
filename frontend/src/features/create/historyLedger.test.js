import { describe, expect, test } from 'vitest';

import {
  composeHistory,
  emptyLedger,
  findSelected,
  isDismissable,
  jobKey,
  ledgerReducer,
  sameStoredIdentity,
} from './historyLedger.js';
import { imageKey, LOCAL_ORIGIN } from '../../data/records/imageRecord.js';
import { newJob, PHASE } from '../../data/api/jobs.js';
import {
  clone,
  fixtures,
  sizedRecord,
} from '../../../tests/helpers/testSupport.js';

const body = (prompt = 'A tiny glass fox') => ({
  prompt,
  controls: [{ id: 'style', label: 'Style', kind: 'radio', value: 'glass' }],
  dimensions: '1152x768',
  dynamic_controls_metadata: { token: 'abc' },
  generation_mode: 'standard',
});
const accept = (ledger, jobId, extra = {}) =>
  ledgerReducer(ledger, {
    type: 'accepted',
    jobId,
    body: body(extra.prompt),
    previous: extra.previous ?? null,
  });
const observe = (ledger, id, phase, extra = {}) =>
  ledgerReducer(ledger, {
    type: 'observed',
    job: { ...newJob(phase, id), ...extra },
  });
/** What a completed job reports; the stored list may lack the job id. */
const result = (id, extra = {}) => sizedRecord(id, 1152, 768, extra);
const listed = (record) => {
  const { generation_job_id: _dropped, ...rest } = record;
  return rest;
};
const compose = (ledger, stored, imported) =>
  composeHistory({ ledger, stored, imported });

describe('provisional item', () => {
  test('exists from acceptance with the frozen request and previous result', () => {
    const previous = result('old');
    const ledger = accept(emptyLedger, 'job-1', { previous });
    const { items } = compose(ledger, [previous]);
    expect(items).toHaveLength(2);
    const [pending, old] = items;
    expect(pending.client_key).toBe(jobKey('job-1'));
    expect(pending.original_prompt).toBe('A tiny glass fox');
    expect(pending.selected_controls).toEqual(body().controls);
    expect(pending.dynamic_controls_metadata).toEqual({ token: 'abc' });
    expect(pending.requested_dimensions).toBe('1152x768');
    expect(pending.client_pending.previous).toBe(previous);
    expect(pending.storage_id).toBeUndefined();
    expect(old).toBe(previous);
  });

  test('is not a stored record and never a library identity', () => {
    const [pending] = compose(accept(emptyLedger, 'job-1'), []).items;
    expect(pending.filename).toBeUndefined();
    expect(pending.storage_id).toBeUndefined();
    expect(imageKey(pending)).toBe('job:job-1');
  });

  test('accepting the same job twice adds nothing', () => {
    const once = accept(emptyLedger, 'job-1');
    expect(accept(once, 'job-1')).toBe(once);
  });

  test('a pending item reflects progress and keeps its object while unchanged', () => {
    let ledger = accept(emptyLedger, 'job-1');
    const first = compose(ledger, []).items[0];
    expect(observe(ledger, 'job-1', PHASE.accepted)).toBe(ledger);
    ledger = observe(ledger, 'job-1', PHASE.running, { stage: 'rendering' });
    const next = compose(ledger, []).items[0];
    expect(next.client_pending.stage).toBe('rendering');
    expect(compose(ledger, []).items[0]).toBe(next);
    expect(first.client_key).toBe(next.client_key);
  });
});

describe('preview and failure', () => {
  test('a preview is not success; the item stays pending with its preview', () => {
    const ledger = observe(
      accept(emptyLedger, 'job-1'),
      'job-1',
      PHASE.preview,
      {
        preview: { image_url: '/preview.png' },
      },
    );
    const [item] = compose(ledger, []).items;
    expect(item.client_pending.phase).toBe(PHASE.preview);
    expect(item.client_pending.preview.image_url).toBe('/preview.png');
    expect(isDismissable(item)).toBe(false);
  });

  test('failed after a preview stays failed and ignores late completion', () => {
    let ledger = observe(accept(emptyLedger, 'job-1'), 'job-1', PHASE.preview, {
      preview: { image_url: '/preview.png' },
    });
    ledger = observe(ledger, 'job-1', PHASE.failed, {
      error: 'Enrichment unavailable',
      preview: { image_url: '/preview.png' },
    });
    const late = ledgerReducer(ledger, {
      type: 'stored',
      jobId: 'job-1',
      record: result('one'),
    });
    expect(late).toBe(ledger);
    expect(observe(ledger, 'job-1', PHASE.running)).toBe(ledger);
    const [item] = compose(late, [result('one')]).items;
    expect(item.client_pending.phase).toBe(PHASE.failed);
    expect(item.client_pending.error).toBe('Enrichment unavailable');
    expect(item.client_pending.preview.image_url).toBe('/preview.png');
    expect(isDismissable(item)).toBe(true);
  });

  test('a replayed terminal event changes nothing', () => {
    const done = ledgerReducer(accept(emptyLedger, 'job-1'), {
      type: 'stored',
      jobId: 'job-1',
      record: result('one'),
    });
    expect(
      ledgerReducer(done, {
        type: 'stored',
        jobId: 'job-1',
        record: result('x'),
      }),
    ).toBe(done);
    expect(observe(done, 'job-1', PHASE.failed, { error: 'late' })).toBe(done);
  });

  test('only a failed item can be dismissed', () => {
    const live = accept(emptyLedger, 'job-1');
    expect(ledgerReducer(live, { type: 'dismiss', jobId: 'job-1' })).toBe(live);
    const failed = observe(live, 'job-1', PHASE.failed, { error: 'x' });
    expect(
      compose(ledgerReducer(failed, { type: 'dismiss', jobId: 'job-1' }), [])
        .items,
    ).toHaveLength(0);
  });
});

describe('job and stored identity', () => {
  const complete = (ledger, jobId, record) =>
    ledgerReducer(ledger, { type: 'stored', jobId, record });

  test('merges when the library record lacks the job id, keeping key and selection', () => {
    const saved = result('one');
    let ledger = accept(emptyLedger, 'job-1');
    const pendingSelected = jobKey('job-1');
    ledger = complete(ledger, 'job-1', saved);
    const composed = compose(ledger, [listed(saved)]);
    expect(composed.items).toHaveLength(1);
    const [item] = composed.items;
    expect(item.client_key).toBe(jobKey('job-1'));
    expect(item.generation_job_id).toBe('job-1');
    expect(item.client_pending).toBeUndefined();
    // The selection made on the pending item still finds the saved one.
    expect(findSelected(composed, pendingSelected)).toBe(item);
    expect(findSelected(composed, imageKey(saved))).toBe(item);
  });

  test('authoritative metadata wins and fills only what the saved record lacks', () => {
    const own = result('one', { title: 'Result title', alt_text: 'Alt' });
    const authoritative = {
      ...listed(own),
      title: 'Saved title',
      alt_text: null,
    };
    const ledger = complete(accept(emptyLedger, 'job-1'), 'job-1', own);
    const [item] = compose(ledger, [authoritative]).items;
    expect(item.title).toBe('Saved title');
    expect(item.alt_text).toBe('Alt');
  });

  test('the same item object is returned across recompositions', () => {
    const saved = listed(result('one'));
    const ledger = complete(
      accept(emptyLedger, 'job-1'),
      'job-1',
      result('one'),
    );
    expect(compose(ledger, [saved]).items[0]).toBe(
      compose(ledger, [saved]).items[0],
    );
  });

  test('a record carrying the job id links without a result identity', () => {
    const saved = result('one', { generation_job_id: 'job-1' });
    const ledger = complete(
      accept(emptyLedger, 'job-1'),
      'job-1',
      result('zzz'),
    );
    const { items } = compose(ledger, [saved]);
    expect(items).toHaveLength(1);
    expect(imageKey(items[0])).toBe(imageKey(saved));
  });

  test('a completed job whose result is no longer listed is not brought back', () => {
    const ledger = complete(
      accept(emptyLedger, 'job-1'),
      'job-1',
      result('one'),
    );
    expect(compose(ledger, []).items).toHaveLength(0);
  });

  test('stale snapshot of the previous image cannot replace the pending item', () => {
    const old = result('old');
    // The regeneration reuses nothing of the old image's identity.
    const ledger = accept(emptyLedger, 'job-2', { previous: old });
    const stale = { ...old, selected_controls: [], title: 'Old' };
    const { items } = compose(ledger, [stale]);
    expect(items[0].client_pending.phase).toBe(PHASE.accepted);
    expect(items[0].selected_controls).toEqual(body().controls);
    expect(items[1]).toBe(stale);
    expect(items[0].client_pending.previous).toBe(old);
  });

  test('a pending job hides, not duplicates, its own stored record', () => {
    const early = result('one', { generation_job_id: 'job-1' });
    const { items } = compose(accept(emptyLedger, 'job-1'), [early]);
    expect(items).toHaveLength(1);
    expect(items[0].client_pending.phase).toBe(PHASE.accepted);
  });

  test('distinct jobs stay distinct when a stale identity overlaps', () => {
    const first = result('one');
    // The second job reports a result that overlaps the first on id only.
    const second = { ...result('two'), id: 'one', image_id: 'two' };
    let ledger = complete(accept(emptyLedger, 'job-1'), 'job-1', first);
    ledger = complete(accept(ledger, 'job-2'), 'job-2', second);
    const { items } = compose(ledger, [listed(first)]);
    const keys = items.map((i) => i.client_key);
    expect(new Set(keys).size).toBe(items.length);
    expect(keys).toContain(jobKey('job-1'));
    expect(keys).toContain(jobKey('job-2'));
    expect(items.find((i) => i.client_key === jobKey('job-1')).image_id).toBe(
      'one',
    );
    expect(items.find((i) => i.client_key === jobKey('job-2')).image_id).toBe(
      'two',
    );
  });

  test('a job id match beats a result identity match', () => {
    const shared = result('one');
    const byId = result('two', { generation_job_id: 'job-2' });
    let ledger = complete(accept(emptyLedger, 'job-1'), 'job-1', shared);
    ledger = complete(accept(ledger, 'job-2'), 'job-2', shared);
    const { items } = compose(ledger, [byId, listed(shared)]);
    expect(items.find((i) => i.client_key === jobKey('job-2')).image_id).toBe(
      'two',
    );
    expect(items.find((i) => i.client_key === jobKey('job-1')).image_id).toBe(
      'one',
    );
  });

  test('pending items sit first, newest accepted first', () => {
    let ledger = accept(emptyLedger, 'job-1');
    ledger = observe(ledger, 'job-1', PHASE.failed, { error: 'x' });
    ledger = accept(ledger, 'job-2');
    const { items } = compose(ledger, [result('one')]);
    expect(items.map((i) => i.client_key ?? imageKey(i))).toEqual([
      jobKey('job-2'),
      jobKey('job-1'),
      imageKey(result('one')),
    ]);
  });

  test('the ledger is bounded by dropping the oldest settled jobs', () => {
    let ledger = emptyLedger;
    for (let i = 0; i < 60; i += 1) {
      ledger = accept(ledger, `job-${i}`);
      ledger = observe(ledger, `job-${i}`, PHASE.failed, { error: 'x' });
    }
    expect(ledger.length).toBe(40);
    expect(ledger.at(-1).jobId).toBe('job-59');
  });
});

describe('imported item and stored record', () => {
  const imported = (id, extra = {}) => ({
    ...sizedRecord(id, 1152, 768),
    storage_type: 'browser-upload',
    storage_id: undefined,
    filename: undefined,
    local_origin: LOCAL_ORIGIN.IMPORTED,
    image_url: `blob:local-${id}`,
    ...extra,
  });

  test('one item when the exact stored identity appears in the shared list', () => {
    const local = imported('one');
    const stored = result('one');
    const composed = compose(emptyLedger, [stored], [local]);
    expect(composed.items).toHaveLength(1);
    // The selection made on either representation still resolves.
    expect(findSelected(composed, imageKey(local))).toBe(composed.items[0]);
    expect(findSelected(composed, imageKey(stored))).toBe(composed.items[0]);
  });

  test('the more complete record represents the item, ties go to the local bytes', () => {
    const sparse = imported('one', { alt_text: null, final_prompt: '' });
    const full = result('one', { alt_text: 'Alt', final_prompt: 'Final' });
    expect(compose(emptyLedger, [full], [sparse]).items[0]).toBe(full);
    const tie = result('one');
    const local = imported('one');
    expect(compose(emptyLedger, [tie], [local]).items[0]).toBe(local);
  });

  test('distinct entries with the same prompt are never merged', () => {
    const local = imported('private-1', { original_prompt: 'same' });
    const stored = result('other', { original_prompt: 'same' });
    expect(compose(emptyLedger, [stored], [local]).items).toHaveLength(2);
  });

  test('a conflicting stronger identity keeps overlapping records apart', () => {
    const a = { id: 'x', image_id: 'a' };
    const b = { id: 'x', image_id: 'b' };
    expect(sameStoredIdentity(a, b)).toBe(false);
    expect(sameStoredIdentity({ id: 'x' }, { id: 'x' })).toBe(true);
    expect(sameStoredIdentity({ id: 'x' }, { id: 'y' })).toBe(false);
  });

  test('inputs are not changed: both origins stay in their own lists', () => {
    const local = Object.freeze(imported('one'));
    const stored = Object.freeze(result('one'));
    const importedList = [local];
    const storedList = [stored];
    compose(emptyLedger, storedList, importedList);
    expect(importedList).toEqual([local]);
    expect(storedList).toEqual([stored]);
  });
});

describe('restore data', () => {
  test('the pending item carries the full original request for restore', () => {
    const ledger = ledgerReducer(emptyLedger, {
      type: 'accepted',
      jobId: 'j',
      body: {
        ...body('Fox'),
        dimensions: '768x1152',
        generation_mode: 'trellis',
      },
    });
    const [item] = compose(ledger, []).items;
    expect(item.generation_mode).toBe('trellis');
    expect(item.requested_dimensions).toBe('768x1152');
  });

  test('pending history freezes independent required terms', () => {
    const terms = clone(fixtures.generation.must_have_terms);
    const submittedBody = Object.freeze({
      ...body('Fox'),
      must_have_terms: Object.freeze(terms),
    });
    const ledger = ledgerReducer(emptyLedger, {
      type: 'accepted',
      jobId: 'j',
      body: submittedBody,
    });
    const [item] = compose(ledger, []).items;

    expect(item.must_have_terms).toEqual(fixtures.generation.must_have_terms);
    expect(item.must_have_terms).not.toBe(submittedBody.must_have_terms);
    expect(Object.isFrozen(item.must_have_terms)).toBe(true);
    expect(submittedBody.must_have_terms).toEqual(
      fixtures.generation.must_have_terms,
    );
  });
});
