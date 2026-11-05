import { availableParallelism } from 'node:os';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { appBasePath, runtimeConfig } from './runtime-config.js';
import { loadRuntimeEnv } from '../scripts/runtime-env.mjs';

// Bound simultaneous jsdom processes on shared or resource-limited CI workers.
const MAX_CONCURRENT_TEST_WORKERS = 4;

export default defineConfig(() => ({
  base: `${appBasePath(loadRuntimeEnv())}/`,
  envDir: false,
  plugins: [react()],
  server: runtimeConfig(loadRuntimeEnv()),
  preview: runtimeConfig(loadRuntimeEnv()),
  test: {
    environment: 'jsdom',
    globals: true,
    maxWorkers: Math.min(MAX_CONCURRENT_TEST_WORKERS, availableParallelism()),
  },
}));
