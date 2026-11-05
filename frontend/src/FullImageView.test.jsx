import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import FullImageView from './FullImageView.jsx';

vi.mock('./ui.jsx', () => ({
  Icon: () => null,
  SavedImg: ({ image, watermark, ...props }) => (
    <img
      {...props}
      alt={image.alt_text}
      width={image.width}
      height={image.height}
      data-watermark={watermark ? 'on' : 'off'}
    />
  ),
}));

const image = {
  id: 'saved-1',
  title: 'Mountain lake',
  alt_text: 'A mountain reflected in a lake',
  width: 1600,
  height: 900,
};

afterEach(() => {
  delete document.fullscreenElement;
  delete HTMLElement.prototype.requestFullscreen;
  delete document.exitFullscreen;
});

describe('FullImageView', () => {
  test('uses native fullscreen when supported and restores focus after exit', async () => {
    const { container } = render(<FullImageView image={image} />);
    const trigger = screen.getByRole('button', {
      name: 'View image full screen',
    });
    HTMLElement.prototype.requestFullscreen = vi.fn(function request() {
      Object.defineProperty(document, 'fullscreenElement', {
        configurable: true,
        value: this,
      });
      document.dispatchEvent(new Event('fullscreenchange'));
      return Promise.resolve();
    });
    document.exitFullscreen = vi.fn(async () => {
      delete document.fullscreenElement;
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    trigger.focus();
    await act(async () => fireEvent.click(trigger));
    expect(HTMLElement.prototype.requestFullscreen).toHaveBeenCalledOnce();
    const dialog = screen.getByRole('dialog', { name: image.title });
    const close = screen.getByRole('button', { name: 'Close full image view' });
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    expect(
      screen.getByRole('img', { name: image.alt_text }).getAttribute('width'),
    ).toBe('1600');
    await act(async () => fireEvent.keyDown(document, { key: 'Escape' }));
    expect(document.exitFullscreen).toHaveBeenCalledOnce();
    await act(async () => {});
    expect(document.activeElement).toBe(trigger);
    expect(container.querySelector('.full-image-view')).toBeNull();
  });

  test.each([
    ['unsupported', undefined],
    ['rejected', vi.fn(() => Promise.reject(new Error('fullscreen denied')))],
  ])(
    'shows an enlarged dialog when fullscreen is %s',
    async (_label, request) => {
      if (request) HTMLElement.prototype.requestFullscreen = request;
      const watermark = { settings: { type: 'text' } };
      render(<FullImageView image={image} watermark={watermark} />);
      const trigger = screen.getByRole('button', {
        name: 'View image full screen',
      });
      trigger.focus();
      await act(async () => fireEvent.click(trigger));
      const dialog = screen.getByRole('dialog', { name: image.title });
      expect(dialog.style.aspectRatio).toBe('1600 / 900');
      expect(
        screen.getByRole('img', { name: image.alt_text }).dataset.watermark,
      ).toBe('on');
      const close = screen.getByRole('button', {
        name: 'Close full image view',
      });
      expect(document.activeElement).toBe(close);
      fireEvent.keyDown(dialog, { key: 'Tab' });
      expect(document.activeElement).toBe(close);
      fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
      expect(document.activeElement).toBe(close);
      fireEvent.keyDown(dialog, { key: 'Escape' });
      await act(async () => {});
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(trigger);
    },
  );

  test.each(['dismissed', 'unmounted'])(
    'does not restore a pending fullscreen request after it was %s',
    async (ending) => {
      let enterFullscreen;
      HTMLElement.prototype.requestFullscreen = vi.fn(function request() {
        const element = this;
        return new Promise((resolve) => {
          enterFullscreen = () => {
            Object.defineProperty(document, 'fullscreenElement', {
              configurable: true,
              value: element,
            });
            document.dispatchEvent(new Event('fullscreenchange'));
            resolve();
          };
        });
      });
      document.exitFullscreen = vi.fn(async () => {
        delete document.fullscreenElement;
        document.dispatchEvent(new Event('fullscreenchange'));
      });

      const view = render(<FullImageView image={image} />);
      const other = document.createElement('button');
      document.body.append(other);
      const trigger = screen.getByRole('button', {
        name: 'View image full screen',
      });
      act(() => fireEvent.click(trigger));
      if (ending === 'dismissed') {
        await act(async () =>
          fireEvent.click(
            screen.getByRole('button', { name: 'Close full image view' }),
          ),
        );
      } else {
        view.unmount();
      }

      other.focus();
      await act(async () => enterFullscreen());
      expect(document.exitFullscreen).toHaveBeenCalledOnce();
      expect(document.fullscreenElement).toBeUndefined();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(other);
      other.remove();
    },
  );

  test('a delayed native focus return cannot steal focus after reopening', async () => {
    const frames = [];
    let delayedFocus;
    let requests = 0;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    vi.spyOn(window, 'setTimeout').mockImplementation((callback) => {
      delayedFocus = callback;
      return 1;
    });
    vi.spyOn(window, 'clearTimeout').mockImplementation(() => {});
    HTMLElement.prototype.requestFullscreen = vi.fn(function request() {
      requests += 1;
      if (requests > 1) return Promise.reject(new Error('denied'));
      Object.defineProperty(document, 'fullscreenElement', {
        configurable: true,
        value: this,
      });
      document.dispatchEvent(new Event('fullscreenchange'));
      return Promise.resolve();
    });
    document.exitFullscreen = vi.fn(async () => {
      delete document.fullscreenElement;
      document.dispatchEvent(new Event('fullscreenchange'));
    });

    render(<FullImageView image={image} />);
    const trigger = screen.getByRole('button', {
      name: 'View image full screen',
    });
    await act(async () => fireEvent.click(trigger));
    await act(async () =>
      fireEvent.click(
        screen.getByRole('button', { name: 'Close full image view' }),
      ),
    );
    await act(async () => fireEvent.click(trigger));
    const close = screen.getByRole('button', { name: 'Close full image view' });

    await act(async () => {
      frames.forEach((callback) => callback());
      delayedFocus?.();
    });
    expect(document.activeElement).toBe(close);
  });
});
