import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Globe } from 'lucide-react-native';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { Button } from '../../components';
import LoginNotice from './LoginNotice';

interface ConfirmStepProps {
  serverUrl: string;
  /** False when the user supplied the address — we didn't find anything. */
  discovered: boolean;
  onContinue: () => void;
  onChangeServer: () => void;
  onUsePassword: () => void;
  notice?: { title: string; detail?: string } | null;
}

function hostOf(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0];
}

/**
 * Names the server before the browser opens. A sign-in that jumps to a browser
 * with no warning reads as a bug; saying which server, and why the password
 * isn't asked for here, turns the detour into the point.
 */
export default function ConfirmStep({
  serverUrl,
  discovered,
  onContinue,
  onChangeServer,
  onUsePassword,
  notice,
}: ConfirmStepProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);

  return (
    <View style={styles.root}>
      <View style={styles.heading}>
        <Text style={styles.title}>
          {discovered ? 'Found your mail server' : 'Check this looks right'}
        </Text>
        <Text style={styles.subtitle}>Next you&apos;ll sign in on your provider&apos;s own page.</Text>
      </View>

      <View style={styles.card}>
        <View style={styles.cardIcon}>
          <Globe size={19} color={c.primary} />
        </View>
        <View style={styles.cardText}>
          <Text style={styles.cardTitle} numberOfLines={1}>
            {hostOf(serverUrl)}
          </Text>
          <View style={styles.cardMetaRow}>
            <View style={styles.dot} />
            <Text style={styles.cardMeta}>
              {serverUrl.startsWith('https://') ? 'JMAP · secure connection' : 'JMAP · unencrypted connection'}
            </Text>
          </View>
        </View>
      </View>

      <LoginNotice
        tone="info"
        title="Your password stays with your provider"
        detail="You'll type it on their page, not into this app. Bulwark keeps a token it can revoke."
      />

      {notice ? <LoginNotice title={notice.title} detail={notice.detail} /> : null}

      <Button variant="default" size="lg" onPress={onContinue}>
        Continue
      </Button>

      <View style={styles.links}>
        <Pressable onPress={onUsePassword} hitSlop={8}>
          <Text style={styles.link}>Sign in with a password instead</Text>
        </Pressable>
        <Pressable onPress={onChangeServer} hitSlop={8}>
          <Text style={styles.linkMuted}>Use a different server</Text>
        </Pressable>
      </View>
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    root: { gap: spacing.lg },
    heading: { gap: spacing.sm },
    title: { ...typography.h1, color: c.text },
    subtitle: { ...typography.body, color: c.textSecondary },

    card: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
      borderRadius: radius.lg,
      padding: spacing.lg,
    },
    cardIcon: {
      width: 38,
      height: 38,
      borderRadius: radius.md,
      backgroundColor: c.primaryBg,
      alignItems: 'center',
      justifyContent: 'center',
    },
    cardText: { flex: 1, gap: 2 },
    cardTitle: { ...typography.baseMedium, color: c.text },
    cardMetaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    dot: { width: 5, height: 5, borderRadius: radius.full, backgroundColor: c.success },
    cardMeta: { ...typography.caption, color: c.textSecondary },

    links: { alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xs },
    link: { ...typography.body, color: c.textLink },
    linkMuted: { ...typography.body, color: c.textMuted },
  });
}
