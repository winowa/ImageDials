import { expect, test } from 'vitest';

import sharedDefaults from '../../../../shared/client-policy.json';
import m5 from '../../../../fixtures/api/m5-configuration.json';
import {
  DEFAULT_CLIENT_POLICY,
  normalizeClientPolicy,
} from './clientPolicy.js';

test('the shared document supplies every default, camel-cased', () => {
  expect(DEFAULT_CLIENT_POLICY.controls).toMatchObject({
    debounceMs: 900,
    resetDebounceMs: 250,
    revealHoldMs: 2000,
    similarityMinimumRatio: 0.5,
    maxAttempts: 2,
  });
  expect(DEFAULT_CLIENT_POLICY.transport).toMatchObject({
    jobPollIntervalMs: 1000,
    jobPollMaxFailures: 5,
    libraryReconnectInitialMs: 1000,
    libraryReconnectMaxMs: 30000,
    libraryChangeDebounceMs: 150,
    galleryPollIntervalMs: 5000,
    libraryPollIntervalMs: 10000,
    libraryPointerIdleMs: 2500,
  });
  expect(DEFAULT_CLIENT_POLICY.cache).toMatchObject({
    sharedRecordLimit: 3000,
    referenceRecordLimit: 32,
    referenceMaxBytes: 256 * 1024 * 1024,
    sharedDetailRecordLimit: 64,
    sharedDetailMaxBytes: 16 * 1024 * 1024,
    sharedPageManifestLimit: 64,
    sharedPageMaxBytes: 8 * 1024 * 1024,
  });
  for (const [section, fields] of Object.entries(sharedDefaults))
    expect(
      Object.keys(DEFAULT_CLIENT_POLICY[section]).length,
    ).toBeGreaterThanOrEqual(Object.keys(fields).length);
});

test('the capabilities fixtures normalize to the defaults or to their published budgets', () => {
  expect(m5.shared.client_policy).toBeTruthy();
  for (const name of ['shared', 'browser_private'])
    expect(normalizeClientPolicy(m5[name].client_policy)).toEqual(
      DEFAULT_CLIENT_POLICY,
    );
  const small = normalizeClientPolicy(m5.small_budgets.client_policy);
  expect(small.controls.debounceMs).toBe(
    m5.small_budgets.client_policy.controls.debounce_ms,
  );
  expect(small.controls.debounceMs).not.toBe(
    DEFAULT_CLIENT_POLICY.controls.debounceMs,
  );
});

test('published values override defaults; invalid or missing ones do not', () => {
  const policy = normalizeClientPolicy({
    controls: {
      debounce_ms: 400,
      similarity_minimum_ratio: 4,
      max_attempts: 1.5,
    },
    transport: {
      library_poll_interval_ms: 'soon',
      gallery_poll_interval_ms: 2500,
    },
    cache: null,
  });
  expect(policy.controls.debounceMs).toBe(400);
  expect(policy.controls.similarityMinimumRatio).toBe(0.5);
  expect(policy.controls.maxAttempts).toBe(2);
  expect(policy.transport.libraryPollIntervalMs).toBe(10000);
  expect(policy.transport.galleryPollIntervalMs).toBe(2500);
  expect(policy.cache).toEqual(DEFAULT_CLIENT_POLICY.cache);
  expect(normalizeClientPolicy('nonsense')).toEqual(DEFAULT_CLIENT_POLICY);
  expect(normalizeClientPolicy(null)).toEqual(DEFAULT_CLIENT_POLICY);
});

test('zero is an intentional similarity threshold supported by the server', () => {
  expect(
    normalizeClientPolicy({ controls: { similarity_minimum_ratio: 0 } })
      .controls.similarityMinimumRatio,
  ).toBe(0);
});

test('the published reveal hold is used; zero or invalid falls back to the shared value', () => {
  const hold = (value) =>
    normalizeClientPolicy({ controls: { reveal_hold_ms: value } }).controls
      .revealHoldMs;
  expect(hold(3500)).toBe(3500);
  for (const bad of [0, -1, 'long', null, Number.NaN])
    expect(hold(bad)).toBe(sharedDefaults.controls.reveal_hold_ms);
  expect(DEFAULT_CLIENT_POLICY.controls.revealHoldMs).toBe(
    sharedDefaults.controls.reveal_hold_ms,
  );
});

test('the volatile private pool budgets come from the shared document', () => {
  const { cache } = DEFAULT_CLIENT_POLICY;
  expect(cache.privateVolatileRecordLimit).toBe(
    sharedDefaults.cache.private_volatile_record_limit,
  );
  expect(cache.privateVolatileMaxBytes).toBe(
    sharedDefaults.cache.private_volatile_max_bytes,
  );
  const published = (cacheFields) =>
    normalizeClientPolicy({ cache: cacheFields }).cache;
  expect(
    published({
      private_volatile_record_limit: 3,
      private_volatile_max_bytes: 1024,
    }),
  ).toMatchObject({
    privateVolatileRecordLimit: 3,
    privateVolatileMaxBytes: 1024,
  });
  for (const bad of [0, -1, 1.5, 'x', null, Number.NaN]) {
    const effective = published({
      private_volatile_record_limit: bad,
      private_volatile_max_bytes: bad,
    });
    expect(effective.privateVolatileRecordLimit).toBe(
      sharedDefaults.cache.private_volatile_record_limit,
    );
    expect(effective.privateVolatileMaxBytes).toBe(
      sharedDefaults.cache.private_volatile_max_bytes,
    );
  }
});

test('reference budgets accept exact positive integers and refuse unsafe or fractional values', () => {
  const chosen = normalizeClientPolicy({
    cache: { reference_record_limit: 7, reference_max_bytes: 4096 },
  });
  expect(chosen.cache.referenceRecordLimit).toBe(7);
  expect(chosen.cache.referenceMaxBytes).toBe(4096);
  const fallback = normalizeClientPolicy({
    cache: { reference_record_limit: 1.5, reference_max_bytes: 2 ** 53 },
  });
  expect(fallback.cache.referenceRecordLimit).toBe(
    DEFAULT_CLIENT_POLICY.cache.referenceRecordLimit,
  );
  expect(fallback.cache.referenceMaxBytes).toBe(
    DEFAULT_CLIENT_POLICY.cache.referenceMaxBytes,
  );
});
