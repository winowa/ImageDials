import React from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';

import { ErrorDetails, WarningDetails } from './ErrorDetails.jsx';
import { httpDiagnostic, localDiagnostic } from './diagnostics.js';
import LibraryGate from './LibraryGate.jsx';
import { ImportPanel } from './Import.jsx';
import { DeleteConfirm } from './ui.jsx';

afterEach(cleanup);
const diagnostic = (
  text = ' { "detail": "Rejected", "nested":{"safe":true} }\n',
) =>
  httpDiagnostic({
    method: 'POST',
    path: '/api/example',
    response: new Response(text, {
      status: 422,
      statusText: 'Rejected',
      headers: { 'X-Request-ID': 'fixture-id' },
    }),
    text,
  });

test('details use the shared tree/raw viewer and show precise response metadata', () => {
  render(<ErrorDetails error={{ diagnostic: diagnostic() }} />);
  const button = screen.getByRole('button', { name: 'Error details' });
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(button);
  const panel = screen.getByRole('dialog', { name: 'Error details' });
  expect(panel.textContent).toContain('422 Rejected');
  expect(panel.textContent).toContain('fixture-id');
  expect(panel.querySelector('.json-tree')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Raw', exact: true }));
  expect(screen.getByLabelText('Response body text').textContent).toBe(
    diagnostic().body.text,
  );
  expect(panel.querySelector('.exchange-viewer')).toBeTruthy();
  expect(button.hasAttribute('title')).toBe(false);
});

test('focus, hover, Escape, outside and repeat press dismiss; Escape returns focus', async () => {
  render(
    <>
      <ErrorDetails error={new Error('Local failure')} />
      <button>Outside</button>
    </>,
  );
  const button = screen.getByRole('button', { name: 'Error details' });
  act(() => button.focus());
  expect(screen.getByRole('dialog')).toBeTruthy();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(button);
  fireEvent.mouseEnter(button);
  expect(screen.getByRole('dialog')).toBeTruthy();
  fireEvent.click(button);
  fireEvent.click(button);
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(button);
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.mouseEnter(button);
  fireEvent.mouseLeave(button);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

test('malicious response markup is inert text; raw JSON credentials are never mounted', () => {
  const text = '<html><script>window.pwned=true</script></html>';
  const { container, unmount } = render(
    <ErrorDetails error={{ diagnostic: diagnostic(text) }} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Error details' }));
  expect(document.querySelector('.diagnostic-popover script')).toBeNull();
  expect(screen.getByLabelText('Response body text').textContent).toBe(text);
  expect(container.querySelector('[title]')).toBeNull();
  unmount();
  render(
    <ErrorDetails
      error={{
        diagnostic: diagnostic(
          '{"apiKey":"private-value","detail":"Rejected"}',
        ),
      }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Error details' }));
  fireEvent.click(screen.getByRole('button', { name: 'Raw', exact: true }));
  expect(document.body.textContent).not.toContain('private-value');
  expect(document.body.textContent).toContain('Credentials redacted.');
});

test('warnings remain nonblocking, label local reasons honestly, and unmount their portal with the alert', () => {
  const { rerender } = render(
    <WarningDetails
      warning="Cache unavailable"
      diagnostic={localDiagnostic({
        category: 'storage',
        reason: 'Quota exceeded',
      })}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Warning details' }));
  expect(screen.getByRole('dialog').textContent).toContain('Quota exceeded');
  expect(screen.getByRole('dialog').textContent).not.toContain('HTTP status');
  expect(screen.queryByRole('alert')).toBeNull();
  rerender(null);
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('Library loading error and stale refresh warning both connect their retained diagnostic', () => {
  const images = {
    status: 'error',
    items: [],
    error: 'Load failed',
    errorDetail: { diagnostic: diagnostic() },
  };
  const { rerender } = render(
    <LibraryGate images={images} reload={() => {}}>
      Saved media
    </LibraryGate>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Error details' }));
  expect(screen.getByRole('dialog').textContent).toContain('fixture-id');
  rerender(
    <LibraryGate images={{ ...images, items: [{}] }} reload={() => {}}>
      Saved media
    </LibraryGate>,
  );
  expect(screen.getByText('Saved media')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Warning details' }));
  expect(screen.getByRole('dialog').textContent).toContain('fixture-id');
});

test('Import failure and nonblocking description failure expose their own details', () => {
  const studio = {
    discovery: { capabilities: {} },
    importState: {
      phase: 'error',
      error: { message: 'Import rejected', diagnostic: diagnostic() },
      descriptionStatus: {
        status: 'unavailable',
        message: 'Description unavailable',
        diagnostic: localDiagnostic({
          category: 'provider',
          reason: 'Provider omitted a description',
        }),
      },
    },
  };
  render(<ImportPanel studio={studio} />);
  fireEvent.click(screen.getByRole('button', { name: 'Error details' }));
  expect(screen.getByRole('dialog').textContent).toContain('422');
  fireEvent.keyDown(document, { key: 'Escape' });
  fireEvent.click(screen.getByRole('button', { name: 'Warning details' }));
  expect(screen.getByRole('dialog').textContent).toContain(
    'Provider omitted a description',
  );
});

test('portal keyboard boundaries return to its trigger, including inside a modal', () => {
  render(
    <div role="dialog" aria-label="Parent">
      <ErrorDetails error={new Error('Failure')} />
      <button>Retry</button>
    </div>,
  );
  const trigger = screen.getByRole('button', { name: 'Error details' });
  fireEvent.click(trigger);
  const close = screen.getByRole('button', { name: 'Close details' });
  close.focus();
  fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
  expect(screen.queryByRole('dialog', { name: 'Error details' })).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

test('an alert removed while its details have focus restores a surviving action', async () => {
  const Screen = ({ alert }) => (
    <div>
      {alert ? (
        <span>
          <ErrorDetails error={new Error('Failure')} />
        </span>
      ) : null}
      <button>Retry</button>
    </div>
  );
  const { rerender } = render(<Screen alert />);
  fireEvent.click(screen.getByRole('button', { name: 'Error details' }));
  screen.getByRole('button', { name: 'Close details' }).focus();
  rerender(<Screen alert={false} />);
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Retry' }),
    ),
  );
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('delete confirmation keeps its error string and exposes the original HTTP response', () => {
  render(
    <DeleteConfirm
      image={{ id: 'fixture', filename: 'fixture.png' }}
      busy={false}
      error="Delete refused"
      diagnostic={diagnostic(' {"detail":"Delete refused"}\n')}
      onConfirm={() => {}}
      onCancel={() => {}}
    />,
  );
  expect(screen.getByRole('alert').textContent).toContain('Delete refused');
  fireEvent.click(screen.getByRole('button', { name: 'Error details' }));
  expect(screen.getByRole('dialog').textContent).toContain('422 Rejected');
  fireEvent.click(screen.getByRole('button', { name: 'Raw', exact: true }));
  expect(screen.getByLabelText('Response body text').textContent).toBe(
    ' {"detail":"Delete refused"}\n',
  );
});

test('Escape on hover details keeps unrelated editor focus', () => {
  render(
    <>
      <input aria-label="Draft" />
      <ErrorDetails error={new Error('Failure')} />
    </>,
  );
  const input = screen.getByRole('textbox', { name: 'Draft' });
  act(() => input.focus());
  fireEvent.mouseEnter(screen.getByRole('button', { name: 'Error details' }));
  expect(screen.getByRole('dialog')).toBeTruthy();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(input);
});
