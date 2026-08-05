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

/**
 * The `local` provider class (a loopback Ollama-compatible runtime) needs a
 * host process reachable on 127.0.0.1 — see `docs/AI-ASSISTANT-CONCEPT.md`
 * §1.1 and §3's platform matrix. This repo has no Electron shell (that's
 * `vncmail-plus`), so the expression below always evaluates to `false` here;
 * it's written to match the doc's canonical form (`Platform.OS === 'web' ||
 * isElectron`) so the same flag ports unchanged to the web/Electron client.
 *
 * A phone has neither the runtime nor the RAM, and critically cannot reach a
 * developer's own laptop loopback address from real hardware — the prior
 * `AiAssistantSettings` prototype offered this option on iOS/Android anyway,
 * reachable only from the Simulator on the same Mac as Ollama. That is
 * exactly the "hidden feature that's really broken" pattern this module
 * exists to prevent (see the FTS5 comment above) — mobile deliberately gets
 * no `local` transport or UI at all.
 */
export const supportsLocalLlm = false;
