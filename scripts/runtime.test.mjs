import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { launchSpec } from './run.mjs';
import { loadRuntimeEnv, projectRoot } from './runtime-env.mjs';

const env = {
  FRONTEND_HOST: '127.0.0.1',
  FRONTEND_PORT: '23141',
  API_HOST: '127.0.0.1',
  API_PORT: '23142',
  API_UPSTREAM_URL: 'http://127.0.0.1:23142',
  FRONTEND_ALLOWED_HOSTS: 'localhost',
};

test('dotenv is literal data, preserves executable paths, and permits environment overrides', () => {
  const root = mkdtempSync(join(tmpdir(), 'imagedials env '));
  try {
    const executable = String.raw`C:\Program Files\Python\python.exe`;
    writeFileSync(
      join(root, '.env'),
      `API_PYTHON='${executable}'\nIDEA='$(not-a-command)'\nAPI_PORT=23142\n`,
    );
    const loaded = loadRuntimeEnv(root, { API_PORT: '23143' });
    assert.equal(loaded.API_PYTHON, executable);
    assert.equal(loaded.IDEA, '$(not-a-command)');
    assert.equal(loaded.API_PORT, '23143');
    assert.throws(
      () => loadRuntimeEnv(join(root, 'missing'), {}),
      /Missing root .env/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('selects native venv paths and passes arguments without shell quoting', () => {
  const root = join(tmpdir(), 'Image Dials ü');
  for (const platform of ['win32', 'darwin', 'linux']) {
    const spec = launchSpec('api', env, { root, platform });
    assert.equal(
      spec.executable,
      platform === 'win32'
        ? join(root, 'backend', '.venv', 'Scripts', 'python.exe')
        : join(root, 'backend', '.venv', 'bin', 'python'),
    );
    assert.equal(spec.cwd, join(root, 'backend'));
    assert.ok(spec.args.includes('--no-access-log'));
    assert.deepEqual(spec.args.slice(-4), [
      '--host',
      env.API_HOST,
      '--port',
      env.API_PORT,
    ]);
  }
  const executable = join(root, 'custom runtime', 'python');
  assert.equal(
    launchSpec('api', { ...env, API_PYTHON: executable }).executable,
    executable,
  );
  assert.equal(
    launchSpec('frontend', { ...env, NODE_BIN: '' }, { node: 'custom-node' })
      .executable,
    'custom-node',
  );
  assert.throws(() => launchSpec('invalid', env), /Usage:/);
});

test('real launcher handles a checkout path with spaces/Unicode and propagates child status', () => {
  const root = mkdtempSync(join(tmpdir(), 'Image Dials ü '));
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'frontend', 'node_modules', 'vite', 'bin'), {
      recursive: true,
    });
    for (const name of ['run.mjs', 'runtime-env.mjs'])
      cpSync(join(projectRoot, 'scripts', name), join(root, 'scripts', name));
    cpSync(
      join(projectRoot, 'frontend', 'runtime-config.js'),
      join(root, 'frontend', 'runtime-config.js'),
    );
    writeFileSync(
      join(root, 'frontend', 'package.json'),
      JSON.stringify({ type: 'module' }),
    );
    writeFileSync(
      join(root, '.env'),
      Object.entries(env)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n'),
    );
    writeFileSync(
      join(root, 'frontend', 'node_modules', 'vite', 'bin', 'vite.js'),
      'console.log(JSON.stringify({cwd:process.cwd(),port:process.env.FRONTEND_PORT}));process.exitCode=7;',
    );
    const clean = { ...process.env };
    for (const name of [
      ...Object.keys(env),
      'NODE_BIN',
      'API_PYTHON',
      'NODE_TEST_CONTEXT',
    ])
      delete clean[name];
    const child = spawnSync(
      process.execPath,
      [join(root, 'scripts', 'run.mjs'), 'frontend'],
      { env: clean, encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(child.status, 7, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), {
      cwd: join(root, 'frontend'),
      port: env.FRONTEND_PORT,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('API shutdown drains event streams for a bounded configured interval', () => {
  const value = (settings) => {
    const args = launchSpec('api', settings).args;
    return args[args.indexOf('--timeout-graceful-shutdown') + 1];
  };
  assert.equal(value(env), '10');
  assert.equal(value({ ...env, API_SHUTDOWN_GRACE_SECONDS: '2' }), '2');
  for (const invalid of ['', '0', '-1', '1.5', 'Infinity', 'later'])
    assert.throws(
      () => value({ ...env, API_SHUTDOWN_GRACE_SECONDS: invalid }),
      /API_SHUTDOWN_GRACE_SECONDS/,
    );
});
