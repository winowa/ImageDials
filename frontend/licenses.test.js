// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const root = fileURLToPath(new URL('.', import.meta.url));

test('bundled React runtime packages retain their complete license notices', () => {
  const notices = readFileSync(`${root}/public/licenses/react.txt`, 'utf8');
  const lock = JSON.parse(readFileSync(`${root}/package-lock.json`, 'utf8'));
  for (const name of ['react', 'react-dom', 'scheduler']) {
    const packageRoot = `${root}/node_modules/${name}`;
    const installed = JSON.parse(
      readFileSync(`${packageRoot}/package.json`, 'utf8'),
    );
    expect(installed.version).toBe(
      lock.packages[`node_modules/${name}`].version,
    );
    expect(notices).toContain(`${name} ${installed.version}`);
    expect(notices).toContain(
      readFileSync(`${packageRoot}/LICENSE`, 'utf8').trim(),
    );
  }
});
