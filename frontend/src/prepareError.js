import { diagnosticOf, localDiagnostic } from './diagnostics.js';

/** A prepare failure with the stage that produced it. */
export class PrepareError extends Error {
  /** @param {string} message @param {string} stage @param {unknown} [cause] */
  constructor(message, stage, cause) {
    super(message);
    this.name = 'PrepareError';
    this.stage = stage;
    this.cause = cause;
    this.details = cause?.details ?? null;
    this.diagnostic = cause
      ? diagnosticOf(cause)
      : localDiagnostic({
          category: 'render',
          reason: message,
          facts: { Stage: stage },
        });
    this.diagnostic = {
      ...this.diagnostic,
      facts: [...(this.diagnostic?.facts ?? []), ['Prepare stage', stage]],
    };
  }
}
