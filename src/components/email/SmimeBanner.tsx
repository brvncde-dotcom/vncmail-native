/**
 * S/MIME status strip above a message body.
 *
 * Owns the processing trigger for a message (fetch raw MIME → verify/decrypt) and
 * reports the outcome. `EmailBodyView` reads the same cached result from the store
 * so the body and the badge can never disagree.
 *
 * The wording distinguishes three things users conflate:
 *   • signed and valid, from an address that matches the sender
 *   • signed and valid, but the certificate belongs to someone else
 *   • encrypted, but with an unauthenticated cipher — where the body is shown as
 *     plain text because nothing vouches for it not having been altered
 */
import React from 'react';
import { View, Text, StyleSheet, Pressable, TextInput, ActivityIndicator } from 'react-native';
import { ShieldCheck, ShieldAlert, ShieldX, Lock, KeyRound } from 'lucide-react-native';
import type { Email } from '../../api/types';
import { detectSmime } from '../../lib/smime/detect';
import { useSmimeStore } from '../../stores/smime-store';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';

interface Props {
  email: Email;
  jmapAccountId?: string;
}

export function SmimeBanner({ email, jmapAccountId }: Props) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const isSmime = React.useMemo(() => detectSmime(email) !== 'none', [email]);

  const hydrated = useSmimeStore((s) => s.hydrated);
  const hydrate = useSmimeStore((s) => s.hydrate);
  const processEmail = useSmimeStore((s) => s.processEmail);
  const result = useSmimeStore((s) => s.results[email.id]);
  const pending = useSmimeStore((s) => !!s.pending[email.id]);
  const keys = useSmimeStore((s) => s.keys);
  const unlock = useSmimeStore((s) => s.unlock);

  const [passphrase, setPassphrase] = React.useState('');
  const [unlocking, setUnlocking] = React.useState(false);
  const [unlockError, setUnlockError] = React.useState<string | null>(null);
  const [showUnlock, setShowUnlock] = React.useState(false);

  React.useEffect(() => {
    if (!isSmime) return;
    if (!hydrated) {
      void hydrate();
      return;
    }
    void processEmail(email, jmapAccountId);
  }, [isSmime, hydrated, hydrate, processEmail, email, jmapAccountId]);

  React.useEffect(() => {
    setShowUnlock(false);
    setPassphrase('');
    setUnlockError(null);
  }, [email.id]);

  if (!isSmime) return null;

  if (pending || !result) {
    return (
      <View style={[styles.banner, styles.neutral]}>
        <ActivityIndicator size="small" color={c.mutedForeground} />
        <Text style={styles.text}>Checking S/MIME…</Text>
      </View>
    );
  }

  const lockedKey = result.lockedKeyId
    ? keys.find((k) => k.record.id === result.lockedKeyId)
    : undefined;

  const onUnlock = async () => {
    if (!result.lockedKeyId) return;
    setUnlocking(true);
    setUnlockError(null);
    try {
      const ok = await unlock(result.lockedKeyId, passphrase || undefined);
      if (!ok) {
        setShowUnlock(true);
        setUnlockError(passphrase ? 'Wrong passphrase.' : null);
        return;
      }
      setPassphrase('');
      setShowUnlock(false);
      await processEmail(email, jmapAccountId);
    } catch (err) {
      setUnlockError(err instanceof Error ? err.message : String(err));
    } finally {
      setUnlocking(false);
    }
  };

  if (result.lockedKeyId) {
    return (
      <View style={[styles.banner, styles.warn, styles.column]} testID="smime-banner-locked">
        <View style={styles.row}>
          <Lock size={15} color={c.warning} />
          <Text style={styles.text} numberOfLines={2}>
            Encrypted to {lockedKey?.record.email || 'your certificate'} — unlock it to read this message.
          </Text>
        </View>
        {showUnlock && (
          <TextInput
            style={styles.input}
            value={passphrase}
            onChangeText={setPassphrase}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="Certificate passphrase"
            placeholderTextColor={c.textMuted}
            testID="smime-banner-passphrase"
          />
        )}
        {unlockError && <Text style={styles.error}>{unlockError}</Text>}
        <Pressable style={styles.action} onPress={() => { void onUnlock(); }} disabled={unlocking} hitSlop={8}>
          {unlocking
            ? <ActivityIndicator size="small" color={c.text} />
            : <KeyRound size={14} color={c.text} />}
          <Text style={styles.actionText}>{unlocking ? 'Unlocking…' : 'Unlock'}</Text>
        </Pressable>
      </View>
    );
  }

  if (result.error) {
    return (
      <View style={[styles.banner, styles.bad]} testID="smime-banner-error">
        <ShieldX size={15} color={c.error} />
        <Text style={[styles.text, { color: c.error }]} numberOfLines={4}>{result.error}</Text>
      </View>
    );
  }

  const parts: string[] = [];
  let tone: 'good' | 'warn' | 'bad' = 'good';

  if (result.isEncrypted) {
    parts.push(`Encrypted (${result.contentAlgorithm ?? 'unknown cipher'})`);
    if (!result.contentAuthenticated) {
      tone = 'warn';
      parts.push('not integrity-protected — shown as plain text');
    }
  }

  if (result.isSigned) {
    const sig = result.signature;
    if (sig?.signatureValid) {
      const who = sig.signerCertificate?.emailAddresses[0] ?? sig.signerCertificate?.subject ?? 'unknown signer';
      if (sig.signerEmailMatch === true) {
        parts.push(`Signed by ${who}`);
      } else {
        // Valid crypto, wrong identity. That is a warning, not a pass.
        tone = 'warn';
        parts.push(`Signed, but the certificate belongs to ${who}, not the sender`);
      }
      if (sig.selfSigned) {
        tone = 'warn';
        parts.push('self-signed certificate');
      }
      if (sig.weakDigest) {
        tone = 'warn';
        parts.push('signed with SHA-1');
      }
    } else {
      tone = 'bad';
      parts.push(sig?.signatureError ? `Invalid signature: ${sig.signatureError}` : 'Invalid signature');
    }
  }

  if (parts.length === 0) return null;

  const Icon = tone === 'good' ? ShieldCheck : tone === 'warn' ? ShieldAlert : ShieldX;
  const iconColor = tone === 'good' ? c.success : tone === 'warn' ? c.warning : c.error;

  return (
    <View
      style={[styles.banner, tone === 'good' ? styles.good : tone === 'warn' ? styles.warn : styles.bad]}
      testID="smime-banner"
    >
      <Icon size={15} color={iconColor} />
      <Text style={styles.text} numberOfLines={4}>{parts.join(' · ')}</Text>
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    banner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.md,
      marginHorizontal: spacing.md,
      marginBottom: spacing.sm,
      borderRadius: radius.md,
      borderWidth: 1,
    },
    column: { flexDirection: 'column', alignItems: 'stretch', gap: spacing.sm },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    good: { borderColor: c.border, backgroundColor: c.muted },
    warn: { borderColor: c.warning, backgroundColor: c.muted },
    bad: { borderColor: c.error, backgroundColor: c.errorBg },
    neutral: { borderColor: c.border, backgroundColor: c.muted },
    text: { ...typography.caption, color: c.textSecondary, flex: 1 },
    error: { ...typography.caption, color: c.error },
    action: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      alignSelf: 'flex-start',
      paddingVertical: 6,
      paddingHorizontal: spacing.md,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: c.border,
    },
    actionText: { ...typography.caption, color: c.text },
    input: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
      paddingHorizontal: spacing.sm,
      paddingVertical: 6,
      color: c.text,
      backgroundColor: c.card,
    },
  });
}
