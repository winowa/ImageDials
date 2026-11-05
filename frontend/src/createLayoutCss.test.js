// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(
  fileURLToPath(new URL('./index.css', import.meta.url)),
  'utf8',
);

describe('create layout css', () => {
  it('pins the result column from the measured split state', () => {
    expect(css).toMatch(
      /\.studio\[data-split-layout='split'\] > \.studio-side\s*\{[^}]*position: sticky/,
    );
    expect(css).not.toMatch(/@media \(min-width: 62rem\)\s*\{\s*\.studio\s*\{/);
  });

  it('adapts aspect tiles to the prompt column width', () => {
    expect(css).toMatch(/container: aspect-track \/ inline-size/);
    expect(css).toMatch(/@container aspect-track \(max-width: 26rem\)/);
  });
});

describe('prompt box', () => {
  const rule = (selector) =>
    css.match(
      new RegExp(`\\n${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`),
    )?.[1] ?? '';

  it('keeps the text viewport and the action row apart inside one border', () => {
    expect(rule('.prompt-wrap')).toMatch(/flex-direction: column/);
    expect(rule('.prompt-wrap')).toMatch(/border: 1px solid/);
    expect(rule('.prompt-field')).toMatch(/border: 0/);
    expect(rule('.prompt-field')).toMatch(/resize: vertical/);
    // The row is laid out below the text, never over it.
    expect(rule('.prompt-bar')).not.toMatch(/position: absolute/);
    expect(css).not.toMatch(/\.prompt-field\s*\{[^}]*padding[^}]*7\.75rem/);
  });

  it('keeps the prompt text untracked so drag selection survives fractional pointers', () => {
    expect(rule('.prompt-field')).toMatch(/letter-spacing: 0;/);
  });
});
