import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));

// Environment variables take precedence over literal dotenv values.
export function loadRuntimeEnv(root = projectRoot, overrides = process.env) {
  let contents;
  try {
    contents = readFileSync(join(root, '.env'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('Missing root .env. Copy .env.example and configure it.');
    }
    throw error;
  }
  return { ...parseEnv(contents), ...overrides };
}
