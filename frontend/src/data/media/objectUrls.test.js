import { expect, test, vi } from 'vitest';

import { createUrlLedger } from './objectUrls.js';

const fakeUrlApi = () => {
  let next = 0;
  return {
    createObjectURL: vi.fn(() => `blob:test-${(next += 1)}`),
    revokeObjectURL: vi.fn(),
  };
};

test('a URL shared by preview and history is revoked only after the last release', () => {
  const urlApi = fakeUrlApi();
  const ledger = createUrlLedger(urlApi);
  const url = ledger.acquire(new Blob(['x']));
  ledger.retain(url);
  ledger.release(url);
  expect(urlApi.revokeObjectURL).not.toHaveBeenCalled();
  ledger.release(url);
  expect(urlApi.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(url);
  ledger.release(url);
  expect(urlApi.revokeObjectURL).toHaveBeenCalledTimes(1);
});

test('releaseAll revokes everything still held', () => {
  const urlApi = fakeUrlApi();
  const ledger = createUrlLedger(urlApi);
  const first = ledger.acquire(new Blob(['a']));
  const second = ledger.acquire(new Blob(['b']));
  ledger.release(first);
  ledger.releaseAll();
  expect(urlApi.revokeObjectURL.mock.calls.map(([u]) => u)).toEqual([
    first,
    second,
  ]);
  expect(ledger.held(second)).toBe(0);
});
