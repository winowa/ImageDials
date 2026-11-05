import { expect, test } from 'vitest';
import { isExactRecord } from './exactRecords.js';

test('local-only and pending summaries cannot masquerade as exact snapshots', () => {
  expect(
    isExactRecord({
      id: 'summary',
      local_origin: 'imported',
      listing_kind: 'summary-page',
    }),
  ).toBe(false);
  expect(
    isExactRecord({
      id: 'summary',
      client_pending: {},
      metadata_complete: false,
    }),
  ).toBe(false);
  expect(isExactRecord({ id: 'local', local_origin: 'imported' })).toBe(true);
});
