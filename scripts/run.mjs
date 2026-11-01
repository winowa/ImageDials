import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runtimeConfig } from '../frontend/runtime-config.js';
import { loadRuntimeEnv, projectRoot } from './runtime-env.mjs';

export function launchSpec(
  component,
  env,
  {
    root = projectRoot,
    platform = process.platform,
    node = process.execPath,
  } = {},
) {
  if (!['api', 'frontend'].includes(component)) {
    throw new Error('Usage: node scripts/run.mjs <api|frontend>');
  }
  runtimeConfig(env);
  if (component === 'api') {
    const python =
      env.API_PYTHON ||
      (platform === 'win32'
        ? join(root, 'backend', '.venv', 'Scripts', 'python.exe')
        : join(root, 'backend', '.venv', 'bin', 'python'));
    return {
      executable: python,
      args: [
        '-m',
        'uvicorn',
        'app.main:app',
        '--host',
        env.API_HOST,
        '--port',
        env.API_PORT,
      ],
      cwd: join(root, 'backend'),
    };
  }
  return {
    executable: env.NODE_BIN || node,
    args: [join(root, 'frontend', 'node_modules', 'vite', 'bin', 'vite.js')],
    cwd: join(root, 'frontend'),
  };
}

export function run(component) {
  const env = loadRuntimeEnv();
  const spec = launchSpec(component, env);
  if (component === 'frontend' && !existsSync(spec.args[0])) {
    throw new Error(
      'Frontend dependencies are missing. Run npm --prefix frontend ci.',
    );
  }
  const child = spawn(spec.executable, spec.args, {
    cwd: spec.cwd,
    env,
    stdio: 'inherit',
    shell: false,
  });
  const forward = (signal) => {
    if (child.exitCode === null) child.kill(signal);
  };
  const interrupt = () => forward('SIGINT');
  const terminate = () => forward('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  const cleanup = () => {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
  };
  child.on('error', (error) => {
    cleanup();
    console.error(`Unable to launch ${component}: ${error.message}`);
    if (component === 'api')
      console.error('Create backend/.venv or set API_PYTHON in .env.');
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    cleanup();
    process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1);
  });
  return child;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    run(process.argv[2]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
