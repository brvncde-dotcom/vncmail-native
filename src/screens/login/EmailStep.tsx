import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Mail } from 'lucide-react-native';
import { spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { Button, Input } from '../../components';
import LoginNotice from './LoginNotice';

interface EmailStepProps {
  isAddMode: boolean;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onKnowServer: () => void;
  isSearching: boolean;
  notice?: { title: string; detail?: string } | null;
}

/**
 * One field, keyboard already up. The button stays enabled and validates on
 * press, so nobody is left guessing which field disabled it.
 */
export default function EmailStep({
  isAddMode,
  value,
  onChange,
  onSubmit,
  onKnowServer,
  isSearching,
  notice,
}: EmailStepProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);

  return (
    <View style={styles.root}>
      <View style={styles.heading}>
        <Text style={styles.title}>
          {isAddMode ? "What's the other address?" : "What's your email address?"}
        </Text>
        <Text style={styles.subtitle}>
          That&apos;s usually all we need to find your mail server.
        </Text>
      </View>

      <Input
        placeholder="you@example.com"
        value={value}
        onChangeText={onChange}
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="email"
        textContentType="username"
        keyboardType="email-address"
        returnKeyType="go"
        editable={!isSearching}
        onSubmitEditing={onSubmit}
        leftIcon={<Mail size={17} color={c.textMuted} />}
      />

      <Text style={styles.hint}>Works with Stalwart and any other JMAP mail server.</Text>

      {notice ? <LoginNotice title={notice.title} detail={notice.detail} /> : null}

      <Button variant="default" size="md" onPress={onSubmit} loading={isSearching}>
        {isSearching ? 'Looking up your server…' : 'Continue'}
      </Button>

      <Pressable onPress={onKnowServer} disabled={isSearching} hitSlop={8} style={styles.link}>
        <Text style={styles.linkText}>I know my server address</Text>
      </Pressable>
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    root: { gap: spacing.lg },
    heading: { gap: spacing.sm },
    title: { ...typography.h1, color: c.text },
    subtitle: { ...typography.body, color: c.textSecondary },
    hint: { ...typography.caption, color: c.textMuted, marginTop: -spacing.sm },
    link: { alignItems: 'center', paddingVertical: spacing.sm },
    linkText: { ...typography.body, color: c.textMuted },
  });
}
