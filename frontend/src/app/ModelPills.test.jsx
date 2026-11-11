import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import fixture from '../../../fixtures/api/model-metadata.json';
import ModelPills, { safeResourceUrl } from './ModelPills.jsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('groups base, LoRA and language metadata from the model response', () => {
  render(<ModelPills models={fixture} />);
  const image = screen.getByRole('button', {
    name: /^Image .* details$/,
  });
  expect(image.textContent).toContain('ExampleImage-v1');
  expect(image.textContent).toContain('+1 LoRA');
  expect(image.getAttribute('aria-label')).toBe(
    'Image ExampleImage-v1 +1 LoRA details',
  );
  fireEvent.click(image);
  const imageDialog = screen.getByRole('dialog', {
    name: 'Image model details',
  });
  expect(within(imageDialog).getByText('Base image model')).toBeTruthy();
  expect(within(imageDialog).getByText('LoRA 1')).toBeTruthy();
  expect(
    within(imageDialog).getAllByText('Publisher: Example Models'),
  ).toHaveLength(2);
  expect(
    within(imageDialog).getByText('Surface treatment adapter.'),
  ).toBeTruthy();
  expect(
    within(imageDialog).getAllByRole('link', { name: /resource page/ })[0].href,
  ).toBe('https://models.example.test/image');

  fireEvent.click(
    screen.getByRole('button', { name: /^Language .* details$/ }),
  );
  const languageDialog = screen.getByRole('dialog', {
    name: 'Language model details',
  });
  expect(within(languageDialog).getByText('Language model')).toBeTruthy();
  expect(
    within(languageDialog).getByText('Text composition model.'),
  ).toBeTruthy();
});

test('legacy names remain visible without creating empty disclosures', () => {
  render(
    <ModelPills
      models={{ image_model: 'Legacy image', llm_model: 'Legacy language' }}
    />,
  );
  expect(screen.getByText('Legacy image')).toBeTruthy();
  expect(screen.getByText('Legacy language')).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('missing descriptors and nullable lists do not create blank pills', () => {
  const { container } = render(
    <ModelPills
      models={{
        image_model: null,
        llm_model: 'Language only',
        models: { image: null, image_loras: null, llm: null },
      }}
    />,
  );
  expect(screen.getByText('Language only')).toBeTruthy();
  expect(container.querySelectorAll('.model-pill-item')).toHaveLength(0);
  expect(screen.queryByText('Image')).toBeNull();
});

test('long names remain fully readable and updated descriptors replace stale data', () => {
  const longName = 'Synthetic image model with a deliberately long full name';
  const { rerender } = render(
    <ModelPills models={{ image_model: 'Older model' }} />,
  );
  rerender(
    <ModelPills
      models={{
        image_model: longName,
        models: {
          image: {
            id: 'new-id',
            name: longName,
            detail: 'Updated model detail',
          },
          image_loras: [],
          llm: null,
        },
      }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /^Image .* details$/ }));
  const dialog = screen.getByRole('dialog', { name: 'Image model details' });
  expect(within(dialog).getByText(longName)).toBeTruthy();
  expect(within(dialog).getByText('Updated model detail')).toBeTruthy();
  expect(within(dialog).getByText('new-id')).toBeTruthy();
  expect(within(dialog).queryByText('Older model')).toBeNull();
});

test('resource links accept only absolute credential-free HTTP(S) URLs', () => {
  for (const unsafe of [
    'javascript:alert(1)',
    'data:text/html,unsafe',
    '//models.example.test/path',
    ['https://user:pass', 'models.example.test/path'].join('@'),
    '/relative/path',
    'https://models.example.test/with space',
    'https://models.example.test/invalid\u0000path',
  ])
    expect(safeResourceUrl(unsafe)).toBeNull();
  expect(safeResourceUrl('http://models.example.test/path')).toBe(
    'http://models.example.test/path',
  );
  expect(safeResourceUrl('https://models.example.test/path')).toBe(
    'https://models.example.test/path',
  );
});

test('unsafe URLs are omitted from the rendered resource disclosure', () => {
  render(
    <ModelPills
      models={{
        image_model: 'Unsafe-link test model',
        models: {
          image: {
            id: 'unsafe-id',
            name: 'Unsafe-link test model',
            url: 'javascript:alert(1)',
          },
          image_loras: [],
          llm: null,
        },
      }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /^Image .* details$/ }));
  const dialog = screen.getByRole('dialog', { name: 'Image model details' });
  expect(within(dialog).queryByRole('link')).toBeNull();
  expect(within(dialog).getByText('Unsafe-link test model')).toBeTruthy();
});

test('disclosures open by hover, focus and click and dismiss by Escape, outside press or repeat click', () => {
  const { container } = render(<ModelPills models={fixture} />);
  const button = screen.getByRole('button', { name: /^Image .* details$/ });
  fireEvent.mouseEnter(button);
  expect(
    screen.getByRole('dialog', { name: 'Image model details' }),
  ).toBeTruthy();
  fireEvent.mouseLeave(button);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(
    screen.queryByRole('dialog', { name: 'Image model details' }),
  ).toBeNull();

  fireEvent.focus(button);
  expect(
    screen.getByRole('dialog', { name: 'Image model details' }),
  ).toBeTruthy();
  fireEvent.keyDown(button, { key: 'Escape' });
  expect(
    screen.queryByRole('dialog', { name: 'Image model details' }),
  ).toBeNull();
  expect(document.activeElement).toBe(button);

  fireEvent.click(button);
  expect(
    screen.getByRole('dialog', { name: 'Image model details' }),
  ).toBeTruthy();
  fireEvent.click(button);
  expect(
    screen.queryByRole('dialog', { name: 'Image model details' }),
  ).toBeNull();

  fireEvent.click(button);
  fireEvent.pointerDown(container.querySelector('h1') ?? document.body);
  expect(
    screen.queryByRole('dialog', { name: 'Image model details' }),
  ).toBeNull();
});

test('a resource link is keyboard reachable and never fetched or auto-opened', () => {
  const open = vi.spyOn(window, 'open');
  const fetch = vi.spyOn(globalThis, 'fetch');
  render(<ModelPills models={fixture} />);
  const button = screen.getByRole('button', { name: /^Image .* details$/ });
  fireEvent.click(button);
  const link = screen.getAllByRole('link', { name: /resource page/ })[0];
  expect(link.href).toBe('https://models.example.test/image');
  act(() => link.focus());
  expect(document.activeElement).toBe(link);
  expect(open).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(link.getAttribute('rel')).toContain('noopener');
});

// jsdom has no layout: model only the available slot and natural pill width.
function measuredSlot(initialRoom = 220) {
  let room = initialRoom;
  const callbacks = new Set();
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(
    function () {
      return this.classList.contains('model-pills-slot') ? room : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(
    function () {
      return this.hasAttribute('data-fit') ? 520 : 0;
    },
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback) {
        this.callback = callback;
      }
      observe() {
        callbacks.add(this.callback);
      }
      disconnect() {
        callbacks.delete(this.callback);
      }
    },
  );
  return async (width) => {
    room = width;
    await act(async () => {
      [...callbacks].forEach((callback) => callback());
      await new Promise(requestAnimationFrame);
    });
  };
}

test('a measured compact capsule retains both models, LoRAs and safe resource actions', async () => {
  const resize = measuredSlot();
  const { container } = render(<ModelPills models={fixture} />);
  const trigger = screen.getByRole('button', { name: /^Models: Image/ });
  expect(trigger.getAttribute('aria-label')).toContain('ExampleLanguage-v1');
  fireEvent.click(trigger);
  const panel = screen.getByRole('dialog', { name: 'Model details' });
  for (const heading of ['Base image model', 'LoRA 1', 'Language model'])
    expect(within(panel).getByRole('heading', { name: heading })).toBeTruthy();
  expect(within(panel).getAllByRole('link')).toHaveLength(3);
  expect(panel.tabIndex).toBe(0);
  await resize(100);
  expect(container.querySelector('[data-combined]')).toBeTruthy();
  expect(
    screen.getByRole('button', { name: /^Models: Image/ }).textContent,
  ).toBe('Models');
  await resize(600);
  expect(
    screen.getByRole('button', { name: /^Image .* details$/ }),
  ).toBeTruthy();
  expect(
    screen.getByRole('button', { name: /^Language .* details$/ }),
  ).toBeTruthy();
  expect(container.querySelector('[data-combined]')).toBeNull();
});

test('legacy models also disclose their complete identities in a narrow slot', () => {
  measuredSlot(100);
  render(
    <ModelPills
      models={{ image_model: 'Legacy image', llm_model: 'Legacy language' }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /^Models: Image/ }));
  const panel = screen.getByRole('dialog', { name: 'Model details' });
  expect(within(panel).getByText('Legacy image')).toBeTruthy();
  expect(within(panel).getByText('Legacy language')).toBeTruthy();
  expect(panel.tabIndex).toBe(-1);
});

test('rotation preserves an open image disclosure and transfers a disappearing Language stop to Models', async () => {
  const resize = measuredSlot(600);
  render(<ModelPills models={fixture} />);
  const image = screen.getByRole('button', { name: /^Image .* details$/ });
  act(() => image.focus());
  fireEvent.click(image);
  await resize(100);
  const capsule = screen.getByRole('button', { name: /^Models: Image/ });
  expect(capsule).toBe(image);
  expect(document.activeElement).toBe(capsule);
  expect(screen.getByRole('dialog', { name: 'Model details' })).toBeTruthy();
  await resize(600);
  const language = screen.getByRole('button', {
    name: /^Language .* details$/,
  });
  act(() => language.focus());
  await resize(100);
  expect(document.activeElement).toBe(capsule);
  expect(screen.getByRole('dialog', { name: 'Model details' })).toBeTruthy();
});
