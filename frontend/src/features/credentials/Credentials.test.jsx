import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import CredentialsPanel from './Credentials.jsx';
import { CREDENTIAL_STATE } from './credentials.js';
import { libraryRecord } from '../../../tests/helpers/testSupport.js';
import {
  OriginalUnavailableError,
  readOriginalBytes,
} from '../../data/media/originalBytes.js';
import { useOriginalDownload } from '../results/useOriginalDownload.js';

afterEach(cleanup);

const bytes = (n = 4) => new Blob([new Uint8Array(n)], { type: 'image/png' });
const shared = libraryRecord({ id: 'shared' });
const local = libraryRecord({
  id: 'mine',
  storage_type: 'browser-upload',
  image_url: 'blob:local',
});

function inspectorOf(inspect) {
  const made = [];
  const create = () => {
    const inspector = { inspect: vi.fn(inspect), dispose: vi.fn() };
    made.push(inspector);
    return inspector;
  };
  return { create, made };
}

const result = (state, extra = {}) => ({
  state,
  label: state,
  store: { validation_state: state, nested: { deep: 1 } },
  summary: {
    title: null,
    signer: 'Test Signer',
    issuer: null,
    algorithm: null,
    signedAt: null,
    generators: [],
    assertions: 1,
    manifests: 1,
    issues: [{ code: 'signingCredential.untrusted', explanation: 'x' }],
  },
  ...extra,
});

function panel(inspect, props = {}) {
  const inspectors = inspectorOf(inspect);
  const fetchBlob = props.fetchBlob ?? vi.fn(async () => bytes());
  const view = render(
    <CredentialsPanel
      image={props.image ?? shared}
      createInspector={inspectors.create}
      fetchBlob={fetchBlob}
      {...props.extra}
    />,
  );
  return { ...inspectors, fetchBlob, view };
}

const open = () =>
  fireEvent.click(screen.getByRole('button', { name: /Content Credentials/ }));

test('nothing is read or loaded until the disclosure is opened', () => {
  const { made, fetchBlob } = panel(async () => result('valid'));
  expect(made).toHaveLength(0);
  expect(fetchBlob).not.toHaveBeenCalled();
});

test('opening reads the original file and shows the SDK state', async () => {
  const { made, fetchBlob } = panel(async () => result(CREDENTIAL_STATE.VALID));
  open();
  await screen.findByText('Test Signer');
  expect(fetchBlob).toHaveBeenCalledWith(
    '/api/images/library/file/local-0/shared.png',
    expect.anything(),
  );
  expect(made).toHaveLength(1);
  expect(made[0].dispose).toHaveBeenCalled();
  expect(screen.getByText('signingCredential.untrusted')).toBeTruthy();
  expect(screen.getAllByText('Manifest data').length).toBeGreaterThan(0);
});

test('absent credentials are reported as absent', async () => {
  panel(async () => ({
    state: CREDENTIAL_STATE.ABSENT,
    label: 'No credentials',
    store: null,
    summary: null,
  }));
  open();
  await screen.findByText('No Content Credentials in the original file.');
});

test('a failed read is an error with retry, never absence', async () => {
  let fail = true;
  const { made } = panel(async () => {
    if (fail) throw new Error('corrupt file');
    return result(CREDENTIAL_STATE.INVALID);
  });
  open();
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('corrupt file');
  expect(screen.queryByText(/No Content Credentials/)).toBeNull();
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByText('Test Signer');
  expect(made).toHaveLength(2);
  expect(made.every((i) => i.dispose.mock.calls.length > 0)).toBe(true);
});

test('a missing original is an honest error and the SDK is not started', async () => {
  const fetchBlob = vi.fn(async () => {
    throw new Error('The API is unreachable.');
  });
  const { made } = panel(async () => result('valid'), { fetchBlob });
  open();
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('The API is unreachable.');
  expect(made[0].inspect).not.toHaveBeenCalled();
});

test('cancel ends the worker and a late result is dropped', async () => {
  let finish;
  const { made } = panel(
    () => new Promise((resolve) => (finish = () => resolve(result('valid')))),
  );
  open();
  await waitFor(() => expect(made[0]?.inspect).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(made[0].dispose).toHaveBeenCalled();
  await act(async () => finish());
  expect(screen.queryByText('Test Signer')).toBeNull();
  expect(screen.getByRole('button', { name: 'Read credentials' })).toBeTruthy();
});

test('unmounting mid-read aborts it and releases the worker', async () => {
  let signal;
  const { made, view } = panel(
    (_blob, options) =>
      new Promise(() => {
        signal = options.signal;
      }),
  );
  open();
  await waitFor(() => expect(made[0]?.inspect).toHaveBeenCalled());
  view.unmount();
  expect(signal.aborted).toBe(true);
  expect(made[0].dispose).toHaveBeenCalled();
});

test('a browser-only image never uses a wire URL', async () => {
  const fetchBlob = vi.fn();
  const readLocal = vi.fn(async () => bytes());
  panel(async () => result('valid'), {
    image: local,
    fetchBlob,
    extra: { readLocal },
  });
  open();
  await screen.findByText('Test Signer');
  expect(readLocal).toHaveBeenCalled();
  expect(fetchBlob).not.toHaveBeenCalled();
});

test('missing local bytes is reported, not fetched', async () => {
  const fetchBlob = vi.fn();
  panel(async () => result('valid'), {
    image: local,
    fetchBlob,
    extra: { readLocal: async () => null },
  });
  open();
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('not stored in this browser');
  expect(fetchBlob).not.toHaveBeenCalled();
});

test('original bytes prefer the cached original, then the file route', async () => {
  const cached = bytes(9);
  const media = { blob: vi.fn(async () => cached) };
  const fetchBlob = vi.fn();
  expect(await readOriginalBytes(shared, { media, fetchBlob })).toBe(cached);
  expect(fetchBlob).not.toHaveBeenCalled();
  const miss = { blob: vi.fn(async () => null) };
  const wire = bytes(5);
  fetchBlob.mockResolvedValue(wire);
  expect(await readOriginalBytes(shared, { media: miss, fetchBlob })).toBe(
    wire,
  );
  fetchBlob.mockResolvedValue(new Blob([]));
  await expect(
    readOriginalBytes(shared, { media: miss, fetchBlob }),
  ).rejects.toBeInstanceOf(OriginalUnavailableError);
  const controller = new AbortController();
  controller.abort();
  await expect(
    readOriginalBytes(shared, { signal: controller.signal, fetchBlob }),
  ).rejects.toMatchObject({ name: 'AbortError' });
});

test('download saves the exact bytes under the file name and reports failure', async () => {
  const exact = bytes(7);
  const fetchBlob = vi
    .fn()
    .mockRejectedValueOnce(new Error('The API is unreachable.'))
    .mockResolvedValue(exact);
  const save = vi.fn();
  const hook = renderHook(() =>
    useOriginalDownload(shared, 'name.png', { fetchBlob, save }),
  );
  await act(() => hook.result.current.download());
  expect(hook.result.current.error.message).toBe('The API is unreachable.');
  expect(save).not.toHaveBeenCalled();
  await act(() => hook.result.current.download());
  expect(save).toHaveBeenCalledWith(exact, 'name.png');
  expect(save.mock.calls[0][0]).toBe(exact);
  expect(hook.result.current.error).toBeNull();
});

test('leaving the download owner cancels a read in progress', async () => {
  let signal;
  const save = vi.fn();
  const fetchBlob = vi.fn(
    (_url, options) =>
      new Promise(() => {
        signal = options.signal;
      }),
  );
  const hook = renderHook(() =>
    useOriginalDownload(shared, 'a.png', { fetchBlob, save }),
  );
  act(() => {
    hook.result.current.download();
  });
  await waitFor(() => expect(fetchBlob).toHaveBeenCalled());
  hook.unmount();
  expect(signal.aborted).toBe(true);
  expect(save).not.toHaveBeenCalled();
});
