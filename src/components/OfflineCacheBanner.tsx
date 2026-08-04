// Live banner that mirrors the UpdateBanner's footprint, surfaced while the
// offline mail sync is running. Hidden once the sync settles to idle/done.

import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CloudDownload, X } from 'lucide-react-native';
import { useShallow } from 'zustand/react/shallow';
import { useOfflineCacheStore } from '../stores/offline-cache-store';
import { useSettingsStore } from '../stores/settings-store';
import { useSyncStatusStore } from '../stores/sync-status-store';
import { useUpdatesStore } from '../stores/updates-store';
import { formatBytes } from '../lib/offline-sync';
import { spacing, radius, typography, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';

export function OfflineCacheBanner(): React.ReactElement | null {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const insets = useSafeAreaInsets();
  // Two engines, one banner. The v1 store's `sync` and the v2 engine's status are
  // different shapes, so the flag decides which one this bar is reporting on — showing
  // stale v1 state while v2 is doing the work would be worse than showing nothing.
  const engineV2 = useSettingsStore((s) => s.offlineSyncEngineV2);
  const v1Sync = useOfflineCacheStore((s) => s.sync);
  const v1Abort = useOfflineCacheStore((s) => s.requestAbort);
  const v1Reset = useOfflineCacheStore((s) => s.resetSync);
  // useShallow is required here, not optional style: a selector that returns a fresh
  // object literal every call breaks useSyncExternalStore's "snapshot didn't change"
  // check, which React reports as "getSnapshot should be cached to avoid an infinite
  // loop" — and it isn't just a warning, the component actually re-renders every time,
  // continuously. Caught by running the app for real, not by any of the unit tests.
  const v2 = useSyncStatusStore(
    useShallow((s) => ({
      phase: s.phase,
      message: s.message,
      unfinished: s.unfinished,
    })),
  );
  const v2Reset = useSyncStatusStore((s) => s.reset);

  // §12.3 maps the engine's new phases onto the five this bar already renders. The engine
  // reports no item counts — it is cursor-driven, not "N of M" — so v2 shows an
  // indeterminate bar with a phase label rather than a fake percentage.
  const sync = React.useMemo(() => {
    if (!engineV2) return v1Sync;
    const map: Record<string, { phase: string; label?: string }> = {
      idle: { phase: 'idle' },
      bootstrapping: { phase: 'scanning', label: 'Downloading your mail history…' },
      coverage: { phase: 'scanning', label: 'Filling in older messages…' },
      resyncing: { phase: 'scanning', label: 'Re-syncing offline mail…' },
      delta: { phase: 'fetching', label: 'Checking for changes…' },
      bodies: { phase: 'fetching', label: 'Downloading message bodies…' },
      partial: { phase: 'fetching', label: 'Paused — will continue shortly' },
      done: { phase: 'done' },
      error: { phase: 'error' },
    };
    const mapped = map[v2.phase] ?? { phase: 'idle' };
    return {
      phase: mapped.phase as typeof v1Sync.phase,
      total: 0,
      completed: 0,
      fetched: 0,
      bytes: 0,
      message: v2.phase === 'error' ? v2.message : mapped.label,
    };
  }, [engineV2, v1Sync, v2]);

  // Cancelling a v2 cycle is an abort at the next page boundary; there is no destructive
  // cancel to offer, and the engine resumes on its own via T9, so the bar only offers
  // dismiss on v2.
  const requestAbort = engineV2 ? () => undefined : v1Abort;
  const resetSync = engineV2 ? v2Reset : v1Reset;
  // When UpdateBanner is stacked above us it already absorbs the status-bar
  // inset, so we only add it when we're the topmost banner.
  const cachedLatest = useUpdatesStore((s) => s.cachedLatest);
  const dismissedTag = useUpdatesStore((s) => s.dismissedTag);
  const hasUpdate = useUpdatesStore((s) => s.hasUpdate);
  const updateBannerVisible =
    hasUpdate() && cachedLatest?.apkAsset != null && dismissedTag !== cachedLatest.tag;
  const topInset = updateBannerVisible ? 0 : insets.top;
  const [hideTimer, setHideTimer] = React.useState<ReturnType<typeof setTimeout> | null>(null);

  // Auto-dismiss the "done" state after a few seconds so the bar isn't a
  // permanent fixture; the Settings screen still shows the cache stats.
  React.useEffect(() => {
    if (sync.phase === 'done' || sync.phase === 'cancelled') {
      const t = setTimeout(() => resetSync(), 4000);
      setHideTimer(t);
      return () => clearTimeout(t);
    }
    if (hideTimer) clearTimeout(hideTimer);
    return undefined;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync.phase, resetSync]);

  if (sync.phase === 'idle') return null;

  const pct =
    sync.total > 0
      ? Math.min(100, Math.round((sync.completed / sync.total) * 100))
      : sync.phase === 'done' ? 100 : 0;

  let title = 'Offline sync';
  let subtitle = '';
  switch (sync.phase) {
    case 'scanning':
      title = 'Syncing offline mail';
      subtitle = sync.message ?? 'Scanning recent messages…';
      break;
    case 'fetching':
      title = 'Syncing offline mail';
      subtitle = engineV2
        ? (sync.message ?? 'Checking for changes…')
        : `${sync.completed}/${sync.total} • ${formatBytes(sync.bytes)}`;
      break;
    case 'done':
      title = 'Offline mail ready';
      subtitle = engineV2
        ? 'Up to date'
        : sync.fetched > 0
          ? `${sync.fetched} new message${sync.fetched === 1 ? '' : 's'} cached • ${formatBytes(sync.bytes)}`
          : 'Already up to date';
      break;
    case 'cancelled':
      title = 'Sync cancelled';
      subtitle = `${sync.completed}/${sync.total} processed`;
      break;
    case 'error':
      title = 'Offline sync failed';
      subtitle = sync.message ?? 'Unable to download';
      break;
    default:
      return null;
  }

  const showCancel = !engineV2 && (sync.phase === 'scanning' || sync.phase === 'fetching');
  const showDismiss = sync.phase === 'done' || sync.phase === 'cancelled' || sync.phase === 'error';
  const isError = sync.phase === 'error';

  return (
    <View style={[styles.banner, isError && styles.bannerError, { paddingTop: spacing.sm + topInset }]}>
      <CloudDownload size={16} color={c.primaryForeground} />
      <View style={{ flex: 1 }}>
        <Text style={styles.title}>{title}</Text>
        {!!subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
        {(sync.phase === 'fetching' || sync.phase === 'scanning') && (
          <View style={styles.progressTrack}>
            {/* v2 is cursor-driven, so there is no honest denominator — a full-width
                track reads as "working" without inventing a percentage. */}
            <View style={[styles.progressFill, { width: engineV2 ? '100%' : `${pct}%` }]} />
          </View>
        )}
      </View>
      {showCancel && (
        <Pressable style={styles.cancelButton} onPress={requestAbort} hitSlop={6}>
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
      )}
      {showDismiss && (
        <Pressable style={styles.dismiss} onPress={resetSync} hitSlop={8}>
          <X size={14} color={c.primaryForeground} />
        </Pressable>
      )}
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    banner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      backgroundColor: c.primary,
    },
    bannerError: { backgroundColor: c.error },
    title: { ...typography.bodyMedium, color: c.primaryForeground },
    subtitle: { ...typography.caption, color: c.primaryForeground, opacity: 0.85, marginTop: 2 },
    progressTrack: {
      marginTop: 6,
      height: 3,
      borderRadius: radius.full,
      backgroundColor: 'rgba(255,255,255,0.25)',
      overflow: 'hidden',
    },
    progressFill: {
      height: '100%',
      backgroundColor: c.primaryForeground,
    },
    cancelButton: {
      paddingHorizontal: spacing.md,
      paddingVertical: 6,
      borderRadius: radius.sm,
      backgroundColor: 'rgba(255,255,255,0.2)',
    },
    cancelText: { ...typography.captionMedium, color: c.primaryForeground },
    dismiss: { padding: 4 },
  });
}
