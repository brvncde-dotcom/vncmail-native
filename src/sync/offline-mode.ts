// Which offline store owns the mail right now. ONE definition, in a leaf module.
//
// It lives here rather than in `offline-facade.ts` because `email-store` needs it too, and
// the facade transitively imports `auth-store`, which imports `email-store` — so putting the
// predicate in the facade would create an import cycle. This module imports only
// `settings-store`, so anything can depend on it.
//
// The reason it is a shared definition at all: the v1/v2 branch was written out by hand in
// each consumer, and one of them (the Settings screen) simply didn't get it, which is how a
// device with 761 synced envelopes ended up reporting "Nothing cached yet".

import { useSettingsStore } from '../stores/settings-store';

/**
 * True when the v2 delta-sync engine owns the on-device copy of the mail.
 *
 * BOTH conditions are required. The engine only runs when offline caching is on (§9.5 keeps
 * a disabled account's store unmaterialised), so "flag on, caching off" must read as v1 —
 * otherwise callers would report on, or write to, a store that will never exist.
 */
export function offlineEngineOwnsStore(): boolean {
  const s = useSettingsStore.getState();
  return s.offlineSyncEngineV2 && s.offlineCacheEnabled;
}
