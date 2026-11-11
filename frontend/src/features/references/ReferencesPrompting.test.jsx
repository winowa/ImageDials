import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, test } from 'vitest';

import editing from '../../../../fixtures/api/image-editing.json';
import {
  PromptingHelp,
  ReferenceItem,
  referencePromptLabel,
} from './References.jsx';

const prompting = editing.capabilities.prompting;

test('prompt help shows preferred ordered tags, concise guidance and official source', () => {
  render(<PromptingHelp prompting={prompting} />);
  fireEvent.click(
    screen.getByRole('button', { name: 'Image editing prompt guidance' }),
  );

  const dialog = screen.getByRole('dialog', {
    name: 'Image editing prompt guidance',
  });
  expect(within(dialog).getByText('Qwen-Image-2.1')).toBeTruthy();
  expect(within(dialog).getByText('Multi-image tags, in order')).toBeTruthy();
  expect(within(dialog).getByText('<image1>')).toBeTruthy();
  expect(within(dialog).getByText('<image4>')).toBeTruthy();
  expect(
    within(dialog).getByText(
      /With one image, use natural wording without tags\./,
    ),
  ).toBeTruthy();
  expect(within(dialog).getByText(/Place the lamp from <image2>/)).toBeTruthy();

  const link = within(dialog).getByRole('link', {
    name: 'Official prompting guide',
  });
  expect(link.getAttribute('href')).toBe(prompting.guidance_url);
  expect(link.getAttribute('target')).toBe('_blank');
  expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  expect(link.classList.contains('reference-prompt-guide')).toBe(true);
});

test('attached image labels follow the current model mapping and reference order', () => {
  expect(referencePromptLabel(prompting, 1, 0)).toBe('the image');
  expect(referencePromptLabel(prompting, 2, 0)).toBe('<image1>');
  expect(referencePromptLabel(prompting, 2, 1)).toBe('<image2>');
  expect(referencePromptLabel(prompting, 3, 2)).toBe('<image3>');
  expect(referencePromptLabel(prompting, 4, 3)).toBe('<image4>');
  expect(referencePromptLabel(prompting, 2, 2)).toBeNull();
});

test('reference rows display model tags in the current order', () => {
  const references = {
    move: () => {},
    remove: () => {},
    retryAnalysis: () => {},
    reattach: () => {},
  };
  const items = [
    { id: 'one', name: 'base.png', status: 'ready' },
    { id: 'two', name: 'palette.png', status: 'ready' },
  ];
  const { container, rerender } = render(
    items.map((item, index) => (
      <ReferenceItem
        key={item.id}
        item={item}
        index={index}
        count={2}
        prompting={prompting}
        references={references}
      />
    )),
  );
  const labels = () =>
    [...container.querySelectorAll('.ref-prompt-label')].map((node) =>
      node.textContent.trim(),
    );
  expect(labels()).toEqual(['<image1>', '<image2>']);

  rerender(
    [...items]
      .reverse()
      .map((item, index) => (
        <ReferenceItem
          key={item.id}
          item={item}
          index={index}
          count={2}
          prompting={prompting}
          references={references}
        />
      )),
  );
  expect(labels()).toEqual(['<image1>', '<image2>']);
  expect(container.querySelector('.ref-item strong').textContent).toBe('Base');
  expect(container.querySelector('.ref-name').textContent).toBe('palette.png');
});

test('prompt help omits a guidance URL unless it is HTTPS without credentials', () => {
  const { rerender } = render(
    <PromptingHelp
      prompting={{ ...prompting, guidance_url: 'javascript:alert(1)' }}
    />,
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Image editing prompt guidance' }),
  );
  expect(
    screen.queryByRole('link', { name: /Official prompting guide/ }),
  ).toBeNull();

  rerender(
    <PromptingHelp
      prompting={{
        ...prompting,
        guidance_url: ['https://u:p', 'h.example'].join('@'),
      }}
    />,
  );
  expect(
    screen.queryByRole('link', { name: /Official prompting guide/ }),
  ).toBeNull();
});
