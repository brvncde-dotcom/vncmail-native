import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, TextInput, ActivityIndicator } from 'react-native';
import { RefreshCw, CheckCircle, AlertTriangle } from 'lucide-react-native';
import {
  SettingsSection,
  SettingItem,
  ToggleSwitch,
  RadioGroup,
  Select,
} from './settings-section';
import Button from '../Button';
import Input from '../Input';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useSettingsStore } from '../../stores/settings-store';
import { getAiApiKey, setAiApiKey } from '../../lib/ai-key-store';
import { supportsLocalLlm } from '../../lib/platform-capabilities';
import {
  askLocalMail,
  listLocalModels,
  testLocalConnection,
  type AskResult,
} from '../../api/ai';

/**
 * Prototype scope only — see the plan this shipped with. `public` (BYOK,
 * OpenAI-compatible) is the only class offered; `server` doesn't exist
 * because the VNC-hosted proxy it needs isn't built yet, and `local` is
 * never offered on this platform (see `supportsLocalLlm` — a phone can't
 * reach a developer's own laptop loopback address, per
 * `docs/AI-ASSISTANT-CONCEPT.md` §1.1/§3).
 */
export function AiAssistantSettings() {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);

  const hydrated = useSettingsStore((s) => s.hydrated);
  const hydrate = useSettingsStore((s) => s.hydrate);
  const update = useSettingsStore((s) => s.updateSetting);

  const aiEnabled = useSettingsStore((s) => s.aiEnabled);
  const storedProvider = useSettingsStore((s) => s.aiActiveProvider);
  // A device that persisted `local` before this platform gate existed (or
  // synced settings from one that could reach it) falls back to unset here,
  // never to a transport this platform doesn't ship.
  const provider = !supportsLocalLlm && storedProvider === 'local' ? null : storedProvider;
  const localBaseUrl = useSettingsStore((s) => s.aiLocalBaseUrl);
  const localModel = useSettingsStore((s) => s.aiLocalModel);
  const publicBaseUrl = useSettingsStore((s) => s.aiPublicBaseUrl);
  const publicModel = useSettingsStore((s) => s.aiPublicModel);
  const consentAccepted = useSettingsStore((s) => s.aiPublicConsentAccepted);

  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  // ── Local provider ──
  const [localModels, setLocalModels] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle');
  const [testError, setTestError] = useState<string | null>(null);

  const refreshModels = useCallback(async () => {
    setRefreshing(true);
    try {
      const models = await listLocalModels(localBaseUrl);
      setLocalModels(models);
      if (!localModel && models[0]) update('aiLocalModel', models[0]);
    } catch {
      setLocalModels([]);
    } finally {
      setRefreshing(false);
    }
  }, [localBaseUrl, localModel, update]);

  const runTestConnection = useCallback(async () => {
    setTestStatus('testing');
    setTestError(null);
    const result = await testLocalConnection(localBaseUrl);
    if (result.ok) {
      setTestStatus('ok');
    } else {
      setTestStatus('error');
      setTestError(result.error ?? 'Connection failed');
    }
  }, [localBaseUrl]);

  // ── Public provider ──
  const [hasSavedKey, setHasSavedKey] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [savingKey, setSavingKey] = useState(false);

  useEffect(() => {
    void getAiApiKey('public').then((key) => setHasSavedKey(!!key));
  }, []);

  const saveApiKey = useCallback(async () => {
    if (!apiKeyInput) return;
    setSavingKey(true);
    try {
      await setAiApiKey('public', apiKeyInput);
      setHasSavedKey(true);
      setApiKeyInput('');
    } finally {
      setSavingKey(false);
    }
  }, [apiKeyInput]);

  // ── Test prompt ──
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [askResult, setAskResult] = useState<AskResult | null>(null);
  const [askError, setAskError] = useState<string | null>(null);

  const canAsk =
    aiEnabled &&
    question.trim().length > 0 &&
    (provider === 'local' ? !!localModel : provider === 'public' ? !!publicModel && consentAccepted : false);

  const runAsk = useCallback(async () => {
    setAsking(true);
    setAskError(null);
    setAskResult(null);
    try {
      const result = await askLocalMail(question.trim());
      setAskResult(result);
    } catch (err) {
      setAskError(err instanceof Error ? err.message : String(err));
    } finally {
      setAsking(false);
    }
  }, [question]);

  return (
    <View style={styles.container}>
      <SettingsSection
        title="Assistant"
        description="Ask questions about your synced mail. Retrieval runs over the local search index; generation runs on the provider you configure below."
        experimental
        experimentalDescription="Prototype scope: local (a loopback Ollama-compatible runtime) and public (your own API key) providers only. There is no company-hosted model yet, and public questions are not gated by a server-side policy — only by your own consent below."
      >
        <SettingItem label="Enable AI assistant" noBorder>
          <ToggleSwitch checked={aiEnabled} onChange={(v) => update('aiEnabled', v)} />
        </SettingItem>
      </SettingsSection>

      {aiEnabled && (
        <>
          <SettingsSection title="Provider" description="Which model answers your questions.">
            <RadioGroup
              value={provider ?? ''}
              onChange={(v) => update('aiActiveProvider', v as 'local' | 'public')}
              options={[
                ...(supportsLocalLlm ? [{ value: 'local', label: 'Local (Ollama)' }] : []),
                { value: 'public', label: 'Public (your API key)' },
              ]}
            />
          </SettingsSection>

          {provider === 'local' && supportsLocalLlm && (
            <SettingsSection
              title="Local runtime"
              description="Only reachable if this device can hit 127.0.0.1 — e.g. the iOS Simulator running on the same Mac as Ollama. A real phone cannot reach your laptop's loopback address."
            >
              <SettingItem label="Base URL">
                <Input
                  value={localBaseUrl}
                  onChangeText={(v) => update('aiLocalBaseUrl', v)}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={styles.wideInput}
                />
              </SettingItem>
              <SettingItem label="Model" description={localModels.length === 0 ? 'Refresh to list installed models.' : undefined}>
                <View style={styles.row}>
                  {localModels.length > 0 ? (
                    <Select
                      value={localModel}
                      onChange={(v) => update('aiLocalModel', v)}
                      options={localModels.map((m) => ({ value: m, label: m }))}
                    />
                  ) : (
                    <Text style={styles.mutedText}>{localModel || 'None selected'}</Text>
                  )}
                  <Button variant="outline" size="sm" onPress={refreshModels} loading={refreshing}
                    icon={<RefreshCw size={14} color={c.text} />}>
                    Refresh
                  </Button>
                </View>
              </SettingItem>
              <SettingItem label="Connection" noBorder>
                <View style={styles.row}>
                  <Button variant="outline" size="sm" onPress={runTestConnection} loading={testStatus === 'testing'}>
                    Test connection
                  </Button>
                  {testStatus === 'ok' && (
                    <View style={styles.statusRow}>
                      <CheckCircle size={14} color={c.success} />
                      <Text style={[styles.statusText, { color: c.success }]}>Reachable</Text>
                    </View>
                  )}
                  {testStatus === 'error' && (
                    <View style={styles.statusRow}>
                      <AlertTriangle size={14} color={c.error} />
                      <Text style={[styles.statusText, { color: c.error }]} numberOfLines={2}>
                        {testError}
                      </Text>
                    </View>
                  )}
                </View>
              </SettingItem>
            </SettingsSection>
          )}

          {provider === 'public' && (
            <SettingsSection
              title="Public provider"
              description="Any OpenAI-compatible endpoint. Defaults to OpenRouter."
            >
              <SettingItem label="Base URL">
                <Input
                  value={publicBaseUrl}
                  onChangeText={(v) => update('aiPublicBaseUrl', v)}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={styles.wideInput}
                />
              </SettingItem>
              <SettingItem label="Model">
                <Input
                  value={publicModel}
                  onChangeText={(v) => update('aiPublicModel', v)}
                  placeholder="e.g. anthropic/claude-sonnet-4.5"
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={styles.wideInput}
                />
              </SettingItem>
              <SettingItem
                label="API key"
                description={hasSavedKey ? 'A key is saved. Enter a new one to replace it.' : 'Stored on-device only; never sent anywhere but the provider above.'}
              >
                <View style={styles.row}>
                  <Input
                    value={apiKeyInput}
                    onChangeText={setApiKeyInput}
                    placeholder={hasSavedKey ? '•••• saved' : 'sk-...'}
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={styles.wideInput}
                  />
                  <Button variant="outline" size="sm" onPress={saveApiKey} loading={savingKey} disabled={!apiKeyInput}>
                    Save
                  </Button>
                </View>
              </SettingItem>
              <SettingItem
                label="I understand this leaves the organisation"
                description="Your question and the retrieved mail excerpts are sent to the provider above, outside this organisation."
                noBorder
              >
                <ToggleSwitch checked={consentAccepted} onChange={(v) => update('aiPublicConsentAccepted', v)} />
              </SettingItem>
            </SettingsSection>
          )}

          <SettingsSection title="Try it" description="Ask a question against your synced mail.">
            <TextInput
              value={question}
              onChangeText={setQuestion}
              placeholder="What did legal say about the Meier contract deadline?"
              placeholderTextColor={c.textMuted}
              multiline
              style={styles.askInput}
            />
            <Button onPress={runAsk} loading={asking} disabled={!canAsk} style={{ alignSelf: 'flex-start' }}>
              Ask
            </Button>

            {asking && (
              <View style={styles.row}>
                <ActivityIndicator size="small" color={c.primary} />
                <Text style={styles.mutedText}>Retrieving and asking…</Text>
              </View>
            )}

            {askError && (
              <View style={[styles.resultBanner, styles.resultErr]}>
                <AlertTriangle size={16} color={c.error} />
                <Text style={[styles.resultText, { color: c.error }]}>{askError}</Text>
              </View>
            )}

            {askResult && (
              <View style={styles.resultBanner}>
                <Text style={styles.answerText}>{askResult.answer}</Text>
                {askResult.sources.length > 0 && (
                  <View style={styles.sources}>
                    <Text style={styles.sourcesLabel}>Sources</Text>
                    {askResult.sources.map((s, i) => (
                      <Text key={s.id} style={styles.sourceItem} numberOfLines={1}>
                        [{i + 1}] {s.subject}
                      </Text>
                    ))}
                  </View>
                )}
              </View>
            )}
          </SettingsSection>
        </>
      )}
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    container: { gap: spacing.xxxl },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
    wideInput: { minWidth: 220, flexGrow: 1 },
    mutedText: { ...typography.caption, color: c.mutedForeground },
    statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
    statusText: { ...typography.caption },
    askInput: {
      ...typography.body,
      color: c.text,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      padding: spacing.md,
      minHeight: 72,
      textAlignVertical: 'top',
    },
    resultBanner: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      padding: spacing.md,
      gap: spacing.sm,
    },
    resultErr: { borderColor: c.errorBorder, backgroundColor: c.errorBg },
    resultText: { ...typography.body },
    answerText: { ...typography.body, color: c.text },
    sources: { gap: 2, borderTopWidth: 1, borderTopColor: c.border, paddingTop: spacing.sm },
    sourcesLabel: { ...typography.caption, color: c.mutedForeground, fontWeight: '600' },
    sourceItem: { ...typography.caption, color: c.mutedForeground },
  });
}
