import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import RegionEditor from './RegionEditor.jsx';
import KeptReferencesDialog from './KeptReferences.jsx';
import ImageComparison from './ImageComparison.jsx';
import { attachDiagnostic, networkDiagnostic } from './diagnostics.js';
import { ApiError } from './api.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test('region refusal shows local evidence and does not invent an HTTP response', () => {
  render(
    <RegionEditor
      base={null}
      capability={null}
      onApply={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Region editing availability details' }),
  );
  expect(screen.getByText('region-validation')).toBeTruthy();
  expect(screen.queryByText('HTTP status')).toBeNull();
  expect(
    screen.getAllByText('This server does not offer region editing.').length,
  ).toBeGreaterThan(0);
});

test('missing kept preview is local and its diagnostic remains dismissible', async () => {
  const retained = {
    items: [
      { sha256: 'a'.repeat(64), revision: 1, name: 'reference.png', bytes: 10 },
    ],
    attached: new Set(),
    status: 'ready',
    usage: null,
    load: vi.fn(async () => null),
    pick: vi.fn(),
    remove: vi.fn(),
  };
  render(<KeptReferencesDialog retained={retained} onClose={vi.fn()} />);
  fireEvent.click(
    screen.getByRole('button', { name: 'reference.png, preview' }),
  );
  const details = await screen.findByRole('button', {
    name: 'Kept file preview details',
  });
  fireEvent.click(details);
  expect(
    screen.getAllByText('This file is no longer kept.').length,
  ).toBeGreaterThan(0);
  expect(screen.queryByText('HTTP status')).toBeNull();
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() =>
    expect(
      screen.queryByRole('dialog', { name: 'Kept file preview details' }),
    ).toBeNull(),
  );
});

test('comparison keeps the original network failure and has no fabricated status', async () => {
  const error = attachDiagnostic(
    new ApiError('Connection unavailable', { network: true }),
    networkDiagnostic({
      method: 'GET',
      path: '/api/files/example.png',
      cause: new Error('offline'),
    }),
  );
  render(
    <ImageComparison
      image={{ id: 'result', width: 16, height: 12, alt_text: 'Result' }}
      sources={[
        {
          id: 'reference',
          name: 'source.png',
          dimensions: { width: 16, height: 12 },
          blob: null,
          load: async () => {
            throw error;
          },
        },
      ]}
      onClose={vi.fn()}
    />,
  );
  const details = await screen.findByRole('button', {
    name: 'Comparison source error details',
  });
  fireEvent.click(details);
  expect(screen.getByText('No HTTP response was received.')).toBeTruthy();
  expect(screen.queryByText('HTTP status')).toBeNull();
  expect(screen.getByText('GET /api/files/example.png')).toBeTruthy();
});
