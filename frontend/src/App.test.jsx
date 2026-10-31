import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';

import App from './App.jsx';

test('shows the title', () => {
  render(<App />);

  expect(screen.getByRole('heading', { name: 'ImageDials' })).toBeTruthy();
});
