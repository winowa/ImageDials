import React from 'react';
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

import { useLibrary } from './library.js';
import {
  fakeLibrary,
  installApi,
  libraryRecord,
  respond,
} from '../../../tests/helpers/testSupport.js';
import { DeleteConfirm } from './DeleteConfirm.jsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('failed deletion returns its original string, retains the image, and connects HTTP details', async () => {
  const image = libraryRecord();
  const body = ' {"detail":"Delete refused", "api_key":"fixture-private"}\n';
  installApi({
    ...fakeLibrary([image]).routes,
    'DELETE /api/images/library': () =>
      respond(503, body, { 'X-Request-ID': 'delete-fixture' }),
  });
  const hook = renderHook(() => useLibrary());
  await waitFor(() => expect(hook.result.current.images.status).toBe('ready'));
  let failure;
  await act(async () => {
    failure = await hook.result.current.remove(image);
  });
  expect(failure).toBe('Delete refused');
  expect(hook.result.current.images.items).toHaveLength(1);
  const diagnostic = hook.result.current.images.removeErrorDetail.diagnostic;
  render(
    <DeleteConfirm
      image={image}
      error={failure}
      diagnostic={diagnostic}
      busy={false}
      onConfirm={() => {}}
      onCancel={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Error details' }));
  expect(screen.getByRole('dialog').textContent).toContain('503');
  expect(screen.getByRole('dialog').textContent).toContain('delete-fixture');
  fireEvent.click(screen.getByRole('button', { name: 'Raw', exact: true }));
  expect(screen.getByLabelText('Response body text').textContent).toBe(
    ' {"detail":"Delete refused", "api_key":"[redacted]"}\n',
  );
  expect(document.body.textContent).not.toContain('fixture-private');
});
