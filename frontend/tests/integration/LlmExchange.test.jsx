import React, { useLayoutEffect } from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import Create from '../../src/features/create/Create.jsx';
import { ExchangeDialog } from '../../src/features/results/LlmExchange.jsx';
import { describeExchange } from '../../src/features/results/llmExchange.js';
import { normalizeClientPolicy } from '../../src/data/api/clientPolicy.js';
import { useStudio } from '../../src/app/studio.js';
import { fakeLibrary, installApi, respond } from '../helpers/testSupport.js';

let current;
const dynamic = 'POST /api/controls/dynamic';
const messages = [
  { role: 'system', content: 'Instructions <img src=x onerror=alert(1)>' },
  { role: 'user', content: JSON.stringify({ idea: 'A barn owl' }) },
];
const reply = { categories: { range: { id: 'generated_range_wing' } } };
const evidence = (extra = {}) => ({
  prompt: JSON.stringify(messages),
  response: reply,
  raw_response: JSON.stringify(reply),
  response_format: { type: 'json_schema' },
  model: 'm-1',
  provider: 'openai-compatible',
  ...extra,
});
const failure = (extra = {}) =>
  evidence({
    status: 'failed',
    raw_response: '{"categories": {"range": ',
    response: undefined,
    failure: { reason: 'ValueError: Missing generated category slots' },
    ...extra,
  });

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function dialog(items, props = {}) {
  const onClose = vi.fn();
  render(
    <ExchangeDialog
      exchanges={items}
      title="Controls request and response"
      onClose={onClose}
      {...props}
    />,
  );
  return onClose;
}

test('renders stored text as text, never as markup', () => {
  dialog([
    describeExchange(evidence(), { id: 'a', title: 'Initial controls' }),
  ]);
  const modal = screen.getByRole('dialog', {
    name: 'Controls request and response',
  });
  expect(modal.getAttribute('aria-modal')).toBe('true');
  const system = within(modal).getByLabelText('System message text');
  expect(system.textContent).toBe(messages[0].content);
  expect(modal.querySelector('img')).toBeNull();
});

test('system instructions start closed and the reply is formatted JSON with a raw view', () => {
  dialog([
    describeExchange(evidence(), { id: 'a', title: 'Initial controls' }),
  ]);
  expect(
    screen
      .getByRole('button', { name: /^System message/ })
      .getAttribute('aria-expanded'),
  ).toBe('false');
  expect(
    screen
      .getByRole('button', { name: /^Raw reply/ })
      .getAttribute('aria-expanded'),
  ).toBe('true');
  // The formatted tree collapses and expands like the other JSON views.
  const tree = [...document.querySelectorAll('.json-tree')].at(-1);
  expect(within(tree).getByText(/"categories"/)).toBeTruthy();
  fireEvent.click(within(tree).getByRole('button', { name: 'root collapse' }));
  expect(within(tree).queryByText(/"categories"/)).toBeNull();
  const raw = screen.getAllByRole('button', { name: 'Raw' }).at(-1);
  fireEvent.click(raw);
  expect(raw.getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByLabelText('Raw reply text').textContent).toBe(
    evidence().raw_response,
  );
});

test('copies exactly the stored text and reports an unavailable clipboard', async () => {
  const writeText = vi.fn().mockResolvedValue();
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  dialog([
    describeExchange(evidence(), { id: 'a', title: 'Initial controls' }),
  ]);
  fireEvent.click(screen.getByRole('button', { name: 'Copy Raw reply' }));
  await waitFor(() =>
    expect(
      screen.getAllByRole('status').some((n) => n.textContent === 'Copied'),
    ).toBe(true),
  );
  expect(writeText).toHaveBeenCalledWith(evidence().raw_response);
  writeText.mockRejectedValue(new Error('denied'));
  fireEvent.click(screen.getByRole('button', { name: 'Copy Raw reply' }));
  await waitFor(() => screen.getByText('Copy is unavailable here'));
});

test('several calls are progressive sections with honest states', () => {
  dialog([
    describeExchange(failure(), { id: 'f', title: 'Failed attempt' }),
    describeExchange(
      { provider: 'mock' },
      { id: 'm', title: 'Initial controls' },
    ),
    describeExchange(null, { id: 'n', title: 'More controls 1', kind: 'more' }),
  ]);
  const heads = screen
    .getAllByRole('button', { expanded: false })
    .concat(screen.getAllByRole('button', { expanded: true }));
  const names = heads.map((button) => button.textContent);
  expect(
    names.some(
      (text) => text.includes('Failed attempt') && text.includes('Failed'),
    ),
  ).toBe(true);
  expect(names.some((text) => text.includes('Mock'))).toBe(true);
  expect(names.some((text) => text.includes('Not saved'))).toBe(true);
  // The failed call opens by default and shows what was received.
  expect(screen.getByLabelText('Raw reply text').textContent).toBe(
    '{"categories": {"range": ',
  );
  expect(screen.getByText(/Missing generated category slots/)).toBeTruthy();
});

test('Escape and an outside press close; Tab stays inside the dialog', () => {
  const onClose = dialog([
    describeExchange(evidence(), { id: 'a', title: 'Initial controls' }),
  ]);
  const modal = screen.getByRole('dialog');
  const close = screen.getByRole('button', {
    name: 'Close request and response',
  });
  expect(modal.contains(document.activeElement)).toBe(true);
  close.focus();
  fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
  expect(modal.contains(document.activeElement)).toBe(true);
  fireEvent.keyDown(modal, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledTimes(1);
  fireEvent.pointerDown(modal);
  expect(onClose).toHaveBeenCalledTimes(1);
  fireEvent.pointerDown(modal.parentElement);
  expect(onClose).toHaveBeenCalledTimes(2);
});

function connected(routes = {}) {
  const api = installApi({
    ...fakeLibrary([]).routes,
    [dynamic]: () => ({
      controls: [
        { id: 'detail', kind: 'text-input', label: 'Detail', value: 'a' },
      ],
      dynamic_controls_metadata: evidence(),
    }),
    ...routes,
  });
  function Harness() {
    const studio = useStudio({
      clientPolicy: normalizeClientPolicy({
        controls: { debounce_ms: 5000, reset_debounce_ms: 5000 },
      }),
    });
    useLayoutEffect(() => {
      current = studio;
    });
    return <Create studio={studio} />;
  }
  render(<Harness />);
  return api;
}

test('the Generated controls header opens the exchange and returns focus', async () => {
  connected();
  act(() => current.setPrompt('A barn owl'));
  await act(async () => current.regenerateOptions());
  const trigger = await screen.findByRole('button', {
    name: 'Show controls request and response',
  });
  fireEvent.click(trigger);
  const modal = screen.getByRole('dialog', {
    name: 'Controls request and response',
  });
  expect(within(modal).getByText('Initial controls')).toBeTruthy();
  fireEvent.keyDown(modal, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

test('a failed controls call keeps every received attempt inspectable', async () => {
  const body = (n) => ({
    detail: 'Control provider returned invalid controls; retry generation',
    evidence: failure({ raw_response: `attempt ${n}` }),
  });
  let calls = 0;
  const api = connected({
    [dynamic]: () => respond(502, body((calls += 1))),
  });
  act(() => current.setPrompt('A barn owl'));
  await act(async () => current.regenerateOptions());
  const region = screen.getByRole('region', { name: 'Generated controls' });
  await waitFor(() => within(region).getByText(/Options failed/));
  expect(api.called(dynamic).length).toBe(calls);
  const link = within(region).getByRole('button', {
    name: 'Request and response',
  });
  fireEvent.click(link);
  const modal = screen.getByRole('dialog');
  expect(within(modal).getAllByText(/Failed attempt/).length).toBeGreaterThan(
    0,
  );
  expect(within(modal).getAllByLabelText('Raw reply text')[0].textContent).toBe(
    'attempt 1',
  );
  // Closing needs no further model call.
  fireEvent.keyDown(modal, { key: 'Escape' });
  expect(api.called(dynamic).length).toBe(calls);
});

test('a failure with no returned exchange says so instead of inventing one', async () => {
  connected({
    [dynamic]: () => respond(502, { detail: 'Provider request failed' }),
  });
  act(() => current.setPrompt('A barn owl'));
  await act(async () => current.regenerateOptions());
  const region = screen.getByRole('region', { name: 'Generated controls' });
  await waitFor(() => within(region).getByText(/Options failed/));
  expect(
    within(region).queryByRole('button', { name: 'Request and response' }),
  ).toBeNull();
});
