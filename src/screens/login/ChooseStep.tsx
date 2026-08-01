import React from 'react';
import { View, Text, Pressable, StyleSheet, Image } from 'react-native';
import { QrCode, Mail, Plus, Server } from 'lucide-react-native';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors, useResolvedTheme } from '../../theme/colors';
import type { AccountEntry } from '../../stores/account-store';
import OptionTile from './OptionTile';
import LoginNotice from './LoginNotice';

// The white mark disappears on the light palette, so pick per theme. `require`
// can't take an expression, hence the pair.
const LOGO_LIGHT = require('../../../assets/logos/Bulwark Logo Dark.png');
const LOGO_DARK = require('../../../assets/logos/Bulwark Logo White.png');

interface ChooseStepProps {
  isAddMode: boolean;
  accounts: AccountEntry[];
  /** Host of the signed-in account, offered as a shortcut in add mode. */
  knownServerUrl: string | null;
  onScan: () => void;
  onUseEmail: () => void;
  onUseKnownServer: () => void;
  onManualSetup: () => void;
  notice?: { title: string; detail?: string } | null;
  disabled?: boolean;
}

function hostOf(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0];
}

function initialsOf(account: AccountEntry): string {
  const source = account.displayName || account.email || account.username;
  const parts = source.replace(/@.*$/, '').split(/[.\s_-]+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((part) => part[0]);
  return (letters.join('') || source[0] || '?').toUpperCase();
}

/**
 * The entry point. Leads with the two routes that don't require knowing a
 * server address; manual setup stays one tap away for people who do.
 */
export default function ChooseStep({
  isAddMode,
  accounts,
  knownServerUrl,
  onScan,
  onUseEmail,
  onUseKnownServer,
  onManualSetup,
  notice,
  disabled = false,
}: ChooseStepProps) {
  const c = useColors();
  const theme = useResolvedTheme();
  const styles = React.useMemo(() => makeStyles(c), [c]);

  return (
    <View style={styles.root}>
      {isAddMode ? (
        <View style={styles.addHeading}>
          <Text style={styles.title}>Add another account</Text>
          {accounts.length > 0 ? (
            <Text style={styles.subtitle}>You&apos;re signed in to these already.</Text>
          ) : null}
        </View>
      ) : (
        <View style={styles.branding}>
          <Image
            source={theme === 'light' ? LOGO_LIGHT : LOGO_DARK}
            style={styles.logo}
            resizeMode="contain"
          />
          <Text style={styles.appName}>Bulwark Mail</Text>
          <Text style={styles.tagline}>Secure. Private. Yours.</Text>
        </View>
      )}

      {isAddMode && accounts.length > 0 ? (
        <View style={styles.accountList}>
          {accounts.map((account) => (
            <View key={account.id} style={styles.accountRow}>
              <View style={[styles.avatar, { backgroundColor: account.avatarColor }]}>
                <Text style={styles.avatarText}>{initialsOf(account)}</Text>
              </View>
              <View style={styles.accountText}>
                <Text style={styles.accountName} numberOfLines={1}>
                  {account.displayName || account.username}
                </Text>
                <Text style={styles.accountEmail} numberOfLines={1}>
                  {account.email || account.username}
                </Text>
              </View>
            </View>
          ))}
        </View>
      ) : null}

      {notice ? (
        <View style={styles.notice}>
          <LoginNotice title={notice.title} detail={notice.detail} />
        </View>
      ) : null}

      <View style={styles.options}>
        {isAddMode && knownServerUrl ? (
          <OptionTile
            emphasis="primary"
            title={`Another account on ${hostOf(knownServerUrl)}`}
            description="Server already known — no setup needed"
            renderIcon={(color, size) => <Plus size={size} color={color} />}
            onPress={onUseKnownServer}
            disabled={disabled}
          />
        ) : (
          <OptionTile
            emphasis="primary"
            title="Scan a sign-in code"
            description="Already signed in on the web? Fastest way in."
            renderIcon={(color, size) => <QrCode size={size} color={color} />}
            onPress={onScan}
            disabled={disabled}
          />
        )}

        <OptionTile
          title={isAddMode ? 'An account somewhere else' : 'Use my email address'}
          description="We'll find your mail server"
          renderIcon={(color, size) => <Mail size={size} color={color} />}
          onPress={onUseEmail}
          disabled={disabled}
        />

        {isAddMode && knownServerUrl ? (
          <OptionTile
            title="Scan a sign-in code"
            renderIcon={(color, size) => <QrCode size={size} color={color} />}
            onPress={onScan}
            disabled={disabled}
          />
        ) : null}
      </View>

      <Pressable onPress={onManualSetup} disabled={disabled} hitSlop={8} style={styles.manual}>
        <Server size={14} color={c.textMuted} />
        <Text style={styles.manualText}>Enter server details manually</Text>
      </Pressable>
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    root: { gap: spacing.xl },
    branding: { alignItems: 'center', gap: spacing.xs, marginBottom: spacing.md },
    logo: { width: 64, height: 64, marginBottom: spacing.sm },
    appName: { ...typography.h1, color: c.text },
    tagline: { ...typography.caption, color: c.textMuted },

    addHeading: { gap: spacing.xs },
    title: { ...typography.h1, color: c.text },
    subtitle: { ...typography.body, color: c.textSecondary },

    accountList: { gap: spacing.md },
    accountRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    avatar: { width: 36, height: 36, borderRadius: radius.full, alignItems: 'center', justifyContent: 'center' },
    avatarText: { ...typography.captionMedium, color: '#ffffff' },
    accountText: { flex: 1 },
    accountName: { ...typography.bodyMedium, color: c.text },
    accountEmail: { ...typography.caption, color: c.textMuted },

    notice: { marginTop: -spacing.xs },
    options: { gap: spacing.md },

    manual: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.sm,
    },
    manualText: { ...typography.body, color: c.textMuted },
  });
}
