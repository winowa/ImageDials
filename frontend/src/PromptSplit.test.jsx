import React, { useRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { resetPreferenceMemory } from './preferences.js';
import PromptSplit, { usePromptSplit } from './PromptSplit.jsx';

function Harness() {
  const root = useRef(null);
  const split = usePromptSplit(root);
  return (
    <div
      ref={root}
      className="studio"
      data-split-layout={split.layout}
      style={{ gridTemplateColumns: split.columns, columnGap: split.columnGap }}
    >
      <div className="studio-main" id="prompt" />
      <PromptSplit id="prompt" separator={split.separator} />
      <div className="studio-side" />
    </div>
  );
}

let width;

beforeEach(() => {
  width = 1280;
  localStorage.removeItem('imagedials-prompt-panel-fraction');
  resetPreferenceMemory();
  vi.stubGlobal('ResizeObserver', undefined);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function bounds() {
      return this.classList.contains('studio')
        ? { width, height: 100, top: 0, right: width, bottom: 100, left: 0 }
        : { width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 };
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetPreferenceMemory();
});

describe('PromptSplit', () => {
  test('resizes with pointer and keyboard and persists the proportional width', () => {
    const view = render(<Harness />);
    const separator = screen.getByRole('separator', {
      name: 'Prompt panel width',
    });
    const initial = Number(separator.getAttribute('aria-valuenow'));
    fireEvent.pointerDown(separator, { button: 0, pointerId: 7, clientX: 500 });
    fireEvent.pointerMove(separator, { pointerId: 7, clientX: 610 });
    expect(Number(separator.getAttribute('aria-valuenow'))).toBeGreaterThan(
      initial,
    );
    fireEvent.pointerUp(separator, { pointerId: 7, clientX: 610 });
    expect(
      Number(
        JSON.parse(localStorage.getItem('imagedials-prompt-panel-fraction')),
      ),
    ).toBeGreaterThan(0.5);

    fireEvent.keyDown(separator, { key: 'End' });
    expect(separator.getAttribute('aria-valuenow')).toBe(
      separator.getAttribute('aria-valuemax'),
    );
    const stored = Number(
      localStorage.getItem('imagedials-prompt-panel-fraction'),
    );
    view.unmount();
    render(<Harness />);
    expect(
      Number(localStorage.getItem('imagedials-prompt-panel-fraction')),
    ).toBe(stored);
  });

  test('stacks when the available width cannot fit both columns', () => {
    const view = render(<Harness />);
    expect(screen.getByRole('separator')).toBeTruthy();
    width = 800;
    fireEvent(window, new Event('resize'));
    expect(view.container.firstChild.getAttribute('data-split-layout')).toBe(
      'stacked',
    );
    expect(view.container.querySelector('[role="separator"]')).toBeNull();
    expect(view.container.firstChild.style.gridTemplateColumns).toBe(
      'minmax(0, 1fr)',
    );
  });
});
