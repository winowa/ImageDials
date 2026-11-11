import { StrictMode } from 'react';
import { act, cleanup, fireEvent, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import {
  encodeProviderOverrides,
  PROVIDER_OVERRIDE_HEADER,
} from '../../data/api/api.js';
import { useSuggestions } from './suggestions.js';
import { fixtures, installApi } from '../../../tests/helpers/testSupport.js';

const STANDARD = 'GET /api/prompt-suggestions?generation_mode=standard';
const ASSET = 'GET /api/prompt-suggestions?generation_mode=trellis';
const paint = () => act(() => vi.advanceTimersByTimeAsync(40));
let visibility;

beforeEach(() => {
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(
    () => visibility,
  );
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'requestAnimationFrame',
      'cancelAnimationFrame',
    ],
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('post-paint warming starts once even under StrictMode', async () => {
  const api = installApi();
  const { result } = renderHook(() => useSuggestions('image', true), {
    wrapper: StrictMode,
  });
  expect(api.called(STANDARD)).toHaveLength(0);
  await act(async () => vi.advanceTimersToNextFrame());
  expect(api.called(STANDARD)).toHaveLength(0);
  await paint();
  expect(api.called(STANDARD)).toHaveLength(1);
  expect(result.current.items).toEqual(
    fixtures.m3.suggestions_standard.suggestions,
  );
  await paint();
  expect(api.called(STANDARD)).toHaveLength(1);
});

test('disabled and hidden pages wait, then warm once when visible', async () => {
  const api = installApi();
  const { rerender } = renderHook(
    ({ enabled }) => useSuggestions('image', enabled),
    { initialProps: { enabled: false } },
  );
  await paint();
  expect(api.called(STANDARD)).toHaveLength(0);
  visibility = 'hidden';
  fireEvent(document, new Event('visibilitychange'));
  rerender({ enabled: true });
  await paint();
  expect(api.called(STANDARD)).toHaveLength(0);
  visibility = 'visible';
  fireEvent(document, new Event('visibilitychange'));
  await paint();
  expect(api.called(STANDARD)).toHaveLength(1);
});

test('cached modes and providers do not trigger duplicate warming', async () => {
  const api = installApi();
  const first = {
    id: 'first',
    header: encodeProviderOverrides({ LLM_MODEL_NAME: 'first' }),
  };
  const second = {
    id: 'second',
    header: encodeProviderOverrides({ LLM_MODEL_NAME: 'second' }),
  };
  const { rerender } = renderHook(
    ({ mode, provider }) => useSuggestions(mode, true, provider),
    { initialProps: { mode: 'image', provider: first } },
  );
  await paint();
  rerender({ mode: 'asset-image', provider: first });
  await paint();
  rerender({ mode: 'image', provider: second });
  await paint();
  rerender({ mode: 'image', provider: first });
  await paint();
  expect(api.called(STANDARD)).toHaveLength(2);
  expect(api.called(ASSET)).toHaveLength(1);
  expect(api.called(STANDARD)[1].headers[PROVIDER_OVERRIDE_HEADER]).toBe(
    second.header,
  );
});

test('pending warming is reused and unmount cancels scheduled work', async () => {
  let release;
  const api = installApi({
    [STANDARD]: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const first = renderHook(() => useSuggestions('image', true));
  await paint();
  first.rerender();
  await paint();
  expect(api.called(STANDARD)).toHaveLength(1);
  await act(async () => release(fixtures.m3.suggestions_standard));
  expect(first.result.current.status).toBe('ready');
  first.unmount();
  const second = renderHook(() => useSuggestions('asset-image', true));
  second.unmount();
  await paint();
  expect(api.called(ASSET)).toHaveLength(0);
});
