import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';

import { Tip } from './ui.jsx';

test('a hover-opened tooltip is dismissed by Escape heard anywhere, without focus on the trigger', () => {
  render(
    <>
      <Tip label="Library tip">
        <a href="/print">Library</a>
      </Tip>
      <button type="button">Elsewhere</button>
    </>,
  );
  const trigger = screen.getByRole('link', { name: 'Library' });
  screen.getByRole('button', { name: 'Elsewhere' }).focus();
  fireEvent.mouseEnter(trigger.parentElement);
  expect(screen.getByRole('tooltip').textContent).toBe('Library tip');
  fireEvent.keyDown(document.activeElement, { key: 'Escape' });
  expect(screen.queryByRole('tooltip')).toBeNull();
});
