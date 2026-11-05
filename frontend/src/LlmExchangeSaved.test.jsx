import React from 'react';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import Viewer from './Viewer.jsx';

vi.mock('./ui.jsx', async (original) => ({
  ...(await original()),
  SavedImg: ({ image, className }) => (
    <img className={className} alt={image.alt_text} />
  ),
}));

const reply = { categories: { range: { id: 'generated_range_wing' } } };
const saved = {
  id: 'saved-one',
  image_id: 'saved-one',
  storage_id: 'local',
  filename: 'one.png',
  title: 'A quiet shore',
  alt_text: 'A quiet shore',
  provider: 'mock',
  width: 384,
  height: 256,
};
const withEvidence = {
  ...saved,
  dynamic_controls_metadata: {
    provider: 'openai-compatible',
    model: 'm-1',
    prompt: JSON.stringify([
      { role: 'system', content: 'Return JSON.' },
      { role: 'user', content: '{"idea":"shore"}' },
    ]),
    raw_response: JSON.stringify(reply),
    response: reply,
  },
};
const studio = (current) => ({
  job: null,
  generating: null,
  current,
  draft: { aspect: '3:2', mode: 'image', prompt: 'A quiet shore' },
  discovery: { capabilities: { data: {} }, models: { data: {} } },
  watermark: { visible: false, settings: null },
  references: { refs: [] },
});
afterEach(cleanup);

async function openMenuItem(name) {
  const trigger = screen.getByRole('button', { name: 'More actions' });
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole('menuitem', { name }));
  return trigger;
}

test('a saved result offers its retained exchange from the existing More menu', async () => {
  render(<Viewer studio={studio(withEvidence)} onEdit={() => {}} />);
  const trigger = await openMenuItem(/Request and response/);
  const modal = screen.getByRole('dialog', {
    name: 'Controls request and response',
  });
  expect(within(modal).getByText('Initial controls')).toBeTruthy();
  fireEvent.click(within(modal).getAllByRole('button', { name: 'Raw' }).at(-1));
  expect(within(modal).getByLabelText('Raw reply text').textContent).toBe(
    withEvidence.dynamic_controls_metadata.raw_response,
  );
  fireEvent.keyDown(modal, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

test('a result whose generated controls kept no exchange says it was not saved', async () => {
  const legacy = {
    ...saved,
    selected_controls: [
      {
        id: 'a',
        kind: 'text-input',
        label: 'A',
        value: 'x',
        origin: 'generated',
      },
    ],
  };
  render(<Viewer studio={studio(legacy)} onEdit={() => {}} />);
  const item = await (async () => {
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    return screen.findByRole('menuitem', { name: /Request and response/ });
  })();
  expect(item.textContent).toContain('Not saved');
  fireEvent.click(item);
  expect(
    screen.getByText('No request or reply was saved with this image.'),
  ).toBeTruthy();
});

test('a result with no generated controls offers nothing', () => {
  render(<Viewer studio={studio(saved)} onEdit={() => {}} />);
  expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
});
