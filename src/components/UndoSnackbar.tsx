import React from 'react';
import { View, Text, StyleSheet, Pressable, Animated, Easing } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { spacing, radius, typography, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';
import { useEmailStore } from '../stores/email-store';

const VISIBLE_MS = 5000;

export function UndoSnackbar() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const insets = useSafeAreaInsets();
  const undoEntry = useEmailStore((s) => s.pendingUndo);
  const notice = useEmailStore((s) => s.notice);
  const undoLast = useEmailStore((s) => s.undoLast);
  const clearUndo = useEmailStore((s) => s.clearUndo);
  const clearNotice = useEmailStore((s) => s.clearNotice);

  // One surface, two payloads. A failed local mutation ("couldn't star that message")
  // needs the same transient, non-blocking treatment an undo does, and reusing this
  // component means reusing its animation, timer and safe-area handling rather than
  // introducing a second snackbar that behaves subtly differently.
  //
  // An undo wins when both are present: it is the more actionable of the two.
  const entry = React.useMemo(
    () =>
      undoEntry
        ? { label: undoEntry.label, createdAt: undoEntry.createdAt, undoable: true }
        : notice
          ? { label: notice.label, createdAt: notice.createdAt, undoable: false }
          : null,
    [undoEntry, notice],
  );
  const dismiss = React.useCallback(() => {
    if (undoEntry) clearUndo();
    else clearNotice();
  }, [undoEntry, clearUndo, clearNotice]);
  const slideY = React.useRef(new Animated.Value(120)).current;
  const opacity = React.useRef(new Animated.Value(0)).current;
  // Remember the last non-null entry so the bar's text/handlers stay valid
  // while it animates out after pendingUndo flips to null.
  const [shown, setShown] = React.useState(entry);

  React.useEffect(() => {
    if (entry) setShown(entry);
  }, [entry]);

  // Drive the auto-dismiss off the entry's createdAt so re-renders during
  // animation don't reset the timer, and so consecutive actions reset it.
  React.useEffect(() => {
    if (!entry) {
      Animated.parallel([
        Animated.timing(slideY, { toValue: 120, duration: 180, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0, duration: 180, useNativeDriver: true }),
      ]).start(({ finished }) => {
        if (finished) setShown(null);
      });
      return;
    }

    Animated.parallel([
      Animated.timing(slideY, { toValue: 0, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 1, duration: 220, useNativeDriver: true }),
    ]).start();

    const elapsed = Date.now() - entry.createdAt;
    const remaining = Math.max(0, VISIBLE_MS - elapsed);
    const id = setTimeout(() => {
      // Only clear if what is showing is still the thing we scheduled for.
      const live = useEmailStore.getState();
      if (live.pendingUndo?.createdAt === entry.createdAt) clearUndo();
      else if (live.notice?.createdAt === entry.createdAt) clearNotice();
    }, remaining);
    return () => clearTimeout(id);
  }, [entry, slideY, opacity, clearUndo, clearNotice]);

  if (!shown) return null;

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.wrap,
        { bottom: insets.bottom + spacing.md, opacity, transform: [{ translateY: slideY }] },
      ]}
    >
      <View style={styles.bar}>
        <Text style={styles.label} numberOfLines={2}>{shown.label}</Text>
        <Pressable
          onPress={() => { if (shown.undoable) void undoLast(); else dismiss(); }}
          hitSlop={8}
          style={({ pressed }) => [styles.undoBtn, pressed && styles.undoBtnPressed]}
        >
          <Text style={styles.undoText}>{shown.undoable ? 'UNDO' : 'DISMISS'}</Text>
        </Pressable>
      </View>
    </Animated.View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    wrap: {
      position: 'absolute',
      left: spacing.md,
      right: spacing.md,
      zIndex: 50,
    },
    bar: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: spacing.sm + 2,
      paddingLeft: spacing.lg,
      paddingRight: spacing.sm,
      borderRadius: radius.md,
      backgroundColor: c.text,
      shadowColor: '#000',
      shadowOpacity: 0.3,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 6 },
      elevation: 8,
    },
    label: {
      ...typography.body,
      color: c.background,
      flex: 1,
    },
    undoBtn: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radius.sm,
    },
    undoBtnPressed: {
      backgroundColor: 'rgba(255,255,255,0.1)',
    },
    undoText: {
      ...typography.bodySemibold,
      color: c.primary,
      letterSpacing: 0.5,
    },
  });
}
