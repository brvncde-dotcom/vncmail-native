import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, Alert, Modal, TextInput, ScrollView, ActivityIndicator } from 'react-native';
import {
  Upload, Trash2, Lock, Unlock, ShieldCheck, ShieldAlert, Users, FlaskConical,
} from 'lucide-react-native';
import { SettingsSection, SettingItem, ToggleSwitch } from './settings-section';
import Button from '../Button';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useSettingsStore } from '../../stores/settings-store';
import { useSmimeStore } from '../../stores/smime-store';
import { runSmimeSelfTest, type SelfTestReport } from '../../lib/smime/selftest';

type DocumentPickerModule = typeof import('expo-document-picker');
let documentPickerModule: DocumentPickerModule | null = null;
function loadDocumentPicker(): DocumentPickerModule | null {
  if (documentPickerModule) return documentPickerModule;
  try {
    /* eslint-disable-next-line @typescript-eslint/no-require-imports */
    documentPickerModule = require('expo-document-picker') as DocumentPickerModule;
    return documentPickerModule;
  } catch {
    return null;
  }
}

async function readPickedFile(uri: string): Promise<Uint8Array> {
  const { File } = await import('expo-file-system');
  return new File(uri).bytes();
}

export function SmimeSettings() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const hydrated = useSettingsStore((s) => s.hydrated);
  const hydrateSettings = useSettingsStore((s) => s.hydrate);
  const update = useSettingsStore((s) => s.updateSetting);
  const defaultEncrypt = useSettingsStore((s) => s.smimeDefaultEncrypt);
  const rememberUnlocked = useSettingsStore((s) => s.smimeRememberUnlocked);
  const autoImport = useSettingsStore((s) => s.smimeAutoImport);

  const smimeHydrated = useSmimeStore((s) => s.hydrated);
  const hydrateSmime = useSmimeStore((s) => s.hydrate);
  const keys = useSmimeStore((s) => s.keys);
  const certs = useSmimeStore((s) => s.certs);
  const available = useSmimeStore((s) => s.available);
  const randomSource = useSmimeStore((s) => s.randomSource);
  const lastNotice = useSmimeStore((s) => s.lastNotice);
  const clearNotice = useSmimeStore((s) => s.clearNotice);
  const importIdentity = useSmimeStore((s) => s.importIdentity);
  const importRecipientCertificate = useSmimeStore((s) => s.importRecipientCertificate);
  const removeKey = useSmimeStore((s) => s.removeKey);
  const removeCert = useSmimeStore((s) => s.removeCert);
  const unlock = useSmimeStore((s) => s.unlock);
  const lock = useSmimeStore((s) => s.lock);
  const setRememberUnlocked = useSmimeStore((s) => s.setRememberUnlocked);

  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState<
    | { kind: 'import'; bytes: Uint8Array; name: string }
    | { kind: 'unlock'; id: string; label: string }
    | null
  >(null);
  const [passphrase, setPassphrase] = useState('');
  const [promptError, setPromptError] = useState<string | null>(null);
  const [selfTest, setSelfTest] = useState<SelfTestReport | null>(null);
  const [selfTestRunning, setSelfTestRunning] = useState(false);

  useEffect(() => {
    if (!hydrated) void hydrateSettings();
  }, [hydrated, hydrateSettings]);

  useEffect(() => {
    if (!smimeHydrated) void hydrateSmime();
  }, [smimeHydrated, hydrateSmime]);

  useEffect(() => {
    if (!lastNotice) return;
    Alert.alert('S/MIME', lastNotice, [{ text: 'OK', onPress: clearNotice }]);
  }, [lastNotice, clearNotice]);

  const isExpired = (d: string) => {
    const t = new Date(d).getTime();
    return Number.isFinite(t) && t < Date.now();
  };
  const formatDate = (d: string) => {
    try {
      const t = new Date(d);
      return Number.isFinite(t.getTime()) ? t.toLocaleDateString() : d;
    } catch {
      return d;
    }
  };

  const pickFile = async (types: string[]): Promise<{ bytes: Uint8Array; name: string } | null> => {
    const picker = loadDocumentPicker();
    if (!picker) {
      Alert.alert('Not available', 'The file picker is not available in this build.');
      return null;
    }
    let result: Awaited<ReturnType<DocumentPickerModule['getDocumentAsync']>>;
    try {
      result = await picker.getDocumentAsync({ multiple: false, copyToCacheDirectory: true, type: types });
    } catch {
      return null;
    }
    if (result.canceled || !result.assets?.[0]) return null;
    const asset = result.assets[0];
    try {
      return { bytes: await readPickedFile(asset.uri), name: asset.name ?? 'certificate' };
    } catch (err) {
      Alert.alert('Could not read file', err instanceof Error ? err.message : String(err));
      return null;
    }
  };

  const onImportIdentity = async () => {
    const picked = await pickFile([
      'application/x-pkcs12', 'application/pkcs12', 'application/octet-stream', '*/*',
    ]);
    if (!picked) return;
    setPassphrase('');
    setPromptError(null);
    setPrompt({ kind: 'import', bytes: picked.bytes, name: picked.name });
  };

  const onImportCertificate = async () => {
    const picked = await pickFile([
      'application/x-x509-ca-cert', 'application/pkix-cert', 'application/x-pem-file',
      'text/plain', 'application/octet-stream', '*/*',
    ]);
    if (!picked) return;
    setBusy(true);
    try {
      const saved = await importRecipientCertificate(picked.bytes);
      if (saved > 0) {
        Alert.alert('Certificate imported', `${saved} certificate${saved === 1 ? '' : 's'} saved.`);
      }
    } catch (err) {
      Alert.alert('Import failed', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const submitPrompt = async () => {
    if (!prompt) return;
    setBusy(true);
    setPromptError(null);
    try {
      if (prompt.kind === 'import') {
        const record = await importIdentity(prompt.bytes, passphrase);
        setPrompt(null);
        setPassphrase('');
        Alert.alert(
          'Certificate imported',
          `${record.email || record.subject}\nValid until ${formatDate(record.notAfter)}`,
        );
      } else {
        const ok = await unlock(prompt.id, passphrase);
        if (!ok) {
          setPromptError('Wrong passphrase.');
          return;
        }
        setPrompt(null);
        setPassphrase('');
      }
    } catch (err) {
      setPromptError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onToggleUnlock = async (id: string, label: string, unlocked: boolean) => {
    if (unlocked) {
      await lock(id);
      return;
    }
    // A remembered passphrase unlocks without a prompt.
    try {
      if (await unlock(id)) return;
    } catch (err) {
      Alert.alert('Unlock failed', err instanceof Error ? err.message : String(err));
      return;
    }
    setPassphrase('');
    setPromptError(null);
    setPrompt({ kind: 'unlock', id, label });
  };

  const confirmDeleteKey = (id: string, label: string) => {
    Alert.alert(
      'Delete certificate',
      `Remove ${label} and its private key from this device? Encrypted mail addressed to it will no longer be readable here.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => { void removeKey(id); } },
      ],
    );
  };

  const onRunSelfTest = () => {
    setSelfTestRunning(true);
    setSelfTest(null);
    // Yield a frame so the spinner paints before the (synchronous, RSA-heavy)
    // self-test blocks the JS thread.
    setTimeout(() => {
      try {
        const report = runSmimeSelfTest();
        setSelfTest(report);
        console.log(
          `[smime-selftest] source=${report.randomSource} passed=${report.passed} `
          + `failed=${report.failed} in ${report.durationMs}ms`
          + (report.fatal ? ` FATAL=${report.fatal}` : ''),
        );
        for (const a of report.assertions) {
          console.log(`[smime-selftest] ${a.passed ? 'PASS' : 'FAIL'} [${a.group}] ${a.name}`
            + (a.detail ? ` — ${a.detail}` : ''));
        }
      } catch (err) {
        console.log('[smime-selftest] threw', err);
        setSelfTest({
          randomSource, passed: 0, failed: 1, durationMs: 0, assertions: [],
          fatal: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setSelfTestRunning(false);
      }
    }, 50);
  };

  return (
    <View style={styles.container}>
      {!available && (
        <View style={styles.warnBanner}>
          <ShieldAlert size={18} color={c.error} />
          <Text style={styles.warnText}>
            No secure random source is available on this device, so S/MIME is disabled.
          </Text>
        </View>
      )}

      <SettingsSection
        title="Your Certificates"
        description="Private keys used to sign and decrypt mail. Keys are stored in the device keystore and protected by a passphrase."
      >
        <View style={{ gap: spacing.sm }}>
          {keys.map((k) => {
            const label = k.record.email || k.record.subject;
            const expired = isExpired(k.record.notAfter);
            return (
              <View key={k.record.id} style={styles.certRow} testID={`smime-key-${k.record.id}`}>
                <View style={styles.certLeft}>
                  <View style={[styles.certIcon, expired ? styles.certIconError : styles.certIconOk]}>
                    {expired ? (
                      <ShieldAlert size={16} color={c.error} />
                    ) : (
                      <ShieldCheck size={16} color={c.primary} />
                    )}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.certName} numberOfLines={1}>{label}</Text>
                    <Text style={styles.certMeta} numberOfLines={2}>
                      {k.record.issuer} · Expires {formatDate(k.record.notAfter)}
                      {expired && <Text style={styles.expiredText}> (Expired)</Text>}
                      {k.unlocked ? ' · Unlocked' : ' · Locked'}
                    </Text>
                  </View>
                </View>
                <View style={styles.certActions}>
                  <Pressable
                    style={styles.iconBtn}
                    onPress={() => { void onToggleUnlock(k.record.id, label, k.unlocked); }}
                    hitSlop={6}
                  >
                    {k.unlocked ? (
                      <Unlock size={16} color={c.success} />
                    ) : (
                      <Lock size={16} color={c.text} />
                    )}
                  </Pressable>
                  <Pressable
                    style={styles.iconBtn}
                    onPress={() => confirmDeleteKey(k.record.id, label)}
                    hitSlop={6}
                  >
                    <Trash2 size={16} color={c.error} />
                  </Pressable>
                </View>
              </View>
            );
          })}

          {keys.length === 0 && (
            <Text style={styles.empty}>No certificates imported.</Text>
          )}
        </View>

        <View style={{ alignItems: 'flex-start', marginTop: spacing.sm }}>
          <Button
            variant="outline"
            size="sm"
            disabled={!available || busy}
            onPress={() => { void onImportIdentity(); }}
            icon={<Upload size={14} color={c.text} />}
          >
            Import PKCS#12
          </Button>
        </View>
      </SettingsSection>

      <SettingsSection
        title="Recipient Certificates"
        description="Public certificates used to encrypt outgoing mail."
      >
        <View style={{ gap: spacing.sm }}>
          {certs.map((cert) => {
            const expired = isExpired(cert.notAfter);
            return (
              <View key={cert.id} style={styles.certRow}>
                <View style={styles.certLeft}>
                  <View style={[styles.certIcon, styles.certIconMuted]}>
                    <Users size={16} color={c.mutedForeground} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.certName} numberOfLines={1}>{cert.email || cert.subject}</Text>
                    <Text style={styles.certMeta} numberOfLines={2}>
                      {cert.issuer} · {cert.source === 'manual' ? 'Imported' : 'From signed mail'}
                      {expired && <Text style={styles.expiredText}> (Expired)</Text>}
                    </Text>
                  </View>
                </View>
                <View style={styles.certActions}>
                  <Pressable style={styles.iconBtn} onPress={() => { void removeCert(cert.id); }} hitSlop={6}>
                    <Trash2 size={16} color={c.error} />
                  </Pressable>
                </View>
              </View>
            );
          })}

          {certs.length === 0 && (
            <Text style={styles.empty}>No recipient certificates.</Text>
          )}
        </View>

        <View style={{ alignItems: 'flex-start', marginTop: spacing.sm }}>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onPress={() => { void onImportCertificate(); }}
            icon={<Upload size={14} color={c.text} />}
          >
            Import Certificate
          </Button>
        </View>
      </SettingsSection>

      <SettingsSection
        title="Defaults"
        description="Defaults for new outgoing messages."
      >
        <SettingItem
          label="Encrypt by default"
          description="Encrypt new messages when a certificate is available for every recipient."
        >
          <ToggleSwitch checked={defaultEncrypt} onChange={(v) => update('smimeDefaultEncrypt', v)} />
        </SettingItem>

        <SettingItem
          label="Remember unlocked keys"
          description="Store the key passphrase in the device keystore so keys unlock automatically. Turning this off forgets any passphrase already stored."
        >
          <ToggleSwitch
            checked={rememberUnlocked}
            onChange={(v) => { void setRememberUnlocked(v); }}
          />
        </SettingItem>

        <SettingItem
          label="Auto-import signer certs"
          description="Save public certificates from signed messages. Self-signed certificates are never saved, and an existing certificate is never replaced."
          noBorder
        >
          <ToggleSwitch checked={autoImport} onChange={(v) => update('smimeAutoImport', v)} />
        </SettingItem>
      </SettingsSection>

      <SettingsSection
        title="Diagnostics"
        description={`Random source: ${randomSource}`}
      >
        <View style={{ alignItems: 'flex-start', gap: spacing.sm }}>
          <Button
            variant="outline"
            size="sm"
            disabled={selfTestRunning}
            onPress={onRunSelfTest}
            icon={selfTestRunning
              ? <ActivityIndicator size="small" color={c.text} />
              : <FlaskConical size={14} color={c.text} />}
          >
            {selfTestRunning ? 'Running…' : 'Run crypto self-test'}
          </Button>

          {selfTest && (
            <View style={styles.selfTestBox} testID="smime-selftest-result">
              <Text style={selfTest.failed === 0 && !selfTest.fatal ? styles.selfTestOk : styles.selfTestFail}>
                {selfTest.fatal
                  ? `FATAL: ${selfTest.fatal}`
                  : `${selfTest.failed === 0 ? 'ALL PASS' : 'FAILURES'} — ${selfTest.passed} passed, `
                    + `${selfTest.failed} failed in ${selfTest.durationMs} ms`}
              </Text>
              <Text style={styles.selfTestMeta}>Random source: {selfTest.randomSource}</Text>
              {selfTest.assertions.filter((a) => !a.passed).slice(0, 8).map((a, i) => (
                <Text key={i} style={styles.selfTestFailLine}>
                  {`[${a.group}] ${a.name}${a.detail ? ` — ${a.detail}` : ''}`}
                </Text>
              ))}
              {selfTest.failed === 0 && !selfTest.fatal && (
                <Text style={styles.selfTestMeta}>
                  {[...new Set(selfTest.assertions.map((a) => a.group))].join(' · ')}
                </Text>
              )}
            </View>
          )}
        </View>
      </SettingsSection>

      <Modal visible={!!prompt} transparent animationType="fade" onRequestClose={() => setPrompt(null)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>
              {prompt?.kind === 'import' ? 'PKCS#12 passphrase' : 'Unlock certificate'}
            </Text>
            <Text style={styles.modalBody}>
              {prompt?.kind === 'import'
                ? `Enter the passphrase protecting ${prompt.name}. It is also used to protect the key on this device.`
                : `Enter the passphrase for ${prompt?.kind === 'unlock' ? prompt.label : ''}.`}
            </Text>
            <TextInput
              style={styles.input}
              value={passphrase}
              onChangeText={setPassphrase}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="Passphrase"
              placeholderTextColor={c.textMuted}
              testID="smime-passphrase-input"
            />
            {promptError && <Text style={styles.modalError}>{promptError}</Text>}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.modalActions}>
              <Button variant="ghost" size="sm" onPress={() => { setPrompt(null); setPassphrase(''); }}>
                Cancel
              </Button>
              <Button variant="default" size="sm" loading={busy} onPress={() => { void submitPrompt(); }}>
                {prompt?.kind === 'import' ? 'Import' : 'Unlock'}
              </Button>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  container: { gap: spacing.xxxl },
  warnBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: c.errorBg,
  },
  warnText: { ...typography.caption, color: c.error, flex: 1 },
  certRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
  },
  certLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    flex: 1,
    minWidth: 0,
  },
  certIcon: {
    width: 32,
    height: 32,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  certIconOk: { backgroundColor: c.primaryBg },
  certIconError: { backgroundColor: c.errorBg },
  certIconMuted: { backgroundColor: c.muted },
  certName: { ...typography.bodyMedium, color: c.text },
  certMeta: { ...typography.caption, color: c.mutedForeground, marginTop: 2 },
  expiredText: { color: c.error },
  certActions: { flexDirection: 'row', gap: 2 },
  iconBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
  },
  empty: {
    ...typography.body,
    color: c.mutedForeground,
    textAlign: 'center',
    paddingVertical: spacing.lg,
  },
  selfTestBox: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: 4,
    alignSelf: 'stretch',
  },
  selfTestOk: { ...typography.bodyMedium, color: c.success },
  selfTestFail: { ...typography.bodyMedium, color: c.error },
  selfTestFailLine: { ...typography.caption, color: c.error },
  selfTestMeta: { ...typography.caption, color: c.mutedForeground },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  modalCard: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: c.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: c.border,
    padding: spacing.lg,
    gap: spacing.md,
  },
  modalTitle: { ...typography.h3, color: c.text },
  modalBody: { ...typography.caption, color: c.mutedForeground },
  modalError: { ...typography.caption, color: c.error },
  input: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: c.text,
    backgroundColor: c.muted,
  },
  modalActions: { flexDirection: 'row', gap: spacing.sm, justifyContent: 'flex-end', flexGrow: 1 },
});
}
