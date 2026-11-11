import React from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { REF_STATUS } from '../../src/features/references/references.js';
import { ReferenceItem } from '../../src/features/references/References.jsx';
import ResultMenu, { anchorVisible } from '../../src/shared/ui/ResultMenu.jsx';
import Viewer from '../../src/features/results/Viewer.jsx';

vi.mock('../../src/data/media/SavedImg.jsx', () => ({
  SavedImg: ({ image, className }) => (
    <img className={className} alt={image.alt_text} />
  ),
}));

const MENU_W = 220;
const MENU_H = 150;
const VIEW_W = 1280;
const VIEW_H = 800;

// Real DOMRect instances: their fields are prototype getters, so code that
// spreads a rect (and loses every coordinate) fails here as in a browser.
const rect = (left, top, width, height) => {
  const box = new DOMRect(left, top, width, height);
  expect(Object.keys({ ...box })).toEqual([]);
  return box;
};

// A geometry stub: each element can be given a live rect function.
const boxes = new WeakMap();
const setBox = (node, fn) => boxes.set(node, fn);
const originalRect = HTMLElement.prototype.getBoundingClientRect;
const originalWidth = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'offsetWidth',
);
const originalHeight = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'offsetHeight',
);
const isMenu = (node) => node.classList?.contains('result-menu-list');

beforeEach(() => {
  window.innerWidth = VIEW_W;
  window.innerHeight = VIEW_H;
  HTMLElement.prototype.getBoundingClientRect = function getRect() {
    const fn = boxes.get(this);
    return fn ? fn() : originalRect.call(this);
  };
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() {
      return isMenu(this) ? MENU_W : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      return isMenu(this) ? MENU_H : 0;
    },
  });
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  HTMLElement.prototype.getBoundingClientRect = originalRect;
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalWidth);
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalHeight);
});

/**
 * Reproduces the studio's split layout: a sticky, scrolling side pane whose
 * own stacking context sits below a later positioned split handle, inside an
 * ancestor that is a containing block for fixed descendants (container
 * queries and transforms both make one).
 */
function Pane({ children }) {
  return (
    <div
      className="studio"
      style={{ containerType: 'inline-size', transform: 'translateZ(0)' }}
    >
      <div
        data-testid="pane"
        className="studio-side"
        style={{ position: 'sticky', overflowY: 'auto', zIndex: 0 }}
      >
        {children}
      </div>
      <div className="prompt-split" style={{ position: 'relative', zIndex: 1 }}>
        split
      </div>
    </div>
  );
}

const items = (onSelect = vi.fn()) => [
  { id: 'a', label: 'First', onSelect },
  { id: 'b', label: 'Second', onSelect },
];

/** Gives the pane and trigger a scroll-dependent layout. */
function layout(trigger, { at = { left: 1000, top: 300 }, pane } = {}) {
  const state = { scroll: 0, left: at.left, top: at.top };
  setBox(trigger, () => rect(state.left, state.top - state.scroll, 44, 44));
  if (pane) setBox(screen.getByTestId('pane'), () => rect(...pane.rect));
  return state;
}

const menuNode = () => screen.getByRole('menu');

describe('ResultMenu placement', () => {
  test('focuses after the measuring menu is visible, then Escape returns to the trigger', () => {
    const nativeFocus = HTMLElement.prototype.focus;
    const focus = vi
      .spyOn(HTMLElement.prototype, 'focus')
      .mockImplementation(function (options) {
        // jsdom otherwise permits focus into visibility:hidden ancestors.
        if (this.closest('[role="menu"]')?.style.visibility === 'hidden')
          return;
        nativeFocus.call(this, options);
      });
    try {
      render(<ResultMenu items={items()} />);
      const trigger = screen.getByRole('button', { name: 'More actions' });
      layout(trigger);
      trigger.focus();
      fireEvent.keyDown(trigger, { key: 'ArrowDown' });
      expect(document.activeElement).toBe(
        screen.getByRole('menuitem', { name: 'First' }),
      );
      fireEvent.keyDown(document.activeElement, { key: 'ArrowDown' });
      expect(document.activeElement).toBe(
        screen.getByRole('menuitem', { name: 'Second' }),
      );
      fireEvent.scroll(window);
      expect(document.activeElement).toBe(
        screen.getByRole('menuitem', { name: 'Second' }),
      );
      fireEvent.keyDown(document.activeElement, { key: 'Escape' });
      expect(screen.queryByRole('menu')).toBeNull();
      expect(document.activeElement).toBe(trigger);
    } finally {
      focus.mockRestore();
    }
  });

  test('portals the list out of transformed, contained and stacked ancestors', () => {
    render(
      <Pane>
        <ResultMenu items={items()} />
      </Pane>,
    );
    const trigger = screen.getByRole('button', { name: 'More actions' });
    layout(trigger);
    fireEvent.click(trigger);
    const menu = menuNode();
    // Escapes every ancestor that could own its fixed position or stacking.
    expect(menu.parentElement).toBe(document.body);
    expect(screen.getByTestId('pane').contains(menu)).toBe(false);
    // Right-aligned below the trigger, in viewport coordinates.
    expect(menu.style.left).toBe(`${1000 + 44 - MENU_W}px`);
    expect(menu.style.top).toBe(`${300 + 44 + 8}px`);
    expect(menu.style.visibility).toBe('');
    expect(menu.dataset.side).toBe('below');
  });

  test('follows the trigger through pane scrolling, page scrolling and rotation', () => {
    render(
      <Pane>
        <ResultMenu items={items()} label="Actions for reference 1" compact />
      </Pane>,
    );
    const pane = screen.getByTestId('pane');
    const trigger = screen.getByRole('button', {
      name: 'Actions for reference 1',
    });
    const state = layout(trigger, {
      at: { left: 500, top: 400 },
      pane: { rect: [0, 0, 640, VIEW_H] },
    });
    fireEvent.click(trigger);
    const menu = menuNode();
    expect(menu.style.top).toBe('452px');

    state.scroll = 120;
    fireEvent.scroll(pane);
    expect(menu.style.top).toBe('332px');

    state.scroll = 200;
    fireEvent.scroll(window);
    expect(menu.style.top).toBe('252px');

    // Portrait rotation: a narrower viewport clamps the menu inside it, and
    // a trigger near the bottom flips the menu above.
    window.innerWidth = 800;
    window.innerHeight = 1280;
    state.left = 760;
    state.top = 1240;
    state.scroll = 0;
    setBox(pane, () => rect(0, 0, 800, 1280));
    fireEvent(window, new Event('resize'));
    expect(Number.parseFloat(menu.style.left)).toBeLessThanOrEqual(
      800 - MENU_W - 8,
    );
    expect(menu.style.top).toBe(`${1240 - 8 - MENU_H}px`);
    expect(menu.dataset.side).toBe('above');
  });

  test('closes once the trigger scrolls out of its pane, keeping focus on the trigger', () => {
    render(
      <Pane>
        <ResultMenu items={items()} />
      </Pane>,
    );
    const pane = screen.getByTestId('pane');
    const trigger = screen.getByRole('button', { name: 'More actions' });
    const state = layout(trigger, {
      at: { left: 300, top: 200 },
      pane: { rect: [0, 100, 640, 600] },
    });
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(
      within(menuNode()).getAllByRole('menuitem')[0],
    );
    state.scroll = 200; // trigger now at top 0..44, above the pane's top 100
    fireEvent.scroll(pane);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });
});

describe('ResultMenu interaction across the portal', () => {
  test('portal presses do not bubble into the split-pane drag owner', () => {
    const pointerDown = vi.fn();
    const click = vi.fn();
    render(
      <div onPointerDown={pointerDown} onClick={click}>
        <ResultMenu items={items()} />
      </div>,
    );
    const trigger = screen.getByRole('button', { name: 'More actions' });
    layout(trigger);
    fireEvent.click(trigger);
    pointerDown.mockClear();
    click.mockClear();
    const item = within(menuNode()).getByRole('menuitem', { name: 'Second' });
    fireEvent.pointerDown(item, { button: 0 });
    fireEvent.click(item);
    expect(pointerDown).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });

  test('a press inside the portaled list does not count as outside', () => {
    const onSelect = vi.fn();
    render(
      <Pane>
        <ResultMenu items={items(onSelect)} />
      </Pane>,
    );
    const trigger = screen.getByRole('button', { name: 'More actions' });
    layout(trigger);
    fireEvent.click(trigger);
    const second = within(menuNode()).getByRole('menuitem', { name: 'Second' });
    fireEvent.pointerDown(second);
    expect(screen.queryByRole('menu')).not.toBeNull();
    fireEvent.click(second);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  test('a press on the split handle or elsewhere closes without stealing focus', () => {
    render(
      <Pane>
        <ResultMenu items={items()} />
      </Pane>,
    );
    const trigger = screen.getByRole('button', { name: 'More actions' });
    layout(trigger);
    fireEvent.click(trigger);
    fireEvent.pointerDown(screen.getByText('split'));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).not.toBe(trigger);
  });

  test('Escape returns focus; Tab hands focus back to the trigger before moving on', () => {
    render(
      <Pane>
        <ResultMenu items={items()} />
        <button type="button">After</button>
      </Pane>,
    );
    const trigger = screen.getByRole('button', { name: 'More actions' });
    layout(trigger);
    fireEvent.keyDown(trigger, { key: 'ArrowUp' });
    const list = within(menuNode()).getAllByRole('menuitem');
    expect(document.activeElement).toBe(list[1]);
    fireEvent.keyDown(list[1], { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    const first = within(menuNode()).getAllByRole('menuitem')[0];
    fireEvent.keyDown(first, { key: 'Tab' });
    expect(screen.queryByRole('menu')).toBeNull();
    // The browser's default Tab then continues from the trigger, not from
    // the end of the document where the portal was.
    expect(document.activeElement).toBe(trigger);
  });

  test('removes its window listeners when closed and when unmounted open', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const { unmount } = render(<ResultMenu items={items()} />);
    const trigger = screen.getByRole('button', { name: 'More actions' });
    layout(trigger);
    fireEvent.click(trigger);
    const scrolls = add.mock.calls.filter(([type]) => type === 'scroll').length;
    expect(scrolls).toBeGreaterThan(0);
    unmount();
    expect(remove.mock.calls.filter(([type]) => type === 'scroll').length).toBe(
      scrolls,
    );
    expect(document.querySelector('.result-menu-list')).toBeNull();
    add.mockRestore();
    remove.mockRestore();
  });
});

describe('anchorVisible', () => {
  test('treats unmeasured nodes as visible and fully clipped ones as hidden', () => {
    render(
      <div data-testid="clip" style={{ overflow: 'hidden' }}>
        <span data-testid="inner">x</span>
      </div>,
    );
    const inner = screen.getByTestId('inner');
    expect(anchorVisible(inner)).toBe(true);
    setBox(screen.getByTestId('clip'), () => rect(0, 0, 100, 100));
    setBox(inner, () => rect(10, 150, 20, 20));
    expect(anchorVisible(inner)).toBe(false);
    setBox(inner, () => rect(10, 90, 20, 20));
    expect(anchorVisible(inner)).toBe(true);
    expect(anchorVisible(null)).toBe(false);
  });
});

describe('connected menus', () => {
  const referenceItem = {
    id: 'upload:a',
    name: 'lamp.png',
    status: REF_STATUS.ready,
    sha256: 'sha-a',
    blob: new Blob(['a'], { type: 'image/png' }),
    url: 'blob:draft-a',
    analyzing: false,
  };

  test('the reference row menu opens beside its row, not at the top of the page', () => {
    const references = {
      move: vi.fn(),
      remove: vi.fn(),
      retryAnalysis: vi.fn(),
      reattach: vi.fn(),
    };
    render(
      <Pane>
        <ul className="ref-list">
          <ReferenceItem
            item={referenceItem}
            index={0}
            count={2}
            references={references}
            retained={null}
          />
          <ReferenceItem
            item={{ ...referenceItem, id: 'upload:b', sha256: 'sha-b' }}
            index={1}
            count={2}
            references={references}
            retained={null}
          />
        </ul>
      </Pane>,
    );
    const pane = screen.getByTestId('pane');
    const trigger = screen.getByRole('button', {
      name: 'Actions for reference 2',
    });
    const state = layout(trigger, {
      at: { left: 560, top: 480 },
      pane: { rect: [0, 0, 640, VIEW_H] },
    });
    fireEvent.click(trigger);
    const menu = screen.getByRole('menu', { name: 'Actions for reference 2' });
    expect(menu.parentElement).toBe(document.body);
    expect(menu.style.top).toBe('532px');
    expect(menu.style.left).toBe(`${560 + 44 - MENU_W}px`);
    state.scroll = 300;
    fireEvent.scroll(pane);
    expect(menu.style.top).toBe('232px');
    fireEvent.click(
      within(menu).getByRole('menuitem', { name: 'Move earlier' }),
    );
    expect(references.move).toHaveBeenCalledWith('upload:b', -1);
  });

  test('the result More menu is reachable above the split handle and opens Compare', () => {
    const result = {
      id: 'result-7',
      title: 'Lighthouse in fog',
      alt_text: 'A lighthouse in fog',
      sha256: 'result-sha',
      provider: 'mock',
      model: 'mock-model',
      created_at: '2026-11-02T10:00:00Z',
      width: 1536,
      height: 1024,
      generation_type: 'image-edit',
      reference_images: [
        {
          id: 'upload:base',
          sha256: 'base-sha',
          role: 'base',
          filename: 'a.png',
        },
      ],
    };
    const studio = {
      job: null,
      generating: null,
      current: result,
      draft: { aspect: '3:2', mode: 'image', prompt: '' },
      discovery: { capabilities: { data: {} }, models: { data: {} } },
      watermark: { visible: false, settings: null },
      editCapability: { enabled: true, maxReferences: 3 },
      addImageReference: vi.fn(),
      referenceReading: null,
      references: {
        refs: [
          {
            ...referenceItem,
            id: 'upload:base',
            sha256: 'base-sha',
            dimensions: { width: 1024, height: 1024 },
          },
        ],
      },
      retryStorage: vi.fn(),
      removeImage: vi.fn(),
    };
    render(
      <Pane>
        <Viewer studio={studio} onEdit={() => {}} />
      </Pane>,
    );
    const trigger = screen.getByRole('button', { name: 'More actions' });
    layout(trigger, { at: { left: 640, top: 580 } });
    fireEvent.click(trigger);
    const menu = screen.getByRole('menu', { name: 'More actions' });
    // Outside the sticky pane's stacking context, so the later split handle
    // cannot paint above it or intercept presses.
    expect(menu.parentElement).toBe(document.body);
    expect(screen.getByTestId('pane').contains(menu)).toBe(false);
    const compare = within(menu).getByRole('menuitem', { name: /^Compare/ });
    act(() => {
      fireEvent.pointerDown(compare);
      fireEvent.click(compare);
    });
    expect(screen.getByRole('dialog', { name: 'Compare' })).toBeTruthy();
  });
});
