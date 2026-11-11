/**
 * Confirmed private removals stay effective after their tombstones are
 * compacted. Driven by the shared vectors in
 * fixtures/browser/private-write-integrity.json against the REAL store over the
 * transactional in-memory database (native IndexedDB: frontend/proof).
 */
import { describe, expect, test } from 'vitest';

import vectors from '../../../../fixtures/browser/private-write-integrity.json';
import { STORE } from './cacheDb.js';
import { createCacheStore } from './cacheStore.js';
import {
  PRIVATE_REMOVAL_FENCE_KEY,
  PRIVATE_TOMBSTONE_LIMIT,
  PRIVATE_TOMBSTONE_MAX_BYTES,
} from './cachePrivate.js';
import { WRITE_SKIPPED } from './cacheKernel.js';
import {
  imageBlob,
  memoryDb,
} from '../../../tests/helpers/cacheTestSupport.js';
import { imageKey } from '../records/imageRecord.js';

const limits = {
  sharedRecordLimit: 10,
  sharedVariantLimit: 10,
  sharedVariantMaxBytes: 1000,
  privateRecordLimit: 3,
  privateMaxBytes: 100,
};
const caseOf = (id) => {
  const found = vectors.cases.find((item) => item.id === id);
  if (!found) throw new Error(`missing vector ${id}`);
  return found;
};
const late = vectors.late_removed_entry;
const lateKey = imageKey(late.record);
const lateAdd = (extra = {}) => ({
  record: late.record,
  origin: late.origin,
  addedAt: late.added_at_ms,
  ...extra,
});
const churnEntries = () => {
  const { churn } = vectors;
  return Array.from({ length: churn.count }, (_, index) => {
    const number = churn.first_number + index;
    const id = `${churn.record_id_prefix}${number}`;
    return {
      record: { id, image_id: id },
      origin: 'imported',
      addedAt: churn.added_at_start_ms + index * churn.added_at_step_ms,
      full: imageBlob(churn.original_bytes_per_record),
    };
  });
};
/** Admit and confirm the removal of every churn entry through `store`. */
async function churn(store) {
  for (const item of churnEntries()) {
    expect(await store.admitPrivate(item)).toMatchObject({ persisted: true });
    expect(
      await store.removePrivate(imageKey(item.record), item.addedAt),
    ).toEqual({ removed: true });
  }
}
const rows = (db) => db.data.get(STORE.PRIVATE) ?? new Map();
const media = (db) => db.data.get(STORE.PRIVATE_MEDIA) ?? new Map();
const tombstones = (db) => db.data.get(STORE.PRIVATE_TOMBSTONES) ?? new Map();
const meta = (db, key) => db.data.get(STORE.META)?.get(key);
const sumOfMedia = (db) =>
  [...media(db).values()].reduce((sum, row) => sum + row.bytes, 0);
const encoded = (value) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;
const tombstoneBytes = (db) =>
  [...tombstones(db)].reduce(
    (sum, [key, row]) => sum + encoded(key) + encoded(row),
    0,
  );
const consistent = (db) => {
  expect(meta(db, 'privateBytes') ?? 0).toBe(sumOfMedia(db));
  for (const row of media(db).values())
    expect(rows(db).has(row.key)).toBe(true);
};
/** Deep copy of everything private, to prove a failed write changed nothing. */
const snapshot = (db) =>
  JSON.stringify(
    [STORE.PRIVATE, STORE.PRIVATE_MEDIA, STORE.PRIVATE_TOMBSTONES, STORE.META]
      .map((name) => [...(db.data.get(name) ?? new Map())])
      .map((entries) =>
        entries.map(([key, value]) => [
          key,
          value?.blob ? { ...value, blob: value.blob.size } : value,
        ]),
      ),
  );

describe(`shared private-write vectors (${vectors.scope})`, () => {
  test('the store remembers exactly the vector tombstone record limit', () => {
    expect(PRIVATE_TOMBSTONE_LIMIT).toBe(vectors.tombstone_record_limit);
    expect(vectors.churn.count).toBeGreaterThan(PRIVATE_TOMBSTONE_LIMIT);
  });

  test('late admission after confirmed-removal churn: a tab opened before cannot revive it', async () => {
    const vector = caseOf('late-admission-after-confirmed-removal-churn');
    expect(vector.second_store_opened_before_churn).toBe(true);
    const db = memoryDb();
    const remover = createCacheStore(db, limits);
    const delayedTab = createCacheStore(db, limits);
    await churn(remover);
    // The removed add's own tombstone was compacted away under the fence.
    expect(tombstones(db).has(lateKey)).toBe(false);
    const outcome = await delayedTab.admitPrivate(
      lateAdd({ full: imageBlob(1), thumbnail: imageBlob(1) }),
    );
    expect(outcome).toEqual({
      persisted: false,
      reason: WRITE_SKIPPED.FENCED,
    });
    expect(vector.late_admission_may_create_removed_row).toBe(false);
    expect(rows(db).size).toBe(vector.expected_stored_count);
    expect(media(db).size).toBe(0);
    consistent(db);
  });

  test('reload after the churn does not forget the removal protection', async () => {
    const vector = caseOf('reload-does-not-forget-removal-protection');
    expect(vector.second_store_opened_after_churn).toBe(true);
    const db = memoryDb();
    await churn(createCacheStore(db, limits));
    const reloaded = createCacheStore(db, limits);
    expect(await reloaded.admitPrivate(lateAdd())).toEqual({
      persisted: false,
      reason: WRITE_SKIPPED.FENCED,
    });
    expect(
      await reloaded.admitPrivate(lateAdd({ full: imageBlob(1) })),
    ).toMatchObject({ persisted: false });
    expect(rows(db).size).toBe(vector.expected_stored_count);
  });

  test('the remover tab releases completed removals and relies on durable protection', async () => {
    const db = memoryDb();
    const remover = createCacheStore(db, limits);
    await churn(remover);
    // An in-tab guard would answer `deleted` before reaching the database;
    // `removal-fenced` comes only from the durable fence.
    expect(await remover.admitPrivate(lateAdd())).toEqual({
      persisted: false,
      reason: WRITE_SKIPPED.FENCED,
    });
    // The newest removals are still precise tombstones.
    const last = churnEntries().at(-1);
    expect(await remover.admitPrivate({ ...last, full: imageBlob(1) })).toEqual(
      { persisted: false, reason: WRITE_SKIPPED.DELETED },
    );
  });

  test('a surviving older row keeps recovering media and settings after the fence passes it', async () => {
    const vector = caseOf('surviving-older-original-can-still-recover-media');
    expect(vector.survivor_is_not_removed).toBe(true);
    const db = memoryDb();
    const store = createCacheStore(db, limits);
    const survivor = {
      record: { ...late.record, id: vector.surviving_record_id },
      origin: 'generated',
      addedAt: vector.surviving_added_at_ms,
    };
    const survivorKey = imageKey(survivor.record);
    // A generated row is recorded first; its original arrives later.
    expect(await store.admitPrivate(survivor)).toMatchObject({
      persisted: true,
    });
    await churn(store);
    expect(meta(db, PRIVATE_REMOVAL_FENCE_KEY).addedAt).toBeGreaterThan(
      vector.surviving_added_at_ms,
    );

    const full = imageBlob(7);
    const thumbnail = imageBlob(2);
    const attached = await createCacheStore(db, limits).admitPrivate({
      ...survivor,
      full,
      thumbnail,
    });
    expect(attached).toEqual({
      persisted: true,
      duplicate: false,
      preparedReleased: [],
    });
    expect(vector.same_identity_media_attachment_succeeds).toBe(true);
    const stored = await store.readPrivate(survivorKey);
    expect(stored.record).toEqual(survivor.record);
    expect(stored.record.original_selected_controls[0].value).toBe(false);
    expect(stored.record.original_selected_controls[1].value).toBe(0);
    expect(stored.record.extension).toEqual({
      enabled: false,
      count: 0,
      note: null,
    });
    expect(stored.full).toBe(full);
    expect(stored.thumbnail).toBe(thumbnail);
    // The existing row's later writes stay allowed.
    expect(
      await store.savePrivateWatermark(
        survivorKey,
        { addedAt: survivor.addedAt },
        { analysis: { print_watermark_key: 'k' }, prepared: null },
      ),
    ).toEqual({ persisted: true });

    // A different, obsolete add of that identity never replaces the bytes.
    const before = snapshot(db);
    expect(
      await store.admitPrivate({
        ...survivor,
        addedAt: vector.surviving_added_at_ms + 1,
        full: imageBlob(9),
      }),
    ).toEqual({ persisted: false, reason: WRITE_SKIPPED.FENCED });
    expect(snapshot(db)).toBe(before);
    expect(vector.survivor_record_and_existing_original_unchanged).toBe(true);
    expect((await store.readPrivate(survivorKey)).full).toBe(full);
    consistent(db);
  });

  test('a deliberate reimport is a new incarnation that late old writes cannot replace', async () => {
    const vector = caseOf('deliberate-reimport-is-a-new-incarnation');
    const db = memoryDb();
    const delayedTab = createCacheStore(db, limits);
    const store = createCacheStore(db, limits);
    await churn(store);
    const fresh = {
      record: { ...late.record, original_prompt: vector.new_original_prompt },
      origin: 'imported',
      addedAt: vector.new_added_at_ms,
    };
    const freshFull = imageBlob(5);
    expect(await store.admitPrivate({ ...fresh, full: freshFull })).toEqual({
      persisted: true,
      duplicate: false,
      preparedReleased: [],
    });
    expect(vector.new_admission_succeeds).toBe(true);

    const before = snapshot(db);
    const stale = await delayedTab.admitPrivate(
      lateAdd({ full: imageBlob(3), thumbnail: imageBlob(1) }),
    );
    // Not adopted as a duplicate: the caller must not attach stale bytes.
    expect(stale).toEqual({ persisted: false, reason: WRITE_SKIPPED.FENCED });
    expect(vector.late_old_admission_may_replace_new_record_or_bytes).toBe(
      false,
    );
    expect(snapshot(db)).toBe(before);
    const stored = await store.readPrivate(lateKey);
    expect(stored.addedAt).toBe(vector.new_added_at_ms);
    expect(stored.record.original_prompt).toBe(vector.new_original_prompt);
    expect(stored.full).toBe(freshFull);
  });

  test('a new incarnation without bytes yet is protected while its old tombstone is still precise', async () => {
    const vector = caseOf('deliberate-reimport-is-a-new-incarnation');
    const db = memoryDb();
    const oldTab = createCacheStore(db, limits);
    const store = createCacheStore(db, limits);
    await store.admitPrivate(lateAdd());
    expect(await store.removePrivate(lateKey, late.added_at_ms)).toEqual({
      removed: true,
    });
    // A generated-style row recorded first, its original still to come.
    await store.admitPrivate({
      ...lateAdd(),
      origin: 'generated',
      addedAt: vector.new_added_at_ms,
    });
    expect(await oldTab.admitPrivate(lateAdd({ full: imageBlob(4) }))).toEqual({
      persisted: false,
      reason: WRITE_SKIPPED.DELETED,
    });
    expect(media(db).size).toBe(0);
    expect(rows(db).get(lateKey).addedAt).toBe(vector.new_added_at_ms);
    // The new add itself still attaches its own original.
    const own = imageBlob(6);
    expect(
      await store.admitPrivate({
        ...lateAdd(),
        addedAt: vector.new_added_at_ms,
        full: own,
      }),
    ).toMatchObject({ persisted: true, duplicate: false });
    expect((await store.readPrivate(lateKey)).full).toBe(own);
  });

  test('a removal that fails at commit rolls back the row, bytes, tombstones and fence', async () => {
    const vector = caseOf('failed-removal-rolls-back-all-removal-state');
    expect(vector.failure_at_transaction_commit).toBe(true);
    const db = memoryDb();
    const store = createCacheStore(db, limits);
    const delayedTab = createCacheStore(db, limits);
    // Fill the tombstones to the limit so this removal would compact.
    await churn(store);
    const full = imageBlob(8);
    const thumbnail = imageBlob(2);
    const kept = { ...lateAdd(), addedAt: 5000 };
    await store.admitPrivate({ ...kept, full, thumbnail });
    const before = snapshot(db);
    db.failNext(new Error('commit refused'));
    const outcome = await store.removePrivate(lateKey, kept.addedAt);
    expect(outcome.removed).toBe(vector.removal_confirmed);
    expect(outcome.error.message).toBe('commit refused');
    expect(snapshot(db)).toBe(before);
    expect(vector.record_and_all_original_bytes_unchanged).toBe(true);
    const stored = await store.readPrivate(lateKey);
    expect(stored.full).toBe(full);
    expect(stored.thumbnail).toBe(thumbnail);
    // The in-tab removal was withdrawn: recovery is allowed in every tab.
    expect(vector.same_identity_media_recovery_remains_allowed).toBe(true);
    for (const tab of [store, delayedTab])
      expect(await tab.admitPrivate({ ...kept, full, thumbnail })).toEqual({
        persisted: true,
        duplicate: false,
        preparedReleased: [],
      });
    consistent(db);
  });

  test('an older database above lowered budgets keeps every original and only refuses new storage', async () => {
    const vector = caseOf('older-database-and-lowered-budget-keep-originals');
    const db = memoryDb();
    const roomy = createCacheStore(db, {
      ...limits,
      privateRecordLimit: vector.stored_record_count,
      privateMaxBytes: 1000,
    });
    const originals = new Map();
    for (let n = 0; n < vector.stored_record_count; n += 1) {
      const item = {
        record: { ...late.record, id: `old-${n}` },
        origin: 'imported',
        addedAt: 10 + n,
        full: imageBlob(20 + n),
        thumbnail: imageBlob(3),
      };
      originals.set(item.record.id, item);
      await roomy.admitPrivate(item);
    }
    // A previous release left a removal behind and never wrote a fence.
    await roomy.removePrivate('gone', 12);
    db.data.get(STORE.META).delete(PRIVATE_REMOVAL_FENCE_KEY);

    const lowered = createCacheStore(db, {
      ...limits,
      privateRecordLimit: vector.new_admission_record_limit,
      privateMaxBytes: 1000,
    });
    const loaded = await lowered.loadPrivate();
    expect(loaded).toHaveLength(vector.expected_accessible_record_count);
    for (const row of loaded) {
      const original = originals.get(row.record.id);
      expect(row.full).toBe(original.full);
      expect(row.thumbnail).toBe(original.thumbnail);
      expect(row.record).toEqual(original.record);
    }
    expect(vector.original_and_thumbnail_bytes_unchanged).toBe(true);
    expect(
      await lowered.admitPrivate({
        record: { id: 'new' },
        origin: 'imported',
        addedAt: 100,
        full: imageBlob(1),
      }),
    ).toEqual({ persisted: false, reason: WRITE_SKIPPED.RECORD_LIMIT });
    expect(vector.new_admission_may_evict_originals).toBe(false);
    expect(await lowered.loadPrivate()).toHaveLength(
      vector.expected_accessible_record_count,
    );
    // Same-add recovery of an old row above the limit is still allowed.
    const old = originals.get('old-0');
    expect(await lowered.admitPrivate(old)).toMatchObject({ persisted: true });
    consistent(db);
  });
});

describe('bounded removal metadata', () => {
  test('durable tombstones stay within the named record AND byte ceilings', async () => {
    const db = memoryDb();
    const store = createCacheStore(db, limits);
    // Long identities make the byte ceiling bind before the record ceiling.
    const longId = (n) => `${'long-identity-'.repeat(70)}${n}`;
    const count = 120;
    for (let n = 1; n <= count; n += 1) {
      const item = {
        record: { id: longId(n) },
        origin: 'imported',
        addedAt: n,
      };
      await store.admitPrivate(item);
      await store.removePrivate(longId(n), n);
      expect(tombstoneBytes(db)).toBeLessThanOrEqual(
        PRIVATE_TOMBSTONE_MAX_BYTES,
      );
      expect(tombstones(db).size).toBeLessThanOrEqual(PRIVATE_TOMBSTONE_LIMIT);
    }
    expect(tombstones(db).size).toBeLessThan(count);
    expect(tombstones(db).size).toBeGreaterThan(0);
    for (let n = 1; n <= count; n += 1)
      expect(
        await createCacheStore(db, limits).admitPrivate({
          record: { id: longId(n) },
          origin: 'imported',
          addedAt: n,
        }),
      ).toMatchObject({ persisted: false });
    expect(rows(db).size).toBe(0);
  });

  test('a store without a database bounds its in-tab removal memory', async () => {
    const store = createCacheStore(null, limits);
    const removals = PRIVATE_TOMBSTONE_LIMIT + 2;
    for (let n = 1; n <= removals; n += 1)
      expect(await store.removePrivate(`k${n}`, n)).toEqual({ removed: true });
    const admit = (n) =>
      store.admitPrivate({
        record: { id: `k${n}` },
        origin: 'imported',
        addedAt: n,
      });
    // The newest removals are remembered, the oldest were released; neither
    // can be stored, since there is no storage.
    expect(await admit(removals)).toEqual({
      persisted: false,
      reason: WRITE_SKIPPED.DELETED,
    });
    expect(await admit(1)).toEqual({
      persisted: false,
      reason: WRITE_SKIPPED.NO_STORAGE,
    });
  });

  test('a database from the previous schema infers a fence from its remaining tombstones', async () => {
    const db = memoryDb();
    // Exactly the state the previous release left after the 202-removal churn:
    // the two oldest tombstones pruned, no fence recorded.
    const legacyTombstones = new Map();
    for (const item of churnEntries().slice(2))
      legacyTombstones.set(imageKey(item.record), { addedAt: item.addedAt });
    db.data.set(STORE.PRIVATE_TOMBSTONES, legacyTombstones);
    const settings = new Map([['watermark', { enabled: false, opacity: 0 }]]);
    db.data.set(STORE.SETTINGS, settings);
    const survivor = {
      record: { id: 'survivor' },
      origin: 'generated',
      addedAt: 0,
    };
    db.data.set(
      STORE.PRIVATE,
      new Map([[imageKey(survivor.record), { ...survivor }]]),
    );
    const store = createCacheStore(db, limits);
    expect(await store.admitPrivate(lateAdd({ full: imageBlob(1) }))).toEqual({
      persisted: false,
      reason: WRITE_SKIPPED.FENCED,
    });
    expect(rows(db).has(lateKey)).toBe(false);
    // Inference touched no tombstone, row or setting.
    expect(tombstones(db)).toBe(legacyTombstones);
    expect(tombstones(db).size).toBe(vectors.churn.count - 2);
    expect(db.data.get(STORE.SETTINGS)).toBe(settings);
    expect(settings.get('watermark')).toEqual({ enabled: false, opacity: 0 });
    expect(
      await store.admitPrivate({ ...survivor, full: imageBlob(4) }),
    ).toMatchObject({ persisted: true, duplicate: false });
    // A new add made now is unaffected.
    expect(
      await store.admitPrivate({
        record: { id: 'fresh' },
        origin: 'imported',
        addedAt: 10_000,
      }),
    ).toMatchObject({ persisted: true });
  });
});

describe('overlapping removals and concurrent writers', () => {
  const add = (id, addedAt, extra = {}) => ({
    record: { id, safe: false, count: 0, note: null },
    origin: 'imported',
    addedAt,
    ...extra,
  });

  test('the first of two same-key removals failing does not drop the other pending guard', async () => {
    const db = memoryDb();
    const store = createCacheStore(db, limits);
    await store.admitPrivate(add('a', 5, { full: imageBlob(5) }));
    db.failNext(new Error('first refused'));
    const first = store.removePrivate('a', 5);
    const second = store.removePrivate('a', 5);
    expect((await first).removed).toBe(false);
    // The second removal is still pending: the row stays hidden in this tab
    // and a late write is refused before reaching the database.
    expect(await store.readPrivate('a')).toBeNull();
    expect(
      await store.admitPrivate(add('a', 5, { full: imageBlob(5) })),
    ).toEqual({ persisted: false, reason: WRITE_SKIPPED.DELETED });
    expect(await second).toEqual({ removed: true });
    expect(rows(db).size).toBe(0);
    consistent(db);
  });

  test('a later same-key removal failing after the first succeeded leaves the removal effective', async () => {
    const db = memoryDb();
    const store = createCacheStore(db, limits);
    await store.admitPrivate(add('a', 5, { full: imageBlob(5) }));
    let writes = 0;
    db.failNext(new Error('second refused'), () => (writes += 1) === 2);
    const [first, second] = await Promise.all([
      store.removePrivate('a', 5),
      store.removePrivate('a', 5),
    ]);
    expect(first).toEqual({ removed: true });
    expect(second.removed).toBe(false);
    expect(
      await createCacheStore(db, limits).admitPrivate(
        add('a', 5, { full: imageBlob(5) }),
      ),
    ).toEqual({ persisted: false, reason: WRITE_SKIPPED.DELETED });
    expect(await store.readPrivate('a')).toBeNull();
  });

  test('a removal racing a stale writer in another tab never leaves the removed add behind', async () => {
    for (const removeFirst of [true, false]) {
      const db = memoryDb();
      const remover = createCacheStore(db, limits);
      const writer = createCacheStore(db, limits);
      await remover.admitPrivate(add('a', 5));
      const remove = () => remover.removePrivate('a', 5);
      const write = () =>
        writer.admitPrivate(add('a', 5, { full: imageBlob(9) }));
      const [removed] = removeFirst
        ? await Promise.all([remove(), write()])
        : await Promise.all([write(), remove()]).then(([w, r]) => [r, w]);
      expect(removed).toEqual({ removed: true });
      expect(rows(db).size).toBe(0);
      expect(media(db).size).toBe(0);
      expect(await write()).toEqual({
        persisted: false,
        reason: WRITE_SKIPPED.DELETED,
      });
      consistent(db);
    }
  });
});
