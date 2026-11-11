import React, { useRef } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { writePreference } from '../../shared/browser/preferences.js';
import Walkthrough, { placeCard } from './Walkthrough.jsx';

function Harness({ withMode = true }) {
  const root = useRef(null);
  return (
    <div ref={root}>
      <button data-tour="prompt">Prompt</button>
      {withMode ? <button data-tour="mode">Mode</button> : null}
      <nav className="app-nav">Pages</nav>
      <button data-tour="aspect">Aspect</button>
      <button data-tour="options">
        <span className="panel-head">Options</span>
      </button>
      <button data-tour="generate">Generate</button>
      <div id="result">
        <div className="stage">Image</div>
      </div>
      <Walkthrough rootRef={root} />
    </div>
  );
}

beforeEach(() => writePreference('show-tour', true));
afterEach(() => vi.restoreAllMocks());

describe('Walkthrough', () => {
  test('moves through real anchors, supports back, skip, Escape and replay', () => {
    const view = render(<Harness />);
    const start = screen.getByRole('button', {
      name: 'Start guided walkthrough',
    });
    fireEvent.click(start);
    expect(screen.getByRole('dialog').textContent).toContain(
      'Describe the image',
    );
    const next = screen.getByRole('button', { name: 'Next' });
    const dismiss = screen.getByRole('button', {
      name: 'Dismiss walkthrough',
    });
    next.focus();
    fireEvent.keyDown(next, { key: 'Tab' });
    expect(document.activeElement).toBe(dismiss);
    fireEvent.keyDown(dismiss, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(next);
    expect(
      view.container
        .querySelector('[data-tour="prompt"]')
        .classList.contains('walkthrough-target'),
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('dialog').textContent).toContain('Choose a mode');
    expect(
      view.container
        .querySelector('[data-tour="mode"]')
        .classList.contains('walkthrough-target'),
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('dialog').textContent).toContain(
      'Describe the image',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Skip tour' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(start);

    fireEvent.click(start);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(start);
  });

  test('repositions after resize and scroll and removes the anchor on close', () => {
    const view = render(<Harness />);
    const target = view.container.querySelector('[data-tour="prompt"]');
    target.scrollIntoView = vi.fn();
    let rect = {
      left: 100,
      top: 100,
      width: 20,
      height: 20,
      right: 120,
      bottom: 120,
    };
    vi.spyOn(target, 'getBoundingClientRect').mockImplementation(() => rect);
    fireEvent.click(
      screen.getByRole('button', { name: 'Start guided walkthrough' }),
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.style.top).toBe('132px');
    rect = {
      left: 1100,
      top: 600,
      width: 20,
      height: 20,
      right: 1120,
      bottom: 620,
    };
    fireEvent(window, new Event('resize'));
    expect(dialog.style.left).toBe(`${window.innerWidth - 404}px`);
    expect(dialog.style.top).toBe('338px');
    fireEvent(window, new Event('scroll'));
    fireEvent.click(
      screen.getByRole('button', { name: 'Dismiss walkthrough' }),
    );
    expect(target.classList.contains('walkthrough-target')).toBe(false);
  });

  test('uses immediate scrolling when reduced motion is requested', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const view = render(<Harness />);
    const target = view.container.querySelector('[data-tour="prompt"]');
    target.scrollIntoView = vi.fn();
    fireEvent.click(
      screen.getByRole('button', { name: 'Start guided walkthrough' }),
    );
    expect(target.scrollIntoView).toHaveBeenCalledWith({
      behavior: 'auto',
      block: 'center',
      inline: 'nearest',
    });
  });

  test('route unmount removes its active target and portal', () => {
    const view = render(<Harness />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Start guided walkthrough' }),
    );
    const target = view.container.querySelector('[data-tour="prompt"]');
    expect(target.classList.contains('walkthrough-target')).toBe(true);
    view.unmount();
    expect(target.classList.contains('walkthrough-target')).toBe(false);
    expect(document.querySelector('.walkthrough-card')).toBeNull();
    expect(document.querySelector('.walkthrough-shade')).toBeNull();
  });
});

test('placeCard stays inside the viewport at both horizontal edges', () => {
  expect(
    placeCard(
      { left: 0, right: 12, top: 20, bottom: 40, width: 12 },
      { width: 300, height: 200 },
      { width: 400, height: 300 },
    ).left,
  ).toBe(12);
  expect(
    placeCard(
      { left: 388, right: 400, top: 20, bottom: 40, width: 12 },
      { width: 300, height: 200 },
      { width: 400, height: 300 },
    ).left,
  ).toBe(88);
});

test('placeCard remains visible while an offscreen target scrolls into view', () => {
  const card = { width: 416, height: 233 };
  const viewport = { width: 1440, height: 900 };
  for (const top of [-2000, -300, 1900, 4000]) {
    const position = placeCard(
      { left: 100, top, bottom: top + 44, width: 200 },
      card,
      viewport,
    );
    expect(position.top).toBeGreaterThanOrEqual(12);
    expect(position.top + card.height).toBeLessThanOrEqual(
      viewport.height - 12,
    );
  }
});

test('Tour is hidden by default and a live preference change closes without hidden focus', () => {
  writePreference('show-tour', false);
  const view = render(<Harness />);
  expect(
    screen.queryByRole('button', { name: 'Start guided walkthrough' }),
  ).toBeNull();
  act(() => writePreference('show-tour', true));
  fireEvent.click(
    screen.getByRole('button', { name: 'Start guided walkthrough' }),
  );
  expect(screen.getByRole('dialog')).toBeTruthy();
  act(() => writePreference('show-tour', false));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(
    screen.queryByRole('button', { name: 'Start guided walkthrough' }),
  ).toBeNull();
  expect(document.activeElement).toBe(
    view.container.querySelector('[data-tour="prompt"]'),
  );
  expect(document.querySelector('.walkthrough-target')).toBeNull();
});

test('all seven anchored steps finish without navigating or changing tools', () => {
  render(<Harness />);
  fireEvent.click(
    screen.getByRole('button', { name: 'Start guided walkthrough' }),
  );
  for (let step = 1; step <= 7; step++) {
    expect(screen.getByRole('dialog').textContent).toContain(
      `Step ${step} of 7`,
    );
    fireEvent.click(
      screen.getByRole('button', { name: step === 7 ? 'Finish' : 'Next' }),
    );
  }
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('a missing mode anchor closes cleanly and returns focus without changing the page', () => {
  render(<Harness withMode={false} />);
  const start = screen.getByRole('button', {
    name: 'Start guided walkthrough',
  });
  fireEvent.click(start);
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(start);
  expect(document.querySelector('.walkthrough-target')).toBeNull();
});
