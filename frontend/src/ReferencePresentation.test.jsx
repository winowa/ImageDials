import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { PromptingHelp, ReferenceItem } from './References.jsx';
import { REF_STATUS } from './references.js';
import editing from '../../fixtures/api/image-editing.json';

afterEach(cleanup);
const item = (name) => ({
  id: 'synthetic-reference',
  name,
  status: REF_STATUS.ready,
  description: 'A synthetic green square',
  dimensions: { width: 40, height: 24 },
});
const refs = {
  retryAnalysis: vi.fn(),
  reattach: vi.fn(),
  remove: vi.fn(),
  move: vi.fn(),
};
test.each(['painting study Ω.png', 'holiday-2026.png'])(
  'human filename remains visible: %s',
  (name) => {
    render(
      <ReferenceItem item={item(name)} index={0} count={1} references={refs} />,
    );
    expect(screen.getByText(name).closest('details')).toBeNull();
    expect(
      screen.getByRole('listitem', { name: `Base: ${name}` }),
    ).toBeTruthy();
    expect(screen.getByText('40×24')).toBeTruthy();
  },
);
test('machine filename moves into details with complete identity and prompt tags retained', () => {
  const name = '12345678-abcd-1234-5678-abcdef012345.png';
  render(
    <ReferenceItem
      item={item(name)}
      index={0}
      count={3}
      prompting={editing.capabilities.prompting}
      references={refs}
    />,
  );
  const details = screen.getByText(name).closest('details');
  expect(details.open).toBe(false);
  fireEvent.click(screen.getByText('File details'));
  expect(screen.getByRole('listitem', { name: `Base: ${name}` })).toBeTruthy();
  expect(screen.getByText('<image1>')).toBeTruthy();
  expect(screen.getByText('40×24')).toBeTruthy();
});
test('merged reference help preserves retention consequence, official HTTPS guide, tags and examples', () => {
  render(
    <PromptingHelp prompting={editing.capabilities.prompting} retention />,
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Image editing prompt guidance' }),
  );
  const dialog = screen.getByRole('dialog');
  expect(dialog.textContent).toContain(
    'Draft files are saved in this browser across reloads',
  );
  expect(dialog.textContent).toContain('<image4>');
  expect(dialog.textContent).toContain('Place the lamp');
  expect(
    screen
      .getByRole('link', { name: /Official prompting guide/ })
      .getAttribute('href'),
  ).toBe(editing.capabilities.prompting.guidance_url);
  expect(
    screen.queryByRole('button', { name: 'References after reload' }),
  ).toBeNull();
});
