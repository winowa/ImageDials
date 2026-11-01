import { expect, test } from 'vitest';
import { runtimeConfig } from './runtime-config.js';

const env = {
  FRONTEND_HOST: '127.0.0.1',
  FRONTEND_PORT: '23141',
  API_HOST: '127.0.0.1',
  API_PORT: '23142',
  FRONTEND_ALLOWED_HOSTS: 'localhost,imagedials.test',
  API_UPSTREAM_URL: 'http://127.0.0.1:23142',
};

test('uses supplied ports/upstream and forbids automatic port fallback', () => {
  const config = runtimeConfig(env);
  expect(config.port).toBe(23141);
  expect(config.strictPort).toBe(true);
  expect(config.proxy['/api'].target).toBe(env.API_UPSTREAM_URL);
  expect(config.allowedHosts).toEqual(['localhost', 'imagedials.test']);
});

test.each(['', '0', '65536', '-1', '23abc', '1.5'])(
  'rejects invalid port %s',
  (port) => {
    expect(() => runtimeConfig({ ...env, FRONTEND_PORT: port })).toThrow(
      /FRONTEND_PORT/,
    );
  },
);

test('rejects conflicting ports and inconsistent API upstream', () => {
  expect(() => runtimeConfig({ ...env, FRONTEND_PORT: env.API_PORT })).toThrow(
    /different/,
  );
  expect(() =>
    runtimeConfig({ ...env, API_UPSTREAM_URL: 'http://localhost:23143' }),
  ).toThrow(/match/);
  expect(() => runtimeConfig({ ...env, FRONTEND_ALLOWED_HOSTS: '*' })).toThrow(
    /hostnames/,
  );
});
