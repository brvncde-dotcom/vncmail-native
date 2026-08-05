// Storage for the user-supplied public-LLM API key (BYOK — see
// docs/AI-ASSISTANT-CONCEPT.md's decision on why keys are server-held in the
// shipped design, and settings-store.ts's note on why this prototype pass
// can't do that yet). Mirrors jmap-client.ts's SecureStore pattern exactly —
// there's no generic secure-storage wrapper in this codebase to build on top
// of, just that one convention, so this repeats it rather than inventing a
// second one.

import * as SecureStore from 'expo-secure-store';

const KEY_PREFIX = 'ai_api_key__';

// SecureStore keys: letters, digits, ".", "-", "_" only - no "@" or "/".
function apiKeyStoreKey(provider: string): string {
  return KEY_PREFIX + provider.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export async function setAiApiKey(provider: string, key: string): Promise<void> {
  await SecureStore.setItemAsync(apiKeyStoreKey(provider), key);
}

export async function getAiApiKey(provider: string): Promise<string | null> {
  return SecureStore.getItemAsync(apiKeyStoreKey(provider));
}

export async function clearAiApiKey(provider: string): Promise<void> {
  await SecureStore.deleteItemAsync(apiKeyStoreKey(provider));
}
