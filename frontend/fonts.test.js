// @vitest-environment node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

import { readStylesheet } from './tests/helpers/styles.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const css = readStylesheet();
const html = readFileSync(join(root, 'index.html'), 'utf8');
const fontDirectory = join(root, 'public/fonts');

test('every @font-face source is a bundled local WOFF2 file', () => {
  const sources = [...css.matchAll(/url\('([^']+)'\)/g)].map((m) => m[1]);
  expect(sources.length).toBeGreaterThan(0);
  for (const source of sources) {
    expect(source).toMatch(/^\/fonts\/[\w.-]+\.woff2$/);
    expect(existsSync(join(root, 'public', source))).toBe(true);
  }
});

test('no stylesheet or document requests a remote font', () => {
  expect(css).not.toMatch(/https?:\/\//);
  expect(css).not.toMatch(/@import/);
  expect(html).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
  expect(html).not.toMatch(/rel="(stylesheet|preconnect)"/);
});

test('bundled fonts ship with license texts and stay compact', () => {
  const files = readdirSync(fontDirectory).filter((f) => f.endsWith('.woff2'));
  expect(files.length).toBe(3);
  const licenses = readdirSync(join(fontDirectory, 'licenses'));
  expect(licenses.length).toBe(3);
  for (const license of licenses) {
    const text = readFileSync(join(fontDirectory, 'licenses', license), 'utf8');
    expect(text).toContain('SIL OPEN FONT LICENSE Version 1.1');
  }
  let total = 0;
  for (const file of files) {
    const bytes = readFileSync(join(fontDirectory, file));
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('wOF2');
    total += bytes.length;
  }
  expect(total).toBeLessThan(120 * 1024);
});

test('role tokens are defined for display, body, UI and mono', () => {
  for (const token of [
    '--font-display',
    '--font-body',
    '--font-ui',
    '--font-mono',
    '--type-title',
    '--type-code',
  ]) {
    expect(css).toContain(`${token}:`);
  }
});

test('preloaded fonts exist', () => {
  const hrefs = [...html.matchAll(/rel="preload"\s+href="([^"]+)"/g)].map(
    (m) => m[1],
  );
  expect(hrefs.length).toBe(2);
  for (const href of hrefs)
    expect(existsSync(join(root, 'public', href))).toBe(true);
});
