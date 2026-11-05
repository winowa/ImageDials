import React from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, expect, onTestFinished, test, vi } from 'vitest';
import { ExchangeList } from './LlmExchange.jsx';
import { describeExchange } from './llmExchange.js';
import { JsonTree } from './ui.jsx';
import { JsonViewer, RawJsonView } from './JsonViewer.jsx';
import { VIEWPORT_MIN_PX } from './ViewportResize.jsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const toggles = (root) =>
  [...root.querySelectorAll('.j-toggle')].map((row) =>
    row.getAttribute('aria-label'),
  );

test('leaf rows and empty containers have no control; only openable rows do', () => {
  const { container } = render(
    <JsonTree value={{ a: 1, b: [], c: {}, d: { e: 'x' } }} />,
  );
  expect(toggles(container)).toEqual(['root collapse', 'd expand']);
  expect(container.textContent).toContain('"b": []');
  expect(container.textContent).toContain('"c": {}');
});

test('opening and closing a row moves aria-expanded and shows a count when closed', () => {
  const { container } = render(<JsonTree value={{ d: { e: 'x', f: 'y' } }} />);
  const row = within(container).getByRole('button', { name: 'd expand' });
  expect(row.getAttribute('aria-expanded')).toBe('false');
  expect(row.textContent).toContain('2 items');
  fireEvent.click(row);
  expect(row.getAttribute('aria-expanded')).toBe('true');
  expect(row.getAttribute('aria-label')).toBe('d collapse');
  expect(container.textContent).toContain('"e": "x"');
  expect(row.textContent).not.toContain('2 items');
});

test('arrow keys move between rows and Left/Right close and open', () => {
  const { container } = render(
    <JsonTree value={{ a: { x: 1 }, b: { y: 2 }, c: 3 }} />,
  );
  const root = within(container).getByRole('button', { name: 'root collapse' });
  root.focus();
  fireEvent.keyDown(root, { key: 'ArrowDown' });
  const a = within(container).getByRole('button', { name: 'a expand' });
  expect(document.activeElement).toBe(a);
  fireEvent.keyDown(a, { key: 'ArrowRight' });
  expect(a.getAttribute('aria-expanded')).toBe('true');
  fireEvent.keyDown(a, { key: 'ArrowLeft' });
  expect(a.getAttribute('aria-expanded')).toBe('false');
  fireEvent.keyDown(a, { key: 'End' });
  expect(document.activeElement).toBe(
    within(container).getByRole('button', { name: 'b expand' }),
  );
  fireEvent.keyDown(document.activeElement, { key: 'Home' });
  expect(document.activeElement).toBe(root);
  // Closing hides the nested rows from the walk.
  fireEvent.keyDown(root, { key: 'ArrowLeft' });
  fireEvent.keyDown(root, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(root);
});

/** Give rows a transition, as the real stylesheet does. */
function animated() {
  const style = document.createElement('style');
  style.textContent = '.j-toggle { transition-duration: 0.2s; }';
  document.head.append(style);
  onTestFinished(() => style.remove());
}

test('a closing animation keeps the body until it ends and a press reverses it', () => {
  animated();
  const { container } = render(<JsonTree value={{ a: { x: 1 } }} />);
  const body = () => container.querySelector('.j-body');
  const root = within(container).getByRole('button', { name: 'root collapse' });
  fireEvent.click(root);
  expect(body().getAttribute('data-open')).toBe('false');
  expect(body().hasAttribute('inert')).toBe(true);
  expect(root.getAttribute('aria-expanded')).toBe('false');
  // Reversed mid-animation: the same body opens again.
  fireEvent.click(root);
  expect(body().getAttribute('data-open')).toBe('true');
  expect(body().hasAttribute('inert')).toBe(false);
  fireEvent.click(root);
  fireEvent.transitionEnd(body(), { propertyName: 'grid-template-rows' });
  expect(body()).toBeNull();
});

test('a closing animation that never ends is dropped by the fallback', () => {
  vi.useFakeTimers();
  try {
    animated();
    const { container } = render(<JsonTree value={{ a: 1 }} />);
    fireEvent.click(
      within(container).getByRole('button', { name: 'root collapse' }),
    );
    expect(container.querySelector('.j-body')).not.toBeNull();
    act(() => vi.advanceTimersByTime(600));
    expect(container.querySelector('.j-body')).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

const raw =
  '{"categories":{ "a" : [1,\n   2.5e3,true,null],\t"html":"<img src=x onerror=alert(1)>"}}  \n';
const evidence = {
  prompt: JSON.stringify([
    { role: 'user', content: JSON.stringify({ idea: 'owl' }) },
  ]),
  raw_response: raw,
  response: JSON.parse(raw),
  provider: 'p',
  model: 'm',
};
const show = (extra = {}, base = {}) =>
  render(
    <ExchangeList
      exchanges={[
        describeExchange(
          { ...evidence, ...extra },
          { id: 'a', title: 'Initial controls', ...base },
        ),
      ]}
    />,
  );
const openRaw = () =>
  fireEvent.click(screen.getAllByRole('button', { name: 'Raw' }).at(-1));

test('raw JSON keeps every stored character and is highlighted by token', () => {
  show();
  openRaw();
  const pre = screen.getByLabelText('Raw reply text');
  expect(pre.textContent).toBe(raw);
  expect(pre.querySelector('img')).toBeNull();
  expect(pre.querySelector('.j-key').textContent).toBe('"categories"');
  expect([...pre.querySelectorAll('.j-num')].map((n) => n.textContent)).toEqual(
    ['1', '2.5e3'],
  );
  expect(pre.querySelector('.j-bool').textContent).toBe('true');
  expect(pre.querySelector('.j-null').textContent).toBe('null');
  expect([...pre.querySelectorAll('.j-str')].map((n) => n.textContent)).toEqual(
    ['"<img src=x onerror=alert(1)>"'],
  );
});

test('raw copy is the stored text, not a rebuilt one', async () => {
  const writeText = vi.fn().mockResolvedValue();
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  show();
  openRaw();
  fireEvent.click(screen.getByRole('button', { name: 'Copy Raw reply' }));
  await act(async () => {});
  expect(writeText).toHaveBeenCalledWith(raw);
  vi.unstubAllGlobals();
});

test.each([
  ['clipped JSON', '{"categories": {"range": "x'],
  ['prose', 'I cannot comply <b>bold</b>'],
  ['trailing comma', '{"a": 1,}'],
])('%s is shown as stored without highlighting', (_name, text) => {
  show({ raw_response: text, response: undefined });
  const pre = screen.getByLabelText('Raw reply text');
  expect(pre.textContent).toBe(text);
  expect(pre.querySelector('span')).toBeNull();
  expect(pre.querySelector('b')).toBeNull();
});

test('a fenced reply stays exact and highlights the JSON inside it', () => {
  const fenced = '```json\n{"a": 1}\n```';
  show({ raw_response: fenced });
  openRaw();
  const pre = screen.getByLabelText('Raw reply text');
  expect(pre.textContent).toBe(fenced);
  expect(pre.querySelector('.j-key').textContent).toBe('"a"');
});

function sizes({ viewport = 200, content = 900, window: high = 800 } = {}) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function box() {
      const sized = this.style.height ? parseFloat(this.style.height) : null;
      const height = this.classList.contains('exchange-viewport')
        ? (sized ?? viewport)
        : 0;
      return { top: 0, left: 0, right: 0, bottom: height, width: 0, height };
    },
  );
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(
    content,
  );
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(
    viewport,
  );
  vi.stubGlobal('innerHeight', high);
}
const handle = () =>
  screen.getByRole('separator', { name: /^Resize Raw reply/ });
const rawViewport = () => screen.getByLabelText('Raw reply text');

test('the resize handle appears only when the viewport can scroll', () => {
  sizes({ content: 100, viewport: 200 });
  show();
  expect(
    document.querySelector('.viewport-grip').getAttribute('data-visible'),
  ).toBe('false');
  cleanup();
  sizes({ content: 900, viewport: 200 });
  show();
  expect(
    document.querySelector('.viewport-grip').getAttribute('data-visible'),
  ).toBe('true');
});

test('keys resize between the minimum and a window-relative maximum', () => {
  sizes();
  show();
  openRaw();
  const grip = handle();
  expect(grip.getAttribute('aria-valuenow')).toBe('200');
  expect(grip.getAttribute('aria-valuemin')).toBe(String(VIEWPORT_MIN_PX));
  expect(grip.getAttribute('aria-valuemax')).toBe('680');
  fireEvent.keyDown(grip, { key: 'ArrowDown' });
  expect(rawViewport().style.height).toBe('224px');
  expect(rawViewport().getAttribute('data-sized')).toBe('true');
  fireEvent.keyDown(grip, { key: 'ArrowUp' });
  expect(rawViewport().style.height).toBe('200px');
  fireEvent.keyDown(grip, { key: 'PageDown' });
  expect(rawViewport().style.height).toBe('320px');
  fireEvent.keyDown(grip, { key: 'End' });
  expect(rawViewport().style.height).toBe('680px');
  fireEvent.keyDown(grip, { key: 'ArrowDown' });
  expect(rawViewport().style.height).toBe('680px');
  fireEvent.keyDown(grip, { key: 'Home' });
  expect(rawViewport().style.height).toBe(`${VIEWPORT_MIN_PX}px`);
  fireEvent.keyDown(grip, { key: 'ArrowUp' });
  expect(rawViewport().style.height).toBe(`${VIEWPORT_MIN_PX}px`);
  act(() => grip.focus());
  fireEvent.keyDown(grip, { key: 'Enter' });
  expect(rawViewport().style.height).toBe('');
  expect(rawViewport().getAttribute('data-sized')).toBe('false');
  // Focus stays on the handle after a reset.
  expect(document.activeElement).toBe(grip);
});

test('a window change tightens the maximum', () => {
  sizes();
  show();
  openRaw();
  fireEvent.keyDown(handle(), { key: 'End' });
  expect(rawViewport().style.height).toBe('680px');
  vi.stubGlobal('innerHeight', 400);
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
  expect(rawViewport().style.height).toBe('340px');
  expect(handle().getAttribute('aria-valuemax')).toBe('340');
});

test('dragging with a pointer resizes and a double press resets', () => {
  sizes();
  show();
  openRaw();
  const grip = handle();
  grip.setPointerCapture = vi.fn();
  grip.releasePointerCapture = vi.fn();
  fireEvent.pointerDown(grip, {
    pointerId: 3,
    pointerType: 'touch',
    clientY: 400,
  });
  expect(grip.getAttribute('data-dragging')).toBe('true');
  fireEvent.pointerMove(grip, { pointerId: 3, clientY: 460 });
  expect(rawViewport().style.height).toBe('260px');
  fireEvent.pointerMove(grip, { pointerId: 3, clientY: 5000 });
  expect(rawViewport().style.height).toBe('680px');
  fireEvent.pointerUp(grip, { pointerId: 3 });
  expect(grip.getAttribute('data-dragging')).toBe('false');
  fireEvent.pointerMove(grip, { pointerId: 3, clientY: 100 });
  expect(rawViewport().style.height).toBe('680px');
  fireEvent.doubleClick(grip);
  expect(rawViewport().style.height).toBe('');
});

test('a secondary mouse button does not start a drag', () => {
  sizes();
  show();
  openRaw();
  const grip = handle();
  fireEvent.pointerDown(grip, { pointerType: 'mouse', button: 2, clientY: 10 });
  expect(grip.getAttribute('data-dragging')).toBe('false');
});

test('the handle is a labelled keyboard stop that controls its viewport', () => {
  sizes();
  show();
  openRaw();
  const grip = handle();
  expect(grip.getAttribute('aria-controls')).toBe(rawViewport().id);
  expect(grip.tabIndex).toBe(0);
  expect(grip.hasAttribute('title')).toBe(false);
  act(() => grip.focus());
  expect(screen.getByRole('tooltip').textContent).toMatch(/arrow keys/);
});

test('request and reply viewports are independent', () => {
  sizes();
  render(
    <ExchangeList
      exchanges={[describeExchange(evidence, { id: 'a', title: 'Call' })]}
    />,
  );
  const handles = screen.getAllByRole('separator');
  expect(handles.length).toBeGreaterThan(1);
  fireEvent.keyDown(handles[0], { key: 'End' });
  const sized = [...document.querySelectorAll('.exchange-viewport')].map((n) =>
    n.getAttribute('data-sized'),
  );
  expect(sized.filter((value) => value === 'true')).toHaveLength(1);
});

test('diagnostics can reuse the raw viewer without parsed evidence', () => {
  const text =
    ' \r\n{ "escape": "\\u00e9\\n", "unicode": "😀", "exponent": -2E+10 }\t';
  const { container } = render(<JsonViewer raw={text} label="Response body" />);
  const pre = screen.getByLabelText('Response body text');
  expect(pre.textContent).toBe(text);
  expect(pre.querySelector('.j-num').textContent).toBe('-2E+10');
  expect(container.querySelector('.json-tree')).toBeNull();
});

test('standalone raw rendering keeps oversized text exact and plain', () => {
  const text = JSON.stringify({
    body: '<script>alert(1)</script>'.repeat(15000),
  });
  const { container } = render(
    <RawJsonView text={text} label="Response body" />,
  );
  expect(screen.getByLabelText('Response body text').textContent).toBe(text);
  expect(container.querySelector('span,script')).toBeNull();
});

test('collapsing an ancestor returns nested focus before hiding its body', () => {
  render(<JsonTree value={{ child: { nested: 1 } }} />);
  const child = screen.getByRole('button', { name: 'child expand' });
  child.focus();
  const root = screen.getByRole('button', { name: 'root collapse' });
  fireEvent.click(root);
  expect(document.activeElement).toBe(root);
});

test('a second pointer cannot take over an active resize', () => {
  sizes();
  show();
  openRaw();
  const grip = handle();
  fireEvent.pointerDown(grip, {
    pointerId: 1,
    pointerType: 'touch',
    clientY: 100,
  });
  fireEvent.pointerDown(grip, {
    pointerId: 2,
    pointerType: 'touch',
    clientY: 500,
  });
  fireEvent.pointerMove(grip, { pointerId: 2, clientY: 550 });
  expect(rawViewport().style.height).toBe('');
  fireEvent.pointerMove(grip, { pointerId: 1, clientY: 140 });
  expect(rawViewport().style.height).toBe('240px');
  fireEvent.pointerCancel(grip, { pointerId: 1 });
  expect(grip.getAttribute('data-dragging')).toBe('false');
});

test('copy completion after unmount does not create a status timer', async () => {
  let finish;
  vi.stubGlobal('navigator', {
    ...navigator,
    clipboard: {
      writeText: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    },
  });
  const { unmount } = show();
  openRaw();
  fireEvent.click(screen.getByRole('button', { name: 'Copy Raw reply' }));
  unmount();
  const timeout = vi.spyOn(globalThis, 'setTimeout');
  await act(async () => finish());
  expect(timeout).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

test('standalone metadata trees use the same bounded resize handle', () => {
  sizes();
  render(
    <JsonTree value={{ metadata: Array.from({ length: 20 }, (_, i) => i) }} />,
  );
  const grip = screen.getByRole('separator', { name: 'Resize JSON' });
  fireEvent.keyDown(grip, { key: 'End' });
  const viewport = document.querySelector('.json-tree');
  expect(viewport.style.height).toBe('680px');
  expect(grip.getAttribute('aria-controls')).toBe(viewport.id);
});

test('clipboard rejection exposes a local cause and makes no API request', async () => {
  const request = vi.fn();
  vi.stubGlobal('fetch', request);
  vi.stubGlobal('navigator', {
    ...navigator,
    clipboard: {
      writeText: vi
        .fn()
        .mockRejectedValue(
          new DOMException('Clipboard access denied', 'NotAllowedError'),
        ),
    },
  });
  show();
  openRaw();
  fireEvent.click(screen.getByRole('button', { name: 'Copy Raw reply' }));
  await act(async () => {});
  expect(screen.getByText('Copy is unavailable here')).toBeTruthy();
  const details = screen.getByRole('button', { name: 'Copy failure details' });
  expect(details.hasAttribute('title')).toBe(false);
  fireEvent.click(details);
  const panel = screen.getByRole('dialog', { name: 'Copy failure details' });
  expect(panel.textContent).toContain('Clipboard');
  expect(panel.textContent).toContain(
    'NotAllowedError: Clipboard access denied',
  );
  expect(panel.textContent).not.toContain('HTTP status');
  expect(panel.textContent).not.toContain('No HTTP response');
  expect(request).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
