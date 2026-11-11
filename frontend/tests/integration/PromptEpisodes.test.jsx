import { openStandardControls } from '../helpers/controlUiTestSupport.js';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import App from '../../src/app/App.jsx';
import expanded from '../../../fixtures/api/expanded-static-controls.json';
import { normalizeClientPolicy } from '../../src/data/api/clientPolicy.js';
import {
  completeStatus,
  fakeLibrary,
  fixtures,
  installApi,
  libraryRecord,
  listedFromJob,
  respond,
} from '../helpers/testSupport.js';

const scroll = vi.hoisted(() => ({ stage: vi.fn(), notice: vi.fn() }));
vi.mock('../../src/features/create/stageScroll.js', () => ({
  scrollStageIntoView: scroll.stage,
  scrollNoticeIntoView: scroll.notice,
}));

const { m1 } = fixtures;
const DYNAMIC = 'POST /api/controls/dynamic';
const GENERATE = 'POST /api/generate-image';
const JOB = 'GET /api/generation-jobs/fixture-image-1';
const jobPolicy = { pollIntervalMs: 1, maxConsecutivePollFailures: 3 };
// Short waits keep real timers fast; the ratio under test is the shipped 0.5.
const clientPolicy = normalizeClientPolicy({
  controls: {
    debounce_ms: 60,
    reset_debounce_ms: 20,
    similarity_minimum_ratio: 0.5,
  },
});
const PAUSE = 150;
const sleep = (ms) =>
  act(() => new Promise((resolve) => setTimeout(resolve, ms)));

let api;
let library;

function setup(records = [], routes = {}) {
  library = fakeLibrary(records);
  api = installApi({
    [DYNAMIC]: () => m1.dynamic_response,
    [GENERATE]: () => respond(202, m1.accepted),
    [JOB]: () => {
      const status = completeStatus();
      library.records = [listedFromJob(status.result), ...library.records];
      return status;
    },
    ...library.routes,
    ...routes,
  });
}

const prompt = () => screen.getByLabelText('Image idea');
const type = (text) => fireEvent.change(prompt(), { target: { value: text } });
const enter = () => fireEvent.keyDown(prompt(), { key: 'Enter' });
const style = () =>
  api
    .called(GENERATE)
    .at(-1)
    .body.controls.find((c) => c.id === 'style').value;
const ready = async () => {
  render(<App jobPolicy={jobPolicy} clientPolicy={clientPolicy} />);
  await openStandardControls();
};

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  localStorage.clear();
  scroll.stage.mockClear();
  scroll.notice.mockClear();
  // 0.9 is outside the 0.7 Photography band, so the other styles are sampled
  // uniformly and the last one is chosen.
  vi.spyOn(Math, 'random').mockReturnValue(0.9);
});

test('a new prompt draws one weighted Style from the current multi-select catalog', async () => {
  vi.mocked(Math.random).mockReturnValue(0.69);
  setup([], {
    'GET /api/controls/static?generation_mode=standard': () =>
      expanded.standard,
  });
  render(<App jobPolicy={jobPolicy} clientPolicy={clientPolicy} />);
  await openStandardControls();
  const photography = await screen.findByRole('checkbox', {
    name: 'Photography',
    exact: true,
  });
  const watercolor = screen.getByRole('checkbox', {
    name: 'Watercolor',
    exact: true,
  });
  type('A red wooden bridge in snow');
  await sleep(PAUSE);
  fireEvent.click(watercolor);
  expect(watercolor.checked).toBe(true);

  type('Deep ocean jellyfish at night');
  await waitFor(() => expect(watercolor.checked).toBe(false));
  expect(photography.checked).toBe(true);
  fireEvent.click(watercolor);
  expect(watercolor.checked).toBe(true);
  expect(photography.checked).toBe(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('half of the longer prompt edited starts a new episode; one edit fewer does not', async () => {
  for (const [edit, fresh] of [
    ['abcdeXXXXX', true],
    ['abcdefXXXX', false],
  ]) {
    setup();
    await ready();
    type('abcdefghij');
    await waitFor(() => expect(api.called(DYNAMIC)).toHaveLength(1));
    // The first prompt's own draw, then a manual choice.
    Math.random.mockReturnValue(0);
    fireEvent.click(screen.getByRole('radio', { name: 'Watercolor' }));
    type(edit);
    await sleep(PAUSE);
    enter();
    await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
    // A new episode draws again (0 selects Photography); otherwise the manual
    // Watercolor choice is kept.
    expect(style()).toBe(fresh ? 'photography' : 'watercolor');
    expect(api.called(DYNAMIC)).toHaveLength(fresh ? 2 : 1);
    cleanup();
  }
});

test('an explicit submit resets a new prompt before anything is sent', async () => {
  setup();
  await ready();
  type('a completely different scene');
  enter();
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
  expect(style()).toBe('oil-painting');
  expect(api.called(DYNAMIC)).toHaveLength(1);
  expect(api.called(DYNAMIC)[0].body.prompt).toBe(
    'a completely different scene',
  );
});

test('a new prompt clears the stage without falling back to the newest saved image', async () => {
  setup([libraryRecord({ id: 'older', title: 'Older image' })]);
  await ready();
  fireEvent.click(await screen.findByRole('button', { name: 'Older image' }));
  await screen.findByRole('heading', { name: 'Older image' });
  type('a completely different scene');
  await sleep(PAUSE);
  expect(screen.queryByRole('heading', { name: 'Older image' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Older image' })).toBeTruthy();
  expect(screen.getByText('Generate image')).toBeTruthy();
});

test('values are drawn once per episode, not on every keystroke', async () => {
  setup();
  await ready();
  type('a quiet harbour at dawn');
  await waitFor(() => expect(api.called(DYNAMIC)).toHaveLength(1));
  Math.random.mockReturnValue(0);
  for (const text of ['a quiet harbour at dusk', 'a quiet harbor at dusk']) {
    type(text);
    await sleep(PAUSE);
  }
  enter();
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
  expect(style()).toBe('oil-painting');
  expect(api.called(DYNAMIC)).toHaveLength(1);
});

test('restoring a saved image never randomizes or fetches', async () => {
  setup([libraryRecord({ id: 'older', title: 'Older image' })]);
  await ready();
  fireEvent.click(await screen.findByRole('button', { name: 'Older image' }));
  await sleep(PAUSE * 2);
  expect(api.called(DYNAMIC)).toHaveLength(0);
  expect(api.called(GENERATE)).toHaveLength(0);
  expect(screen.getByRole('heading', { name: 'Older image' })).toBeTruthy();
  expect(scroll.stage).not.toHaveBeenCalled();
});

test('a new prompt after a restore without fixed controls loads the catalog and draws once', async () => {
  setup([libraryRecord({ id: 'older', title: 'Older image' })]);
  await ready();
  fireEvent.click(await screen.findByRole('button', { name: 'Older image' }));
  await screen.findByRole('heading', { name: 'Older image' });
  fireEvent.click(screen.getByRole('button', { name: 'Older image' }));
  await sleep(PAUSE);
  type('a completely different subject: tea kettle');
  await openStandardControls();
  enter();
  await waitFor(() => expect(api.called(GENERATE)).toHaveLength(1));
  expect(style()).toBe('oil-painting');
});

test('only an explicit Generate scrolls the stage, once, and not on completion or selection', async () => {
  setup([libraryRecord({ id: 'older', title: 'Older image' })]);
  await ready();
  fireEvent.click(await screen.findByRole('button', { name: 'Older image' }));
  await screen.findByRole('heading', { name: 'Older image' });
  type('a quiet harbour at dawn');
  await sleep(PAUSE);
  fireEvent.click(screen.getByRole('button', { name: 'Older image' }));
  await sleep(PAUSE);
  expect(scroll.stage).not.toHaveBeenCalled();
  type('another harbour at dawn');
  fireEvent.click(screen.getByText(/^(Generate image|Regenerate)$/));
  await waitFor(() => expect(scroll.stage).toHaveBeenCalledTimes(1));
  await screen.findByRole('heading', { name: m1.job_complete.result.title });
  await sleep(PAUSE);
  expect(scroll.stage).toHaveBeenCalledTimes(1);
  expect(scroll.notice).not.toHaveBeenCalled();
});
