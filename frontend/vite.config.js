import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { runtimeConfig } from './runtime-config.js';
import { loadRuntimeEnv } from '../scripts/runtime-env.mjs';

export default defineConfig(() => ({
  envDir: false,
  plugins: [react()],
  server: runtimeConfig(loadRuntimeEnv()),
  preview: runtimeConfig(loadRuntimeEnv()),
  test: {
    environment: 'jsdom',
    globals: true,
  },
}));
