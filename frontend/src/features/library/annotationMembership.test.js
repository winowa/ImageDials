import { expect, test, vi } from 'vitest';

import { deferred } from '../../../tests/helpers/cacheTestSupport.js';
import { SOURCE } from '../../data/storage/cachePolicy.js';
import {
  MEMBER,
  membershipCounts,
  readMember,
  readMembers,
} from './annotationMembership.js';

const shared = (n) => ({
  source: 'shared',
  key: `store/${n}.png`,
  imageId: `image-${n}`,
});

test('membership reads run at four-wide maximum and abort discards late answers', async () => {
  const gates = Array.from({ length: 9 }, () => deferred());
  const identities = Array.from({ length: gates.length }, (_, i) => shared(i));
  const controller = new AbortController();
  const results = [];
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const loadShared = vi.fn(async () => {
    const at = calls++;
    active += 1;
    maximum = Math.max(maximum, active);
    try {
      return await gates[at].promise;
    } finally {
      active -= 1;
    }
  });
  const running = readMembers(identities, {
    source: SOURCE.SHARED,
    signal: controller.signal,
    loadShared,
    onResult: (...value) => results.push(value),
  });
  expect(loadShared).toHaveBeenCalledTimes(4);
  controller.abort();
  for (let i = 0; i < 4; i++)
    gates[i].resolve({
      id: `image-${i}`,
      image_id: `image-${i}`,
      storage_id: 'store',
      filename: `${i}.png`,
    });
  await running;
  expect(maximum).toBe(4);
  expect(results).toHaveLength(0);
  expect(loadShared).toHaveBeenCalledTimes(4);
});

test('shared exact read distinguishes a replacement and keeps unreadable separate from missing', async () => {
  const outcome = await readMember(shared(1), {
    source: SOURCE.SHARED,
    loadShared: async () => ({
      id: 'replacement',
      image_id: 'replacement',
      storage_id: 'store',
      filename: '1.png',
    }),
  });
  expect(outcome.status).toBe(MEMBER.REPLACED);

  const counts = membershipCounts(
    [shared(1), shared(2), shared(3)],
    new Map([
      [
        JSON.stringify(['shared', 'store/1.png', 'image-1']),
        { status: MEMBER.MISSING },
      ],
      [
        JSON.stringify(['shared', 'store/2.png', 'image-2']),
        { status: MEMBER.ERROR },
      ],
    ]),
  );
  expect(counts).toMatchObject({
    members: 3,
    unavailable: 1,
    errors: 1,
    pending: 1,
  });
});

test('private exact reads verify addedAt and expose metadata without wire URLs', async () => {
  const identity = { source: 'private', key: 'private/file.png', addedAt: 12 };
  const readPrivate = vi.fn(async () => ({
    addedAt: 13,
    origin: 'generated',
    record: { id: identity.key, image_url: 'private-wire-url' },
  }));
  const replaced = await readMember(identity, {
    source: SOURCE.PRIVATE,
    readPrivate,
  });
  expect(replaced.status).toBe(MEMBER.REPLACED);
  expect(readPrivate).toHaveBeenCalledWith(identity.key);

  readPrivate.mockResolvedValue({
    addedAt: 12,
    origin: 'generated',
    record: { id: identity.key, image_url: 'private-wire-url' },
  });
  const ready = await readMember(identity, {
    source: SOURCE.PRIVATE,
    readPrivate,
  });
  expect(ready.status).toBe(MEMBER.READY);
  expect(ready.record.image_url).toBe('');
  expect(ready.record.local_added_at).toBe(12);
});
