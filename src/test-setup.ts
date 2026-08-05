// Vitest setup. Two pieces of plumbing the unit tests need:
//
// 1. AsyncStorage: the Zustand `persist` middleware used by several stores
//    reaches in during `set()` calls, which on a `node` environment crashes
//    inside the RN AsyncStorage shim (no `window` global). Swap in an
//    in-memory implementation.
// 2. react-native: the bundled entry point is Flow-typed and rolldown can't
//    parse it. Stub the few surfaces used at module-load time so any store
//    that transitively imports `react-native` (via push / client-cert
//    bridges) loads cleanly. Tests that actually exercise native modules
//    re-mock the relevant module locally.

import { vi } from 'vitest';

const memory = new Map<string, string>();

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => memory.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      memory.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      memory.delete(key);
    }),
    clear: vi.fn(async () => {
      memory.clear();
    }),
    getAllKeys: vi.fn(async () => Array.from(memory.keys())),
    multiGet: vi.fn(async (keys: string[]) =>
      keys.map((k) => [k, memory.get(k) ?? null] as [string, string | null]),
    ),
    multiSet: vi.fn(async (pairs: [string, string][]) => {
      for (const [k, v] of pairs) memory.set(k, v);
    }),
    multiRemove: vi.fn(async (keys: string[]) => {
      for (const k of keys) memory.delete(k);
    }),
  },
}));

vi.mock('react-native', () => {
  class NativeEventEmitter {
    addListener() {
      return { remove: () => undefined };
    }
    removeAllListeners() {}
  }
  return {
    Platform: { OS: 'android', Version: 33, select: <T,>(spec: { default?: T; android?: T; ios?: T }) => spec.android ?? spec.default ?? spec.ios },
    NativeModules: {},
    NativeEventEmitter,
    PermissionsAndroid: {
      RESULTS: { GRANTED: 'granted', DENIED: 'denied', NEVER_ASK_AGAIN: 'never_ask_again' },
      request: async () => 'granted',
    },
    Linking: { openURL: async () => undefined },
    Appearance: { getColorScheme: () => 'dark', addChangeListener: () => ({ remove: () => undefined }) },
  };
});

vi.mock('expo-secure-store', () => ({
  setItemAsync: vi.fn(async () => undefined),
  getItemAsync: vi.fn(async () => null),
  deleteItemAsync: vi.fn(async () => undefined),
}));

// expo-web-browser transitively pulls in expo-modules-core, which evaluates
// RN-only globals at module load. The unit tests don't exercise the real
// browser handoff flow, so stubbing the surface is enough.
vi.mock('expo-web-browser', () => ({
  openAuthSessionAsync: vi.fn(async () => ({ type: 'cancel' as const })),
  maybeCompleteAuthSession: vi.fn(),
}));

// Metro defines `__DEV__`; a plain node run does not. expo-modules-core reads it
// at module load, so anything importing an Expo native module (expo-file-system
// via api/blob, expo-crypto via the S/MIME layer) crashes without it.
(globalThis as { __DEV__?: boolean }).__DEV__ = false;

// expo-file-system's `File` is only used for on-disk reads, which no unit test
// exercises; the S/MIME tests build their bytes in memory.
vi.mock('expo-file-system', () => ({
  File: class {
    constructor(public uri: string) {}
    bytes(): Promise<Uint8Array> {
      return Promise.resolve(new Uint8Array(0));
    }
  },
}));

// The S/MIME layer prefers expo-crypto for its CSPRNG. In node, hand it the
// real one so the crypto tests exercise a genuine random source rather than a
// deterministic stub.
vi.mock('expo-crypto', async () => {
  const nodeCrypto = await import('node:crypto');
  return {
    getRandomValues: <T extends Uint8Array>(target: T): T => {
      const bytes = nodeCrypto.randomBytes(target.length);
      target.set(bytes);
      return target;
    },
    getRandomBytes: (count: number) => new Uint8Array(nodeCrypto.randomBytes(count)),
  };
});
