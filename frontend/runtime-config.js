// Shared frontend deployment configuration.
export function runtimeConfig(env) {
  const port = (name) => {
    if (!/^[1-9]\d{0,4}$/.test(env[name] ?? '') || Number(env[name]) > 65535) {
      throw new Error(
        `${name} must be an integer between 1 and 65535 in the root .env.`,
      );
    }
    return Number(env[name]);
  };
  const frontendPort = port('FRONTEND_PORT');
  const apiPort = port('API_PORT');
  if (frontendPort === apiPort)
    throw new Error('FRONTEND_PORT and API_PORT must be different.');
  for (const name of [
    'FRONTEND_HOST',
    'API_HOST',
    'FRONTEND_ALLOWED_HOSTS',
    'API_UPSTREAM_URL',
  ]) {
    if (!env[name]?.trim()) throw new Error(`Set ${name} in the root .env.`);
  }
  const upstream = new URL(env.API_UPSTREAM_URL);
  if (
    !['http:', 'https:'].includes(upstream.protocol) ||
    upstream.username ||
    upstream.password
  ) {
    throw new Error(
      'API_UPSTREAM_URL must be an HTTP(S) origin without credentials.',
    );
  }
  if (upstream.pathname !== '/' || upstream.search || upstream.hash) {
    throw new Error(
      'API_UPSTREAM_URL must be an origin without a path, query, or fragment.',
    );
  }
  const configuredPort = upstream.port
    ? Number(upstream.port)
    : upstream.protocol === 'https:'
      ? 443
      : 80;
  if (configuredPort !== apiPort)
    throw new Error('API_UPSTREAM_URL port must match API_PORT.');
  const allowedHosts = env.FRONTEND_ALLOWED_HOSTS.split(',')
    .map((host) => host.trim())
    .filter(Boolean);
  if (
    !allowedHosts.length ||
    allowedHosts.some((host) => !/^[a-z\d](?:[a-z\d.-]*[a-z\d])?$/i.test(host))
  ) {
    throw new Error('FRONTEND_ALLOWED_HOSTS must contain explicit hostnames.');
  }
  return {
    host: env.FRONTEND_HOST,
    port: frontendPort,
    strictPort: true,
    allowedHosts,
    proxy: { '/api': { target: upstream.origin, changeOrigin: true } },
  };
}
