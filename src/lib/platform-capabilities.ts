// Single source of truth for "this feature only exists on some platforms", so
// the UI, the stores and the native bridges all agree on what is reachable.

import { Platform } from 'react-native';

/**
 * In-app sideload updates: download the release APK from GitHub and hand it to
 * the system package installer (see `lib/install-update`).
 *
 * Android only. App Store Review guideline 2.5.2 forbids an iOS app from
 * downloading and installing executable code, and there is no iOS equivalent of
 * the installer intent anyway - iOS builds are updated through TestFlight or
 * the App Store. The whole updater surface (banner, settings pane, launch-time
 * check) is hidden when this is false.
 */
export const supportsSideloadUpdates = Platform.OS === 'android';

/**
 * The AI assistant's retrieval leg (`sync/fts.ts`) is SQLite FTS5-only. Expo's
 * web SQLite backend (`wa-sqlite`, a WASM build) has no FTS5 module compiled
 * in at all — confirmed by inspecting the shipped `.wasm` directly, not
 * assumed. Native iOS/Android builds do have it (see
 * `sync/__tests__/sqlite-driver.test.ts`'s packaging evidence). So the whole
 * feature is hidden on web rather than reachable but silently broken there.
 */
export const supportsAiAssistant = Platform.OS !== 'web';
