import React from 'react';
import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import Variations from './Variations.jsx';

const result = (index, extra = {}) => ({
  id: `image-${index}`,
  storage_id: 'saved',
  filename: `image-${index}.png`,
  title: `Image ${index}`,
  variation: { group_id: 'group-one', count: 2, index },
  ...extra,
});
const studio = (history, current) => ({
  history,
  current,
  select: vi.fn(),
  variations: null,
});

test('a selected variation stays pressed when its history record is refreshed', () => {
  const one = result(0);
  const two = result(1);
  const view = render(<Variations studio={studio([one, two], { ...one })} />);
  expect(
    screen
      .getByRole('button', { name: 'Variation 1 of 2, ready' })
      .getAttribute('aria-pressed'),
  ).toBe('true');
  view.rerender(
    <Variations
      studio={studio([{ ...one, title: 'Refreshed' }, { ...two }], { ...one })}
    />,
  );
  expect(
    screen
      .getByRole('button', { name: 'Variation 1 of 2, ready' })
      .getAttribute('aria-pressed'),
  ).toBe('true');
});

test('a different private incarnation does not appear selected', () => {
  const one = result(0, { local_origin: 'generated', local_added_at: 2 });
  render(
    <Variations
      studio={studio([one, result(1)], { ...one, local_added_at: 1 })}
    />,
  );
  expect(
    screen
      .getByRole('button', { name: 'Variation 1 of 2, ready' })
      .getAttribute('aria-pressed'),
  ).toBe('false');
});
