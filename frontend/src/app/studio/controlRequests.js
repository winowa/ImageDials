import { api } from '../../data/api/api.js';
import { providerRequest } from '../../data/api/providerSettings.js';
import { preserveError } from '../../shared/diagnostics/diagnostics.js';

const RETRYABLE_STATUSES = new Set([500, 502, 504]);

const isRetryable = (error) =>
  error.network || RETRYABLE_STATUSES.has(error.status);
export const aborted = (error) => error?.name === 'AbortError';

export async function fetchDynamicControls(body, signal, maxAttempts, header) {
  // Each failed attempt keeps the exchange the server returned for it.
  const attempts = [];
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await api.dynamicControls(body, {
        ...providerRequest(header),
        signal,
      });
    } catch (error) {
      if (aborted(error)) throw error;
      if (error?.evidence) attempts.push(error.evidence);
      if (!isRetryable(error) || attempt >= maxAttempts) {
        if (attempts.length && error && typeof error === 'object')
          error.attempts = attempts;
        throw error;
      }
    }
  }
}

export const failureNotice = (text, error) => ({
  tone: 'error',
  text,
  error: preserveError(error),
  details: error?.details ?? null,
});
