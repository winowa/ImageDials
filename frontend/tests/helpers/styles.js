import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(
  new URL('../../src/styles/index.css', import.meta.url),
);

/**
 * The application stylesheet in cascade order: each `@import` line of the
 * entry sheet is replaced by the file it names, recursively. Tests that
 * guard the cascade (rule order, specificity, `@media` blocks) read this.
 */
export function readStylesheet(file = ENTRY) {
  return readFileSync(file, 'utf8').replace(
    /^@import '([^']+)';\n/gm,
    (_match, path) => `${readStylesheet(resolve(dirname(file), path))}\n`,
  );
}
