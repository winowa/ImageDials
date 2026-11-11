/**
 * The one place that turns the shared client budgets into camel-case values.
 * The server publishes the same document as `capabilities.client_policy`; any
 * value that is missing or invalid there falls back to the shared default.
 */
import sharedDefaults from '../../../../shared/client-policy.json';

const positive = (value) => Number.isFinite(value) && value > 0;
const wholeCount = (value) => Number.isInteger(value) && value > 0;
const wholeBytes = (value) => Number.isSafeInteger(value) && value > 0;
const unitRatio = (value) => Number.isFinite(value) && value >= 0 && value <= 1;

/** section -> client name -> [wire name, validity check] */
const SHAPE = {
  controls: {
    debounceMs: ['debounce_ms', positive],
    resetDebounceMs: ['reset_debounce_ms', positive],
    revealHoldMs: ['reveal_hold_ms', positive],
    similarityMinimumRatio: ['similarity_minimum_ratio', unitRatio],
    maxAttempts: ['max_attempts', wholeCount],
  },
  transport: {
    jobPollIntervalMs: ['job_poll_interval_ms', positive],
    jobPollMaxFailures: ['job_poll_max_failures', wholeCount],
    libraryReconnectInitialMs: ['library_reconnect_initial_ms', positive],
    libraryReconnectMaxMs: ['library_reconnect_max_ms', positive],
    libraryChangeDebounceMs: ['library_change_debounce_ms', positive],
    galleryPollIntervalMs: ['gallery_poll_interval_ms', positive],
    libraryPollIntervalMs: ['library_poll_interval_ms', positive],
    libraryPointerIdleMs: ['library_pointer_idle_ms', positive],
  },
  cache: {
    sharedRecordLimit: ['shared_record_limit', wholeCount],
    sharedVariantLimit: ['shared_variant_limit', wholeCount],
    sharedVariantMaxBytes: ['shared_variant_max_bytes', positive],
    sharedDetailRecordLimit: ['shared_detail_record_limit', wholeCount],
    sharedDetailMaxBytes: ['shared_detail_max_bytes', wholeBytes],
    sharedPageManifestLimit: ['shared_page_manifest_limit', wholeCount],
    sharedPageMaxBytes: ['shared_page_max_bytes', wholeBytes],
    referenceRecordLimit: ['reference_record_limit', wholeCount],
    referenceMaxBytes: ['reference_max_bytes', wholeBytes],
    privateRecordLimit: ['private_record_limit', wholeCount],
    privateMaxBytes: ['private_max_bytes', positive],
    privateVolatileRecordLimit: ['private_volatile_record_limit', wholeCount],
    privateVolatileMaxBytes: ['private_volatile_max_bytes', wholeBytes],
  },
  gallery: {
    newImageHoldMs: ['new_image_hold_ms', positive],
    filmstripInitialCount: ['filmstrip_initial_count', wholeCount],
    filmstripBatchCount: ['filmstrip_batch_count', wholeCount],
  },
};

/**
 * @param {object} [published] `capabilities.client_policy` (any part may be absent)
 * @returns the effective policy; never throws on unexpected input
 */
export function normalizeClientPolicy(published) {
  const policy = {};
  for (const [section, fields] of Object.entries(SHAPE)) {
    policy[section] = {};
    for (const [name, [wire, valid]] of Object.entries(fields)) {
      const offered = published?.[section]?.[wire];
      policy[section][name] = valid(offered)
        ? offered
        : sharedDefaults[section][wire];
    }
  }
  return policy;
}

/** Safe defaults used until capabilities are available. */
export const DEFAULT_CLIENT_POLICY = normalizeClientPolicy();

/**
 * Section-wise camel-case overrides on a normalized policy (tests and
 * embedders). Unknown names are kept, so a typo is visible rather than ignored.
 */
export function withOverrides(policy, overrides) {
  if (!overrides) return policy;
  return Object.fromEntries(
    Object.entries(policy).map(([section, values]) => [
      section,
      { ...values, ...overrides[section] },
    ]),
  );
}
