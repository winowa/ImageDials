import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { InfoPopover } from './ui.jsx';

afterEach(cleanup);

test('informational is opt-in, removes only the container stop and preserves all preview and close behavior', () => {
  const { rerender } = render(<InfoPopover label="Details">Text</InfoPopover>);
  const trigger = screen.getByRole('button', { name: 'Details' });
  act(() => trigger.focus());
  expect(screen.getByRole('dialog').tabIndex).toBe(0);
  expect(document.activeElement).toBe(trigger);
  rerender(
    <InfoPopover label="Details" informational>
      Text
    </InfoPopover>,
  );
  expect(screen.getByRole('dialog').tabIndex).toBe(-1);
  expect(document.activeElement).toBe(trigger);
  fireEvent.keyDown(trigger, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  fireEvent.mouseEnter(trigger);
  expect(screen.getByRole('dialog')).toBeTruthy();
  fireEvent.keyDown(trigger, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(trigger);
  fireEvent.click(trigger);
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(trigger);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole('dialog')).toBeNull();
});
