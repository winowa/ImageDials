import privateGeneration from '../../../../fixtures/api/private-generation.json';

import { expect, test } from 'vitest';

import {
  classifyOrientation,
  describeImage,
  imageKey,
  originalUrl,
  readCreatedAtMs,
  readDimensions,
  thumbnailUrl,
} from './imageRecord.js';
import {
  clone,
  fixtures,
  libraryRecord,
} from '../../../tests/helpers/testSupport.js';

test('library records normalize seconds and dimensions without altering the record', () => {
  const record = libraryRecord();
  const snapshot = clone(record);
  const view = describeImage(record);
  expect(view.size).toEqual({ width: 768, height: 1152 });
  expect(view.requestedSize).toEqual({ width: 768, height: 1152 });
  expect(view.createdAtMs).toBeCloseTo(1793502714715.372, 0);
  expect(view.orientation).toBe('portrait');
  expect(view.originalPrompt).toBe(
    'An amber glass bird on a small wooden stand',
  );
  expect(record).toEqual(snapshot);
});

test('a completed job result with a WxH string reads the same size', () => {
  const result = fixtures.m1.job_complete.result;
  expect(readDimensions(result.dimensions)).toEqual({
    width: 768,
    height: 1152,
  });
  expect(describeImage(clone(result)).size).toEqual({
    width: 768,
    height: 1152,
  });
});

test('unusable dimensions and dates are unknown, not guessed', () => {
  expect(readDimensions({ width: 0, height: 10 })).toBeNull();
  expect(readDimensions('768by1152')).toBeNull();
  expect(readDimensions(null)).toBeNull();
  expect(readCreatedAtMs(null)).toBeNull();
  expect(readCreatedAtMs('not a date')).toBeNull();
  expect(readCreatedAtMs('2026-01-01T00:00:00Z')).toBe(1767225600000);
  const bare = { id: 'x', title: '' };
  expect(describeImage(bare)).toMatchObject({
    size: null,
    createdAtMs: null,
    title: 'Untitled',
  });
});

test('orientation: 5% of the longer side is square; a missing size is unknown', () => {
  const size = (width, height) => ({ width, height });
  expect(classifyOrientation(size(1000, 1000))).toBe('square');
  expect(classifyOrientation(size(1000, 950))).toBe('square');
  expect(classifyOrientation(size(950, 1000))).toBe('square');
  expect(classifyOrientation(size(1000, 949))).toBe('landscape');
  expect(classifyOrientation(size(949, 1000))).toBe('portrait');
  expect(classifyOrientation(null)).toBe('unknown');
  expect(describeImage({ id: 'bare' }).orientation).toBe('unknown');
});

test('identity is the storage location; urls use the canonical file route', () => {
  const record = libraryRecord({ id: 'a b', filename: 'a_b.png' });
  expect(imageKey(record)).toBe('local-0/a_b.png');
  expect(originalUrl(record)).toBe('/api/images/library/file/local-0/a_b.png');
  expect(thumbnailUrl(record)).toBe(
    '/api/images/library/file/local-0/a_b.png?variant=thumbnail&max_size=384',
  );
  // Without a storage location the record's own url and id are all there is.
  const legacy = { id: 'old', image_url: '/api/images/old/content' };
  expect(imageKey(legacy)).toBe('old');
  expect(originalUrl(legacy)).toBe('/api/images/old/content');
  expect(thumbnailUrl(legacy)).toBe('/api/images/old/content');
});

test('a browser upload uses its object URL and never a server file route', () => {
  const upload = libraryRecord({
    storage_id: 'dropped-image',
    storage_type: 'browser-upload',
    image_url: 'blob:local-preview',
  });
  expect(originalUrl(upload)).toBe('blob:local-preview');
  expect(thumbnailUrl(upload)).toBe('blob:local-preview');
  expect(describeImage(upload).originalUrl).not.toContain('/api/');
});

test('two records with the same id in different storage are different images', () => {
  const a = libraryRecord({ storage_id: 'local-0' });
  const b = libraryRecord({ storage_id: 'local-1' });
  expect(imageKey(a)).not.toBe(imageKey(b));
});

test('a private job result uses its readable original URL rather than forbidden shared media', () => {
  const record = privateGeneration.complete_poll.result;
  expect(record.visibility).toBe('private');
  expect(record.storage_id).toBeTruthy();
  expect(record.filename).toBeTruthy();
  expect(originalUrl(record)).toBe(record.image_url);
  expect(thumbnailUrl(record)).toBe(record.image_url);
  expect(describeImage(record).originalUrl).toBe(record.image_url);
});
