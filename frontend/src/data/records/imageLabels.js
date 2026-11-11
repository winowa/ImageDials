import { formatMoment } from '../../shared/browser/formatMoment.js';
import { describeImage } from './imageRecord.js';

/** When an image was saved, from its normalized view data. */
export const formatSaved = (image) =>
  formatMoment(describeImage(image).createdAtMs);

export const providerLabel = (value) =>
  value === 'mock' ? 'Mock (not real inference)' : (value ?? 'unknown');
