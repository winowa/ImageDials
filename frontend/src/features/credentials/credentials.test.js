import { expect, test, vi } from 'vitest';

import {
  CREDENTIAL_STATE,
  READER_SETTINGS,
  boundForDisplay,
  classifyStore,
  createCredentialsInspector,
  summarizeStore,
} from './credentials.js';

const storeOf = (validation_state, extra = {}) => ({
  active_manifest: 'm1',
  manifests: {
    m1: {
      title: 'Blue field',
      assertions: [{}, {}],
      claim_generator_info: [{ name: 'Fixture generator' }],
      signature_info: {
        issuer: 'Test Issuer',
        common_name: 'Test Signer',
        alg: 'Es256',
      },
    },
  },
  validation_status: [
    { code: 'signingCredential.untrusted', explanation: 'untrusted' },
  ],
  validation_state,
  ...extra,
});

test('the SDK states stay distinct and anything else is unverified', () => {
  expect(classifyStore(storeOf('Trusted'))).toBe(CREDENTIAL_STATE.TRUSTED);
  expect(classifyStore(storeOf('Valid'))).toBe(CREDENTIAL_STATE.VALID);
  expect(classifyStore(storeOf('Invalid'))).toBe(CREDENTIAL_STATE.INVALID);
  for (const unknown of [undefined, null, '', 'valid', 'Pending', 7])
    expect(classifyStore(storeOf(unknown))).toBe(CREDENTIAL_STATE.UNVERIFIED);
  expect(classifyStore(null)).toBe(CREDENTIAL_STATE.UNVERIFIED);
  expect(classifyStore({ validation_state: 'toString' })).toBe(
    CREDENTIAL_STATE.UNVERIFIED,
  );
});

test('the summary reads only what the manifest provides', () => {
  expect(summarizeStore(storeOf('Valid'))).toEqual({
    title: 'Blue field',
    signer: 'Test Signer',
    issuer: 'Test Issuer',
    algorithm: 'Es256',
    signedAt: null,
    generators: ['Fixture generator'],
    assertions: 2,
    manifests: 1,
    issues: [{ code: 'signingCredential.untrusted', explanation: 'untrusted' }],
  });
  expect(summarizeStore({})).toMatchObject({
    signer: null,
    generators: [],
    assertions: null,
    manifests: 0,
    issues: [],
  });
});

test('display data is bounded without touching the original', () => {
  const huge = {
    text: 'x'.repeat(5000),
    list: Array.from({ length: 500 }, (_, i) => i),
    deep: {
      a: {
        b: { c: { d: { e: { f: { g: { h: { i: { j: { k: 1 } } } } } } } } },
      },
    },
  };
  const bounded = boundForDisplay(huge);
  expect(bounded.text.length).toBeLessThan(500);
  expect(bounded.text).toContain('more characters');
  expect(bounded.list).toHaveLength(101);
  expect(JSON.stringify(bounded)).toContain('nested data omitted');
  expect(huge.text).toHaveLength(5000);
  expect(huge.list).toHaveLength(500);
});

function fakeSdk({ store = storeOf('Valid'), reader = 'ok' } = {}) {
  const calls = { free: 0, dispose: 0, contexts: [], formats: [] };
  const instance = { dispose: () => (calls.dispose += 1) };
  const sdk = {
    wasmSrc: '/assets/c2pa.wasm',
    createC2pa: vi.fn(async () => instance),
    Context: class {
      constructor(settings) {
        calls.contexts.push(settings);
      }
    },
    Reader: {
      fromBlob: vi.fn(async (_c2pa, format) => {
        calls.formats.push(format);
        if (reader === 'absent') return null;
        if (reader === 'reject') throw new Error('corrupt file');
        return {
          manifestStore: async () => store,
          free: async () => (calls.free += 1),
        };
      }),
    },
  };
  return { sdk, calls };
}

const png = () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });

test('a read uses local-only verification, frees the reader and ends the worker', async () => {
  const { sdk, calls } = fakeSdk();
  const loadSdk = vi.fn(async () => sdk);
  const inspector = createCredentialsInspector({ loadSdk });
  expect(loadSdk).not.toHaveBeenCalled();
  const result = await inspector.inspect(png());
  expect(result.state).toBe(CREDENTIAL_STATE.VALID);
  expect(result.summary.signer).toBe('Test Signer');
  expect(sdk.createC2pa).toHaveBeenCalledWith({ wasmSrc: '/assets/c2pa.wasm' });
  expect(calls.contexts).toEqual([READER_SETTINGS]);
  expect(READER_SETTINGS.verify).toEqual({
    verifyAfterReading: true,
    verifyTrust: true,
    remoteManifestFetch: false,
    ocspFetch: false,
  });
  expect(calls.free).toBe(1);
  inspector.dispose();
  await new Promise((r) => setTimeout(r));
  expect(calls.dispose).toBe(1);
  inspector.dispose();
  expect(calls.dispose).toBe(1);
  await expect(inspector.inspect(png())).rejects.toMatchObject({
    name: 'AbortError',
  });
});

test('a null reader is absent and a rejected read is an error, not absence', async () => {
  const absent = createCredentialsInspector({
    loadSdk: async () => fakeSdk({ reader: 'absent' }).sdk,
  });
  expect(await absent.inspect(png())).toMatchObject({
    state: CREDENTIAL_STATE.ABSENT,
    store: null,
  });
  const failing = createCredentialsInspector({
    loadSdk: async () => fakeSdk({ reader: 'reject' }).sdk,
  });
  await expect(failing.inspect(png())).rejects.toThrow('corrupt file');
});

test('a store without a known validation state stays unverified', async () => {
  const inspector = createCredentialsInspector({
    loadSdk: async () => fakeSdk({ store: storeOf(undefined) }).sdk,
  });
  expect((await inspector.inspect(png())).state).toBe(
    CREDENTIAL_STATE.UNVERIFIED,
  );
});

test('an untyped blob is read as PNG and a failed start is retried', async () => {
  const { sdk, calls } = fakeSdk();
  const loadSdk = vi
    .fn()
    .mockRejectedValueOnce(new Error('chunk failed'))
    .mockResolvedValue(sdk);
  const inspector = createCredentialsInspector({ loadSdk });
  await expect(
    inspector.inspect(new Blob([new Uint8Array(2)])),
  ).rejects.toThrow('chunk failed');
  await inspector.inspect(new Blob([new Uint8Array(2)]));
  expect(calls.formats).toEqual(['image/png']);
  expect(loadSdk).toHaveBeenCalledTimes(2);
});

test('disposing during startup ends the worker that was starting', async () => {
  const { sdk, calls } = fakeSdk();
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const inspector = createCredentialsInspector({
    loadSdk: async () => {
      await gate;
      return sdk;
    },
  });
  const pending = inspector.inspect(png());
  inspector.dispose();
  release();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(sdk.createC2pa).not.toHaveBeenCalled();
  expect(calls.free).toBe(0);
});
