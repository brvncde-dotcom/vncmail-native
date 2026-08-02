import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Eye, EyeOff } from 'lucide-react-native';
import { spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { Button, Input } from '../../components';
import LoginNotice from './LoginNotice';

interface PasswordStepProps {
  serverUrl: string;
  email: string;
  password: string;
  onChangeEmail: (value: string) => void;
  onChangePassword: (value: string) => void;
  onSubmit: () => void;
  notice?: { title: string; detail?: string } | null;
}

function hostOf(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0];
}

/** The fallback for servers without the browser hand-off — and the only step
 *  where a password is typed into the app. */
export default function PasswordStep({
  serverUrl,
  email,
  password,
  onChangeEmail,
  onChangePassword,
  onSubmit,
  notice,
}: PasswordStepProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const [showPassword, setShowPassword] = React.useState(false);

  return (
    <View style={styles.root}>
      <View style={styles.heading}>
        <Text style={styles.title}>Sign in to {hostOf(serverUrl)}</Text>
        <Text style={styles.subtitle}>
          Your password is sent to this server only, and stored in the device keychain.
        </Text>
      </View>

      <Input
        label="Email or username"
        placeholder="you@example.com"
        value={email}
        onChangeText={onChangeEmail}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="email"
        textContentType="username"
        keyboardType="email-address"
      />

      <Input
        label="Password"
        placeholder="Enter your password"
        value={password}
        onChangeText={onChangePassword}
        autoFocus={Boolean(email)}
        secureTextEntry={!showPassword}
        autoComplete="current-password"
        textContentType="password"
        returnKeyType="go"
        onSubmitEditing={onSubmit}
        rightIcon={
          <Pressable
            onPress={() => setShowPassword((v) => !v)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
          >
            {showPassword ? <EyeOff size={20} color={c.textMuted} /> : <Eye size={20} color={c.textMuted} />}
          </Pressable>
        }
      />

      {notice ? <LoginNotice title={notice.title} detail={notice.detail} /> : null}

      <Button variant="default" size="md" onPress={onSubmit}>
        Sign in
      </Button>
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    root: { gap: spacing.lg },
    heading: { gap: spacing.sm },
    title: { ...typography.h1, color: c.text },
    subtitle: { ...typography.body, color: c.textSecondary },
  });
}
