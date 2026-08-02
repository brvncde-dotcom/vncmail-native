import React, { useRef, useState } from 'react';
import {
  View, Text, StyleSheet, Animated, PanResponder, Pressable, Dimensions,
} from 'react-native';
import {
  Archive, Trash2, ShieldAlert, MailOpen, Star, Pin, FolderInput,
  type LucideIcon,
} from 'lucide-react-native';
import { typography, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';
import type { SwipeAction, SwipeMode } from '../stores/settings-store';
import {
  shouldClaimGesture, dragOffset, resolveRelease, exitsRow,
  COMMIT_THRESHOLD, REVEAL_WIDTH,
  type SwipeConfig,
} from './swipe-gesture';

interface SwipeableRowProps {
  children: React.ReactNode;
  /** Right-to-left swipe action (revealed under a leftward drag, sits at right edge). */
  leftAction: SwipeAction;
  /** Left-to-right swipe action (revealed under a rightward drag, sits at left edge). */
  rightAction: SwipeAction;
  /** Pass the row state used to compute action labels (e.g. unread/starred toggling). */
  context: { unread: boolean; starred: boolean; pinned: boolean };
  onAction: (action: SwipeAction) => void;
  /**
   * 'instant' (default): swipe past COMMIT_THRESHOLD and release fires the action.
   * 'reveal': swipe past ACTIVATION_THRESHOLD reveals an action band that must be tapped.
   */
  mode?: SwipeMode;
}

// Distance the row flies off-screen by before the action callback fires.
const EXIT_DISTANCE = 600;

const ACTION_META: Record<Exclude<SwipeAction, 'none'>, { icon: LucideIcon; bg: string; defaultLabel: string }> = {
  archive: { icon: Archive,      bg: '#1d4ed8', defaultLabel: 'Archive' },
  delete:  { icon: Trash2,       bg: '#b91c1c', defaultLabel: 'Delete' },
  spam:    { icon: ShieldAlert,  bg: '#a16207', defaultLabel: 'Spam' },
  read:    { icon: MailOpen,     bg: '#0f766e', defaultLabel: 'Read' },
  star:    { icon: Star,         bg: '#a16207', defaultLabel: 'Star' },
  pin:     { icon: Pin,          bg: '#7c3aed', defaultLabel: 'Pin' },
  move:    { icon: FolderInput,  bg: '#475569', defaultLabel: 'Move' },
};

function actionLabel(action: SwipeAction, context: { unread: boolean; starred: boolean; pinned: boolean }): string {
  if (action === 'read') return context.unread ? 'Read' : 'Unread';
  if (action === 'star') return context.starred ? 'Unstar' : 'Star';
  if (action === 'pin') return context.pinned ? 'Unpin' : 'Pin';
  if (action === 'none') return '';
  return ACTION_META[action].defaultLabel;
}

export function SwipeableRow({
  children, leftAction, rightAction, context, onAction, mode = 'instant',
}: SwipeableRowProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const dx = useRef(new Animated.Value(0)).current;
  const claimed = useRef(false);
  const widthRef = useRef(Dimensions.get('window').width);

  // The PanResponder below is built once, so its handlers close over the props
  // of the render that built it. Reading them through a ref instead keeps the
  // gesture in step with the row it is actually attached to. Three ways that
  // went wrong before: changing a swipe action in settings kept firing the old
  // one; entering selection mode (which passes 'none') still fired actions;
  // and `onAction` captured a `handleSwipeAction` from before the mailbox ids
  // had loaded, so on a slow connection swipe did nothing even untouched.
  // Same idiom as RichTextEditor's callback refs.
  const latest = useRef<SwipeConfig & { onAction: (a: SwipeAction) => void }>({
    leftAction, rightAction, mode, onAction,
  });
  latest.current = { leftAction, rightAction, mode, onAction };

  // Reveal-mode-only state: which side (if any) is currently sitting open.
  const openSideRef = useRef<'left' | 'right' | null>(null);
  const [openSide, setOpenSide] = useState<'left' | 'right' | null>(null);

  const springTo = (toValue: number) => {
    Animated.spring(dx, { toValue, useNativeDriver: true, speed: 24, bounciness: 4 }).start();
  };
  // Spring back to rest without changing which side is open.
  const settle = () => springTo(0);

  const close = () => {
    springTo(0);
    openSideRef.current = null;
    setOpenSide(null);
  };

  const openTo = (side: 'left' | 'right') => {
    springTo(side === 'right' ? REVEAL_WIDTH : -REVEAL_WIDTH);
    openSideRef.current = side;
    setOpenSide(side);
  };

  const fly = (toValue: number, action: SwipeAction) => {
    // For destructive/move actions: race the row off-screen and fire the
    // action - the parent will remove the row from the list. For toggle
    // actions: fire immediately and snap back so the same row can update in
    // place.
    if (exitsRow(action)) {
      Animated.timing(dx, {
        toValue,
        duration: 180,
        useNativeDriver: true,
      }).start(() => {
        latest.current.onAction(action);
        // The row is about to be removed; reset translation in case it isn't
        // (e.g. the action failed silently) so we don't leave it off-screen.
        dx.setValue(0);
      });
    } else {
      latest.current.onAction(action);
      settle();
    }
  };

  const fireFromBandTap = (action: SwipeAction) => {
    close();
    if (action === 'none') return;
    if (exitsRow(action)) {
      // Let the row collapse a frame, then fire so the parent's list update
      // has a clean starting point. Deferred, so read the callback on arrival
      // rather than capturing today's.
      requestAnimationFrame(() => latest.current.onAction(action));
    } else {
      latest.current.onAction(action);
    }
  };

  // Built once. Every handler reads `latest.current`, so a rebuild would be a
  // no-op anyway — which is what makes useMemo (free to discard its cache)
  // safe here.
  const responder = React.useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_, g) => {
          if (!shouldClaimGesture(g, latest.current, openSideRef.current)) return false;
          claimed.current = true;
          return true;
        },
        onPanResponderMove: (_, g) => {
          dx.setValue(dragOffset(g, latest.current, openSideRef.current));
        },
        onPanResponderRelease: (_, g) => {
          claimed.current = false;
          const outcome = resolveRelease(g, latest.current, openSideRef.current);
          switch (outcome.kind) {
            case 'open':
              openTo(outcome.side);
              break;
            case 'close':
              close();
              break;
            case 'fire':
              fly(outcome.direction * (widthRef.current || EXIT_DISTANCE), outcome.action);
              break;
            case 'settle':
              settle();
              break;
          }
        },
        onPanResponderTerminate: () => {
          if (latest.current.mode === 'reveal') close();
          else settle();
          claimed.current = false;
        },
        onPanResponderTerminationRequest: () => !claimed.current,
      }),
    [],
  );

  const onLayout = (e: { nativeEvent: { layout: { width: number } } }) => {
    widthRef.current = e.nativeEvent.layout.width;
  };

  if (mode === 'reveal') {
    // Reveal mode: bands sit at the row edges with a fixed REVEAL_WIDTH and
    // are tap targets. The row slides over them; releasing past the activation
    // threshold snaps the row to the open position so the band is fully
    // visible and tappable.
    const renderRevealBand = (action: SwipeAction, side: 'left' | 'right') => {
      if (action === 'none') return null;
      const meta = ACTION_META[action];
      const Icon = meta.icon;
      const label = actionLabel(action, context);
      return (
        <Pressable
          onPress={() => fireFromBandTap(action)}
          style={[
            styles.bandReveal,
            side === 'left' ? { left: 0, alignItems: 'flex-start' } : { right: 0, alignItems: 'flex-end' },
            { backgroundColor: meta.bg, width: REVEAL_WIDTH },
          ]}
        >
          <View style={styles.bandInner}>
            <Icon size={20} color="#fff" />
            <Text style={styles.bandLabel}>{label}</Text>
          </View>
        </Pressable>
      );
    };

    return (
      <View style={styles.wrap} onLayout={onLayout} {...responder.panHandlers}>
        {renderRevealBand(rightAction, 'left')}
        {renderRevealBand(leftAction, 'right')}
        <Animated.View style={[styles.content, { transform: [{ translateX: dx }] }]}>
          {children}
          {/* When an action is revealed, an overlay absorbs taps on the row so
              a tap closes the swipe instead of opening the email. */}
          {openSide ? (
            <Pressable
              style={StyleSheet.absoluteFill}
              onPress={close}
            />
          ) : null}
        </Animated.View>
      </View>
    );
  }

  // Instant mode: bands fill the gap behind the row as it's dragged.
  const renderInstantBand = (action: SwipeAction, side: 'left' | 'right') => {
    if (action === 'none') return null;
    const meta = ACTION_META[action];
    const Icon = meta.icon;
    const label = actionLabel(action, context);
    const inputRange = side === 'left' ? [0, COMMIT_THRESHOLD] : [-COMMIT_THRESHOLD, 0];
    const iconScale = dx.interpolate({
      inputRange,
      outputRange: side === 'left' ? [0.85, 1.15] : [1.15, 0.85],
      extrapolate: 'clamp',
    });
    return (
      <View
        style={[
          styles.bandInstant,
          { backgroundColor: meta.bg },
          side === 'left' ? { justifyContent: 'flex-start' } : { justifyContent: 'flex-end' },
        ]}
      >
        <Animated.View style={[styles.bandInner, { transform: [{ scale: iconScale }] }]}>
          <Icon size={22} color="#fff" />
          <Text style={styles.bandLabel}>{label}</Text>
        </Animated.View>
      </View>
    );
  };

  const rightBandOpacity = dx.interpolate({
    inputRange: [-1, 0, 1],
    outputRange: [0, 0, 1],
    extrapolate: 'clamp',
  });
  const leftBandOpacity = dx.interpolate({
    inputRange: [-1, 0, 1],
    outputRange: [1, 0, 0],
    extrapolate: 'clamp',
  });

  return (
    <View style={styles.wrap} onLayout={onLayout} {...responder.panHandlers}>
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: rightBandOpacity }]} pointerEvents="none">
        {renderInstantBand(rightAction, 'left')}
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: leftBandOpacity }]} pointerEvents="none">
        {renderInstantBand(leftAction, 'right')}
      </Animated.View>
      <Animated.View style={[styles.content, { transform: [{ translateX: dx }] }]}>
        {children}
      </Animated.View>
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    wrap: { position: 'relative', backgroundColor: c.background, overflow: 'hidden' },
    content: { backgroundColor: c.background },
    bandInstant: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 24,
    },
    bandReveal: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      justifyContent: 'center',
      paddingHorizontal: 16,
    },
    bandInner: { alignItems: 'center', gap: 4 },
    bandLabel: { ...typography.caption, color: '#fff', fontWeight: '600' },
  });
}
