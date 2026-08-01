import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { ChevronRight } from 'lucide-react-native';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';

interface OptionTileProps {
  title: string;
  description?: string;
  /** Receives the colour the tile's text renders in. */
  renderIcon: (color: string, size: number) => React.ReactNode;
  onPress: () => void;
  emphasis?: 'primary' | 'default';
  disabled?: boolean;
}

/**
 * A full-width choice on the sign-in screen: icon, what it does, and what it
 * costs you. Used instead of a stack of buttons so each route can say enough
 * to be picked without trial and error.
 */
export default function OptionTile({
  title,
  description,
  renderIcon,
  onPress,
  emphasis = 'default',
  disabled = false,
}: OptionTileProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const isPrimary = emphasis === 'primary';
  const contentColor = isPrimary ? c.primaryForeground : c.text;

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={description ? `${title}. ${description}` : title}
      style={({ pressed }) => [
        styles.tile,
        isPrimary ? styles.tilePrimary : styles.tileDefault,
        pressed && !disabled && (isPrimary ? styles.pressedPrimary : styles.pressedDefault),
        disabled && styles.disabled,
      ]}
    >
      <View style={styles.icon}>{renderIcon(contentColor, 22)}</View>
      <View style={styles.text}>
        <Text style={[styles.title, { color: contentColor }]}>{title}</Text>
        {description ? (
          <Text
            style={[
              styles.description,
              { color: isPrimary ? c.primaryForeground : c.textSecondary },
              isPrimary && styles.descriptionPrimary,
            ]}
          >
            {description}
          </Text>
        ) : null}
      </View>
      <ChevronRight size={18} color={contentColor} style={styles.chevron} />
    </Pressable>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    tile: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      borderRadius: radius.lg,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.lg,
      borderWidth: 1,
    },
    tileDefault: { backgroundColor: c.surface, borderColor: c.border },
    tilePrimary: { backgroundColor: c.primary, borderColor: c.primary },
    pressedDefault: { backgroundColor: c.surfaceHover },
    pressedPrimary: { backgroundColor: c.primaryDark },
    disabled: { opacity: 0.5 },
    icon: { width: 22, alignItems: 'center' },
    text: { flex: 1, gap: 2 },
    title: { ...typography.baseMedium },
    description: { ...typography.caption },
    descriptionPrimary: { opacity: 0.8 },
    chevron: { opacity: 0.5 },
  });
}
