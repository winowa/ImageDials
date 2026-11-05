import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import App from './App.jsx';
import {
  ACCENT_KEY,
  contrastRatio,
  DEFAULT_ACCENT,
  MIN_TEXT_CONTRAST,
  MODE_KEY,
  NEUTRALS,
  oklchToBytes,
  parseHex,
  resetAppearanceMemory,
  resolveAccent,
} from './appearance.js';
import { fakeLibrary, installApi } from './testSupport.js';

const root = document.documentElement;
const meta = () => document.querySelector('meta[name="color-scheme"]');
const jobPolicy = { pollIntervalMs: 1, maxConsecutivePollFailures: 3 };

/** A controllable `prefers-color-scheme: light` query. */
function stubSystemScheme(light) {
  const listeners = new Set();
  const query = {
    matches: light,
    addEventListener: (_, fn) => listeners.add(fn),
    removeEventListener: (_, fn) => listeners.delete(fn),
  };
  vi.stubGlobal('matchMedia', (text) =>
    text.includes('prefers-color-scheme')
      ? query
      : { matches: false, addEventListener() {}, removeEventListener() {} },
  );
  return (next) => {
    query.matches = next;
    act(() => listeners.forEach((fn) => fn({ matches: next })));
  };
}

beforeEach(() => {
  localStorage.clear();
  resetAppearanceMemory();
  root.removeAttribute('data-theme');
  root.removeAttribute('style');
  const library = fakeLibrary([]);
  installApi({ ...library.routes });
  if (!meta()) {
    const tag = document.createElement('meta');
    tag.name = 'color-scheme';
    document.head.append(tag);
  }
  meta().content = 'dark';
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const renderApp = () => render(<App jobPolicy={jobPolicy} />);
const lab = () => screen.getByRole('button', { name: 'Accent Lab' });
const open = () => {
  fireEvent.click(lab());
  return screen.getByRole('dialog', { name: 'Accent Lab' });
};
const token = (name) => root.style.getPropertyValue(name);
const stored = () => JSON.parse(localStorage.getItem(ACCENT_KEY));

/** Contrast of the accent tokens actually applied to the page. */
function appliedContrast() {
  const theme = root.dataset.theme;
  const n = Object.fromEntries(
    Object.entries(NEUTRALS[theme]).map(([k, [l, c, h]]) => [
      k,
      oklchToBytes(l, c, h),
    ]),
  );
  const accent = parseHex(token('--accent'));
  return {
    text: Math.min(
      ...[n.background, n.surface, n.surface2].map((s) =>
        contrastRatio(accent, s),
      ),
    ),
    button: contrastRatio(parseHex(token('--accent-ink')), accent),
  };
}

test('Accent Lab is in the header on every route, beside the theme toggle', async () => {
  renderApp();
  for (const route of ['Create', 'Gallery', 'Library']) {
    fireEvent.click(screen.getByRole('link', { name: route }));
    const trigger = lab();
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger.closest('header')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /Switch to (light|dark) theme/ }),
    ).toBeTruthy();
  }
  expect(document.querySelector('[title]')).toBeNull();
});

test('choosing a swatch applies a measured accent, saves it and survives a reload', () => {
  renderApp();
  const panel = open();
  fireEvent.click(within(panel).getByRole('button', { name: /Blue/ }));
  const expected = resolveAccent('dark', { ...DEFAULT_ACCENT, swatch: 'blue' });
  expect(token('--accent')).toBe(expected.tokens['--accent']);
  expect(
    within(panel)
      .getByRole('button', { name: /Blue/ })
      .getAttribute('aria-pressed'),
  ).toBe('true');
  expect(stored()).toMatchObject({ v: 1, swatch: 'blue' });
  const { text, button } = appliedContrast();
  expect(text).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
  expect(button).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
  // The readout shows what the page really uses.
  expect(within(panel).getByText(`${text.toFixed(2)}:1`)).toBeTruthy();

  cleanup();
  root.removeAttribute('style');
  renderApp();
  expect(token('--accent')).toBe(expected.tokens['--accent']);
});

test('saturation and luminance sliders change the accent and stay readable', () => {
  renderApp();
  const panel = open();
  const before = token('--accent');
  fireEvent.change(within(panel).getByLabelText('Saturation'), {
    target: { value: '150' },
  });
  expect(token('--accent')).not.toBe(before);
  expect(stored().saturation).toBe(150);
  const sliderLuminance = within(panel).getByLabelText('Luminance');
  fireEvent.change(sliderLuminance, { target: { value: '70' } });
  expect(stored()).toMatchObject({ saturation: 150, luminance: 70 });
  expect(appliedContrast().text).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
  expect(
    within(panel).getByText(/limited to keep text readable/i),
  ).toBeTruthy();
  expect(sliderLuminance.getAttribute('aria-valuetext')).toBe('70 percent');
});

test('reset restores the default accent', () => {
  renderApp();
  const panel = open();
  fireEvent.click(within(panel).getByRole('button', { name: /Rose/ }));
  fireEvent.change(within(panel).getByLabelText('Saturation'), {
    target: { value: '60' },
  });
  fireEvent.click(within(panel).getByRole('button', { name: 'Reset accent' }));
  expect(token('--accent')).toBe(resolveAccent('dark').tokens['--accent']);
  expect(stored()).toMatchObject(DEFAULT_ACCENT);
  expect(within(panel).getByLabelText('Saturation').value).toBe('100');
});

test.each(['dark', 'light'])(
  'all unselected palette previews follow both sliders in %s mode',
  (theme) => {
    localStorage.setItem(MODE_KEY, theme);
    renderApp();
    const panel = open();
    fireEvent.click(within(panel).getByRole('button', { name: /Rebecca/ }));
    const previews = () =>
      [...panel.querySelectorAll('.al-swatch[aria-pressed="false"]')].map(
        (button) => ({
          code: button.querySelector('code').textContent,
          dot: button.querySelector('.al-dot').style.background,
        }),
      );
    const initial = previews();
    fireEvent.change(within(panel).getByLabelText('Saturation'), {
      target: { value: '50' },
    });
    const saturated = previews();
    for (let i = 0; i < initial.length; i += 1) {
      expect(saturated[i].code).not.toBe(initial[i].code);
      expect(saturated[i].dot).not.toBe(initial[i].dot);
    }
    fireEvent.change(within(panel).getByLabelText('Luminance'), {
      target: { value: '85' },
    });
    const luminant = previews();
    for (let i = 0; i < saturated.length; i += 1) {
      expect(luminant[i].code).not.toBe(saturated[i].code);
      expect(luminant[i].dot).not.toBe(saturated[i].dot);
    }
    expect(
      within(panel)
        .getByRole('button', { name: /Rebecca/ })
        .getAttribute('aria-pressed'),
    ).toBe('true');
  },
);

test('the header toggle and the theme choice stay one selection', () => {
  const setSystem = stubSystemScheme(false);
  renderApp();
  expect(root.dataset.theme).toBe('dark');
  const panel = open();
  fireEvent.click(within(panel).getByRole('radio', { name: 'System' }));
  expect(localStorage.getItem(MODE_KEY)).toBe('system');
  setSystem(true);
  expect(root.dataset.theme).toBe('light');
  expect(root.style.colorScheme).toBe('only light');
  expect(meta().content).toBe('only light');
  setSystem(false);
  expect(root.dataset.theme).toBe('dark');
  expect(meta().content).toBe('dark');
  setSystem(true);
  // The native toggle picks the opposite of what is showing, explicitly.
  fireEvent.click(screen.getByRole('button', { name: 'Switch to dark theme' }));
  expect(localStorage.getItem(MODE_KEY)).toBe('dark');
  expect(within(panel).getByRole('radio', { name: 'Dark' }).checked).toBe(true);
  setSystem(false);
  setSystem(true);
  expect(root.dataset.theme).toBe('dark');
  // The accent is re-measured for the theme in force.
  expect(token('--accent')).toBe(resolveAccent('dark').tokens['--accent']);
  fireEvent.click(within(panel).getByRole('radio', { name: 'Light' }));
  expect(token('--accent')).toBe(resolveAccent('light').tokens['--accent']);
  expect(root.style.colorScheme).toBe('only light');
});

test('dark is the default when nothing is stored, and system without matchMedia is dark', () => {
  renderApp();
  expect(root.dataset.theme).toBe('dark');
  expect(root.style.colorScheme).toBe('dark');
  cleanup();
  localStorage.setItem(MODE_KEY, 'system');
  vi.stubGlobal('matchMedia', undefined);
  renderApp();
  expect(root.dataset.theme).toBe('dark');
});

test('a stored light mode and accent apply on load', () => {
  localStorage.setItem(MODE_KEY, 'light');
  localStorage.setItem(
    ACCENT_KEY,
    JSON.stringify({ v: 1, swatch: 'teal', saturation: 120, luminance: 90 }),
  );
  renderApp();
  expect(root.dataset.theme).toBe('light');
  expect(token('--accent')).toBe(
    resolveAccent('light', { swatch: 'teal', saturation: 120, luminance: 90 })
      .tokens['--accent'],
  );
});

test.each([
  ['unparseable', 'not json{'],
  ['wrong version', JSON.stringify({ v: 2, swatch: 'blue' })],
  ['unknown values', JSON.stringify({ v: 1, swatch: 7, saturation: 'x' })],
  ['null', 'null'],
])('a corrupt accent record (%s) falls back to defaults', (_, value) => {
  localStorage.setItem(MODE_KEY, 'neon');
  localStorage.setItem(ACCENT_KEY, value);
  renderApp();
  expect(root.dataset.theme).toBe('dark');
  expect(token('--accent')).toBe(resolveAccent('dark').tokens['--accent']);
  const panel = open();
  expect(within(panel).getByLabelText('Luminance').value).toBe('100');
});

test('denied storage still applies the choice and says it is not saved', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('denied', 'QuotaExceededError');
  });
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new DOMException('denied', 'SecurityError');
  });
  renderApp();
  const panel = open();
  expect(within(panel).queryByText(/not saved/i)).toBeNull();
  fireEvent.click(within(panel).getByRole('button', { name: /Violet/ }));
  expect(token('--accent')).toBe(
    resolveAccent('dark', { ...DEFAULT_ACCENT, swatch: 'violet' }).tokens[
      '--accent'
    ],
  );
  expect(within(panel).getByText(/not saved/i)).toBeTruthy();
  fireEvent.click(
    screen.getByRole('button', { name: 'Switch to light theme' }),
  );
  expect(root.dataset.theme).toBe('light');
});

test('another tab changing or clearing storage updates this one', () => {
  renderApp();
  localStorage.setItem(MODE_KEY, 'light');
  localStorage.setItem(
    ACCENT_KEY,
    JSON.stringify({ v: 1, swatch: 'plum', saturation: 100, luminance: 100 }),
  );
  act(() => {
    window.dispatchEvent(new StorageEvent('storage', { key: MODE_KEY }));
    window.dispatchEvent(new StorageEvent('storage', { key: ACCENT_KEY }));
  });
  expect(root.dataset.theme).toBe('light');
  expect(token('--accent')).toBe(
    resolveAccent('light', { ...DEFAULT_ACCENT, swatch: 'plum' }).tokens[
      '--accent'
    ],
  );
  localStorage.clear();
  act(() => {
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
  });
  expect(root.dataset.theme).toBe('dark');
  expect(token('--accent')).toBe(resolveAccent('dark').tokens['--accent']);
});

test('the panel opens on hover and focus, and tapping pins it', () => {
  renderApp();
  const anchor = lab().parentElement;
  fireEvent.mouseEnter(anchor);
  expect(screen.getByRole('dialog', { name: 'Accent Lab' })).toBeTruthy();
  fireEvent.mouseLeave(anchor);
  vi.useFakeTimers();
  fireEvent.mouseEnter(anchor);
  fireEvent.click(lab());
  fireEvent.mouseLeave(anchor);
  act(() => vi.advanceTimersByTime(500));
  expect(screen.getByRole('dialog', { name: 'Accent Lab' })).toBeTruthy();
  expect(lab().getAttribute('aria-expanded')).toBe('true');
});

test('the trigger again, an outside press and Escape close it; Escape does not reopen it', () => {
  renderApp();
  open();
  fireEvent.click(lab());
  expect(screen.queryByRole('dialog', { name: 'Accent Lab' })).toBeNull();

  open();
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole('dialog', { name: 'Accent Lab' })).toBeNull();

  const panel = open();
  within(panel).getByRole('button', { name: /Moss/ }).focus();
  fireEvent.keyDown(document.activeElement, { key: 'Escape' });
  expect(screen.queryByRole('dialog', { name: 'Accent Lab' })).toBeNull();
  expect(document.activeElement).toBe(lab());

  // Hover-opened with focus elsewhere: Escape still closes.
  fireEvent.mouseEnter(lab().parentElement);
  expect(screen.getByRole('dialog', { name: 'Accent Lab' })).toBeTruthy();
  lab().blur();
  fireEvent.keyDown(document.body, { key: 'Escape' });
  expect(screen.queryByRole('dialog', { name: 'Accent Lab' })).toBeNull();
});

test('controls are labelled, and focus inside the panel keeps it open', () => {
  vi.useFakeTimers();
  renderApp();
  fireEvent.mouseEnter(lab().parentElement);
  const panel = screen.getByRole('dialog', { name: 'Accent Lab' });
  within(panel).getByRole('button', { name: /Gold/ }).focus();
  fireEvent.mouseLeave(lab().parentElement);
  act(() => vi.advanceTimersByTime(500));
  expect(screen.getByRole('dialog', { name: 'Accent Lab' })).toBeTruthy();
  for (const name of ['Saturation', 'Luminance'])
    expect(within(panel).getByLabelText(name).type).toBe('range');
  expect(within(panel).getAllByRole('radio')).toHaveLength(3);
  expect(within(panel).getAllByRole('button', { name: /#/ })).toHaveLength(14);
});

test('the first-paint script replays the saved theme and accent', () => {
  const html = readFileSync(
    resolve(import.meta.dirname, '../index.html'),
    'utf8',
  );
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  const run = () => new Function(script)();
  const paint = resolveAccent('light', { ...DEFAULT_ACCENT, swatch: 'blue' });
  const snapshot = {
    dark: resolveAccent('dark', { ...DEFAULT_ACCENT, swatch: 'blue' }).tokens,
    light: paint.tokens,
  };
  localStorage.setItem(MODE_KEY, 'system');
  localStorage.setItem(ACCENT_KEY, JSON.stringify({ v: 1, paint: snapshot }));
  stubSystemScheme(true);
  run();
  expect(root.dataset.theme).toBe('light');
  expect(root.style.colorScheme).toBe('only light');
  expect(meta().content).toBe('only light');
  expect(token('--accent')).toBe(paint.tokens['--accent']);
  // A hostile or damaged snapshot is ignored rather than applied.
  root.removeAttribute('style');
  localStorage.setItem(
    ACCENT_KEY,
    JSON.stringify({
      v: 1,
      paint: { light: { ...snapshot.light, '--accent': 'url(x)' } },
    }),
  );
  run();
  expect(token('--accent')).toBe('');
  localStorage.setItem(ACCENT_KEY, 'garbage');
  expect(run).not.toThrow();
});

test('Rebecca exposes its exact requested anchor and the applied dark-theme adjustment', () => {
  renderApp();
  const panel = open();
  fireEvent.click(within(panel).getByRole('button', { name: /Rebecca/ }));
  fireEvent.change(within(panel).getByLabelText('Saturation'), {
    target: { value: '100' },
  });
  const requested = within(panel).getByRole('region', {
    name: 'Requested contrast',
  });
  expect(within(requested).getByText('#663399')).toBeTruthy();
  expect(requested.dataset.level).toBe('error');
  expect(within(requested).getByText('Darkest background')).toBeTruthy();
  expect(within(requested).getByText(/Below 4.5:1/)).toBeTruthy();
  expect(within(requested).getByText(/Applied/)).toBeTruthy();
  expect(appliedContrast().text).toBeGreaterThanOrEqual(4.5);
  fireEvent.click(
    within(panel).getByRole('radio', { name: 'Light', exact: true }),
  );
  expect(requested.dataset.level).toBe('pass');
  expect(within(requested).getByText('Lightest background')).toBeTruthy();
  expect(within(requested).getByText('AAA')).toBeTruthy();
  expect(token('--accent')).toBe('#663399');
  cleanup();
  renderApp();
  const restored = open();
  expect(
    within(restored)
      .getByRole('button', { name: /Rebecca/ })
      .getAttribute('aria-pressed'),
  ).toBe('true');
  expect(
    within(restored).getByRole('region', { name: 'Requested contrast' }).dataset
      .level,
  ).toBe('pass');
});

test('contrast thresholds link directly to the WCAG 2.2 contrast guideline', () => {
  renderApp();
  const panel = open();
  const link = within(panel).getByRole('link', {
    name: 'WCAG 2.2 contrast guidelines',
    hidden: true,
  });
  expect(link.getAttribute('href')).toBe(
    'https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html',
  );
  expect(link.closest('details').querySelector('summary').textContent).toBe(
    'Contrast thresholds',
  );
});

test('Rebecca can reach an unadjusted passing dark accent and retain it after reload', () => {
  renderApp();
  const panel = open();
  fireEvent.click(within(panel).getByRole('button', { name: /Rebecca/ }));
  fireEvent.change(within(panel).getByLabelText('Luminance'), {
    target: { value: '150' },
  });
  expect(
    within(panel).getByRole('region', { name: 'Requested contrast' }).dataset
      .level,
  ).toBe('pass');
  expect(within(panel).queryByText(/Luminance limited/)).toBeNull();
  expect(stored()).toMatchObject({
    swatch: 'rebecca',
    saturation: 100,
    luminance: 150,
  });
  expect(appliedContrast().text).toBeGreaterThanOrEqual(4.5);
  const applied = token('--accent');
  cleanup();
  renderApp();
  const restored = open();
  expect(within(restored).getByLabelText('Luminance').value).toBe('150');
  expect(token('--accent')).toBe(applied);
});

test('requested warning and error update with sliders while the applied UI remains safe', () => {
  renderApp();
  const panel = open();
  fireEvent.click(within(panel).getByRole('button', { name: /Blue/ }));
  fireEvent.change(within(panel).getByLabelText('Saturation'), {
    target: { value: '50' },
  });
  fireEvent.change(within(panel).getByLabelText('Luminance'), {
    target: { value: '75' },
  });
  const requested = within(panel).getByRole('region', {
    name: 'Requested contrast',
  });
  expect(requested.dataset.level).toBe('warning');
  expect(within(requested).getByText('Near limit')).toBeTruthy();
  fireEvent.change(within(panel).getByLabelText('Luminance'), {
    target: { value: '70' },
  });
  expect(requested.dataset.level).toBe('error');
  expect(appliedContrast().text).toBeGreaterThanOrEqual(4.5);
  fireEvent.change(within(panel).getByLabelText('Luminance'), {
    target: { value: '100' },
  });
  expect(requested.dataset.level).toBe('pass');
  expect(within(requested).queryByText('Near limit')).toBeNull();
  fireEvent.click(within(panel).getByRole('button', { name: 'Reset accent' }));
  expect(stored()).toMatchObject(DEFAULT_ACCENT);
});

test('Lagoon has a distinct exact anchor and labels low requested light-theme contrast honestly', () => {
  renderApp();
  const panel = open();
  fireEvent.click(within(panel).getByRole('button', { name: /Lagoon/ }));
  fireEvent.change(within(panel).getByLabelText('Saturation'), {
    target: { value: '100' },
  });
  const requested = within(panel).getByRole('region', {
    name: 'Requested contrast',
  });
  expect(within(requested).getByText('#00a8b5')).toBeTruthy();
  fireEvent.click(
    within(panel).getByRole('radio', { name: 'Light', exact: true }),
  );
  expect(requested.dataset.level).toBe('error');
  expect(appliedContrast().text).toBeGreaterThanOrEqual(4.5);
  expect(within(panel).getByText(/Warning margin: 4.5–5:1/)).toBeTruthy();
  expect(document.querySelector('[title]')).toBeNull();
});

test('contrast error details keep the lab open across portal focus, pointer input and inner Escape', async () => {
  renderApp();
  const panel = open();
  fireEvent.click(within(panel).getByRole('button', { name: /Rebecca/ }));
  fireEvent.change(within(panel).getByLabelText('Saturation'), {
    target: { value: '100' },
  });
  const trigger = within(panel).getByRole('button', {
    name: 'Requested contrast error details',
  });
  fireEvent.click(trigger);
  const details = await screen.findByRole('dialog', {
    name: 'Requested contrast error details',
  });
  await waitFor(() => expect(document.activeElement).toBe(details));
  expect(screen.getByRole('dialog', { name: 'Accent Lab' })).toBe(panel);
  expect(within(details).getByText('Contrast')).toBeTruthy();
  expect(within(details).getByText('Threshold')).toBeTruthy();
  expect(within(details).getByText('4.5:1 normal text')).toBeTruthy();
  expect(within(details).getByText('Retained data')).toBeTruthy();
  expect(within(details).queryByText('HTTP status')).toBeNull();
  fireEvent.pointerDown(details);
  expect(screen.getByRole('dialog', { name: 'Accent Lab' })).toBe(panel);
  fireEvent.keyDown(details, { key: 'Escape' });
  expect(
    screen.queryByRole('dialog', { name: 'Requested contrast error details' }),
  ).toBeNull();
  expect(screen.getByRole('dialog', { name: 'Accent Lab' })).toBe(panel);
  expect(document.activeElement).toBe(trigger);
  fireEvent.keyDown(trigger, { key: 'Escape' });
  expect(screen.queryByRole('dialog', { name: 'Accent Lab' })).toBeNull();
});

test('near-limit and adjusted-applied warnings use clickable shared details controls', async () => {
  renderApp();
  const panel = open();
  fireEvent.click(within(panel).getByRole('button', { name: /Blue/ }));
  fireEvent.change(within(panel).getByLabelText('Saturation'), {
    target: { value: '50' },
  });
  fireEvent.change(within(panel).getByLabelText('Luminance'), {
    target: { value: '75' },
  });
  const warning = within(panel).getByRole('button', {
    name: 'Requested contrast warning details',
  });
  expect(warning.closest('[data-severity]').dataset.severity).toBe('warning');
  fireEvent.click(warning);
  const details = await screen.findByRole('dialog', {
    name: 'Requested contrast warning details',
  });
  expect(within(details).getByText(/Requested color: Near/)).toBeTruthy();
  fireEvent.click(
    within(details).getByRole('button', { name: 'Close details' }),
  );
  expect(
    within(panel).getByRole('button', {
      name: 'Applied accent adjustment details',
    }),
  ).toBeTruthy();
});
