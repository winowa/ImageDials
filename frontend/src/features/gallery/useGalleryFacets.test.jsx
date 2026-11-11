import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';

import { useGalleryFacets } from './useGalleryFacets.js';
import {
  fakeLibrary,
  installApi,
  libraryRecord,
} from '../../../tests/helpers/testSupport.js';

afterEach(() => cleanup());

test('a selected event reports that event total and shape counts', async () => {
  const records = [
    libraryRecord({
      id: 'spring-1',
      event_id: 'spring',
      width: 300,
      height: 200,
      dimensions: { width: 300, height: 200 },
    }),
    libraryRecord({
      id: 'autumn-1',
      event_id: 'autumn',
      width: 300,
      height: 200,
      dimensions: { width: 300, height: 200 },
    }),
    libraryRecord({
      id: 'autumn-2',
      event_id: 'autumn',
      width: 200,
      height: 300,
      dimensions: { width: 200, height: 300 },
    }),
  ];
  const library = fakeLibrary(records);
  library.configured = ['spring', 'autumn'];
  const { calls } = installApi(library.routes);

  const { result } = renderHook(() =>
    useGalleryFacets({
      active: true,
      events: {
        active_event_name: 'spring',
        gallery_event_names: ['spring', 'autumn'],
      },
      storedEvent: 'autumn',
      changeTick: 0,
    }),
  );

  await waitFor(() => expect(result.current.settled).toBe(true));
  expect(result.current.total).toBe(2);
  expect(result.current.counts).toEqual({
    landscape: 1,
    portrait: 1,
    square: 0,
    unknown: 0,
  });
  expect(calls.some((call) => call.key === 'GET /api/images/library')).toBe(
    false,
  );
});
