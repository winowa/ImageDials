import { expect, test } from 'vitest';

import {
  editTarget,
  hrefFor,
  normalizeBase,
  parseLocation,
  recordIdForEditTarget,
  resolveEditLink,
  ROUTE,
} from './routes.js';

test.each([
  ['example-id', 'example-id'],
  ['local-0/example-id.png', 'example-id'],
  ['local-0/../example-id.png', null],
  ['other-store/example-id.png', null],
  ['', null],
])('edit target %s resolves to exact record id %s', (target, expected) => {
  expect(recordIdForEditTarget(target)).toBe(expected);
});

test.each([
  ['/', ''],
  ['', ''],
  ['./', ''],
  ['/studio/', '/studio'],
  ['/studio/v1/', '/studio/v1'],
])('base URL %s is the prefix %s', (input, expected) => {
  expect(normalizeBase(input)).toBe(expected);
});

test('routes resolve at the origin root and inside a prefix', () => {
  const at = (pathname, base = '') => parseLocation({ pathname }, base).route;
  expect(at('/')).toBe(ROUTE.create);
  expect(at('/gallery')).toBe(ROUTE.gallery);
  expect(at('/print/')).toBe(ROUTE.library);
  expect(at('/studio', '/studio')).toBe(ROUTE.create);
  expect(at('/studio/', '/studio')).toBe(ROUTE.create);
  expect(at('/studio/gallery', '/studio')).toBe(ROUTE.gallery);
  expect(at('/studio/v1/print/', '/studio/v1')).toBe(ROUTE.library);
});

test('unknown routes and paths outside the prefix show the generator', () => {
  const at = (pathname, base = '') => parseLocation({ pathname }, base).route;
  expect(at('/nothing')).toBe(ROUTE.create);
  expect(at('/studio/nothing', '/studio')).toBe(ROUTE.create);
  expect(at('/gallery', '/studio')).toBe(ROUTE.create);
  expect(at('/studiogallery', '/studio')).toBe(ROUTE.create);
  expect(at('/studio/gallery/extra', '/studio')).toBe(ROUTE.create);
});

test('hrefs stay inside the prefix', () => {
  expect(hrefFor(ROUTE.create, '')).toBe('/');
  expect(hrefFor(ROUTE.gallery, '')).toBe('/gallery');
  expect(hrefFor(ROUTE.create, '/studio')).toBe('/studio/');
  expect(hrefFor(ROUTE.library, '/studio')).toBe('/studio/print');
});

test('an edit target is encoded safely and read back exactly', () => {
  const awkward = 'local-0/a b&c=d?#é.png';
  const href = hrefFor(ROUTE.create, '/studio', { edit: awkward });
  expect(href).toBe(`/studio/?edit=${encodeURIComponent(awkward)}`);
  const url = new URL(href, 'http://localhost');
  expect(parseLocation(url, '/studio').edit).toBe(awkward);
});

test('an edit target belongs to the generator only', () => {
  expect(hrefFor(ROUTE.gallery, '', { edit: 'x' })).toBe('/gallery');
  expect(parseLocation({ pathname: '/gallery', search: '?edit=x' }).edit).toBe(
    null,
  );
  expect(parseLocation({ pathname: '/', search: '?edit=' }).edit).toBe(null);
  expect(parseLocation({ pathname: '/unknown', search: '?edit=x' }).edit).toBe(
    'x',
  );
});

test('the edit target is the image id, else the storage identity, never a title', () => {
  expect(editTarget({ image_id: 'abc', id: 'z', title: 'T' })).toBe('abc');
  expect(editTarget({ storage_id: 'local-0', filename: 'a.png' })).toBe(
    'local-0/a.png',
  );
  expect(editTarget({ id: 7 })).toBe('7');
});

const items = [
  { id: 'pending', client_pending: { phase: 'running' }, client_key: 'job:1' },
  { image_id: 'one', storage_id: 's', filename: 'one.png', title: 'Same' },
  { image_id: 'two', storage_id: 's', filename: 'two.png', title: 'Same' },
  { id: 'up-1', storage_type: 'browser-upload', client_key: 'local:up-1' },
];

test('an edit link waits for loaded lists and never guesses', () => {
  const base = { target: 'two', items, draftChanged: false };
  expect(resolveEditLink({ ...base, ready: false })).toEqual({
    action: 'wait',
  });
  const hit = resolveEditLink({ ...base, ready: true });
  expect(hit).toEqual({ action: 'restore', item: items[2] });
  expect(resolveEditLink({ ...base, target: 'same', ready: true }).action).toBe(
    'missing',
  );
  expect(
    resolveEditLink({ ...base, target: 'pending', ready: true }).action,
  ).toBe('missing');
});

test('stored identity and local items resolve exactly; a changed draft is kept', () => {
  const ready = { items, ready: true, draftChanged: false };
  expect(resolveEditLink({ ...ready, target: 's/one.png' }).item).toBe(
    items[1],
  );
  expect(resolveEditLink({ ...ready, target: 'local:up-1' }).item).toBe(
    items[3],
  );
  expect(resolveEditLink({ ...ready, target: 'up-1' }).item).toBe(items[3]);
  expect(
    resolveEditLink({ ...ready, target: 'two', draftChanged: true }).action,
  ).toBe('skip');
});
