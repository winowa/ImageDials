import { expect, test, vi } from 'vitest';

import {
  formatBytes,
  keepFailure,
  keptFile,
  limitText,
  removeFailure,
  retainedReader,
  usageFraction,
  usageText,
} from './retainedReferences.js';

const usage = {
  count: 3,
  bytes: 4404019,
  sequence: 9,
  maxRecords: 32,
  maxBytes: 268435456,
};

test('byte and usage text uses binary units', () => {
  expect(formatBytes(0)).toBe('0 B');
  expect(formatBytes(812)).toBe('812 B');
  expect(formatBytes(1536)).toBe('1.5 KiB');
  expect(formatBytes(4404019)).toBe('4.2 MiB');
  expect(formatBytes(268435456)).toBe('256 MiB');
  expect(formatBytes(2 * 1024 ** 3)).toBe('2 GiB');
  expect(formatBytes(-1)).toBe('0 B');
  expect(formatBytes(NaN)).toBe('0 B');
  expect(usageText(usage)).toBe('3 of 32 files · 4.2 MiB of 256 MiB');
  expect(usageText(null)).toBe('');
  expect(limitText(usage)).toBe('up to 32 files, 256 MiB');
});

test('usage fraction follows the tighter of the file and byte budgets', () => {
  expect(usageFraction(usage)).toBeCloseTo(3 / 32);
  expect(usageFraction({ ...usage, count: 1, bytes: 268435456 / 2 })).toBe(0.5);
  expect(usageFraction({ ...usage, count: 99 })).toBe(1);
  expect(usageFraction(null)).toBe(0);
});

test.each([
  ['record-limit', { retry: false, manage: true }, /32 kept files are in use/],
  [
    'byte-limit',
    { retry: false, manage: true },
    /does not fit in the remaining/,
  ],
  ['quota', { retry: true, manage: true }, /no room to store it/],
  ['no-storage', { retry: false, manage: false }, /not storing files here/],
  ['changed', { retry: true, manage: false }, /another tab/],
  [
    'checksum-mismatch',
    { retry: true, manage: false },
    /could not be verified/,
  ],
  ['invalid', { retry: false, manage: false }, /cannot be stored/],
  ['failed', { retry: true, manage: false }, /could not store it/],
  ['anything else', { retry: true, manage: false }, /could not store it/],
])(
  'keep failure %s is honest and keeps the draft file',
  (reason, flags, text) => {
    const answer = keepFailure(reason, usage);
    expect(answer).toMatchObject(flags);
    expect(answer.message).toMatch(/^Not kept: /);
    expect(answer.message).toMatch(text);
    expect(answer.message).toMatch(/still in this draft\.$/);
  },
);

test('removal failures never claim success', () => {
  expect(removeFailure('changed')).toMatch(/changed in another tab/);
  expect(removeFailure('no-storage')).toMatch(/not storing files here/);
  expect(removeFailure('failed')).toMatch(/could not be removed/);
});

test('the reader needs a store, reads once and drops aborted answers', async () => {
  expect(retainedReader(null)).toBeNull();
  const entry = { sha256: 'a', blob: new Blob(['x']) };
  const store = { read: vi.fn(async () => entry) };
  const read = retainedReader(store);
  expect(await read('a')).toBe(entry);
  expect(store.read).toHaveBeenCalledTimes(1);

  const controller = new AbortController();
  controller.abort();
  await expect(read('a', { signal: controller.signal })).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(store.read).toHaveBeenCalledTimes(1);

  const late = new AbortController();
  let release;
  const slow = retainedReader({
    read: () =>
      new Promise((resolve) => {
        release = () => resolve(entry);
      }),
  });
  const pending = slow('a', { signal: late.signal });
  late.abort();
  release();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

  expect(await retainedReader({ read: async () => undefined })('a')).toBeNull();
});

test('a kept file gets a usable name and type', () => {
  const file = keptFile({
    blob: new Blob(['x'], { type: 'image/webp' }),
    name: 'lamp.webp',
    type: 'image/webp',
  });
  expect(file).toBeInstanceOf(File);
  expect([file.name, file.type, file.size]).toEqual([
    'lamp.webp',
    'image/webp',
    1,
  ]);
  expect(keptFile({ blob: new Blob(['x']) }).name).toBe('reference');
  expect(keptFile({ blob: new Blob(['x']) }).type).toBe('image/png');
});
