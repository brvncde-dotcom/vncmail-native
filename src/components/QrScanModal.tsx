import React from 'react';
import { View, Text, Pressable, StyleSheet, Modal, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { X } from 'lucide-react-native';
import { spacing, radius, typography, type ThemePalette } from '../theme/tokens';
import { useColors, useResolvedTheme } from '../theme/colors';
import Button from './Button';

interface QrScanModalProps {
  visible: boolean;
  onClose: () => void;
  // Fires once with the raw decoded QR string. The parent is responsible for
  // closing the modal and interpreting the payload.
  onScanned: (data: string) => void;
}

export function QrScanModal({ visible, onClose, onScanned }: QrScanModalProps) {
  const c = useColors();
  const theme = useResolvedTheme();
  const styles = React.useMemo(() => makeStyles(c, theme), [c, theme]);
  const [permission, requestPermission] = useCameraPermissions();
  // Guards against the camera firing onBarcodeScanned dozens of times for the
  // same code before the modal tears down.
  const handled = React.useRef(false);

  React.useEffect(() => {
    if (visible) handled.current = false;
  }, [visible]);

  const handleBarcode = React.useCallback(
    (result: BarcodeScanningResult) => {
      if (handled.current) return;
      handled.current = true;
      onScanned(result.data);
    },
    [onScanned],
  );

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.container}>
        {permission?.granted ? (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={handleBarcode}
          />
        ) : null}

        {permission?.granted ? (
          // Dims everything except the scan square. Four scrim regions leave a
          // transparent hole so the camera shows through only inside the frame.
          <View style={StyleSheet.absoluteFill} pointerEvents="none">
            <View style={styles.scrim} />
            <View style={styles.scrimCenterRow}>
              <View style={styles.scrimSide} />
              <View style={styles.frame} />
              <View style={styles.scrimSide} />
            </View>
            <View style={[styles.scrim, styles.scrimBottom]}>
              <View style={styles.hintWrap}>
                <Text style={styles.hintTitle}>Open Bulwark on your computer</Text>
                <Text style={styles.hint}>
                  Settings → Devices → Add phone shows a code. Point the camera at it.
                </Text>
              </View>
            </View>
          </View>
        ) : null}

        <SafeAreaView style={styles.overlay}>
          <View style={styles.header}>
            <Pressable onPress={onClose} hitSlop={10} style={styles.closeButton}>
              <X size={24} color={c.text} />
            </Pressable>
            <Text style={styles.title}>Sign-in code</Text>
            <View style={styles.closeButton} />
          </View>

          {!permission?.granted ? (
            <View style={styles.permissionWrap}>
              <Text style={styles.permissionText}>
                {permission && !permission.canAskAgain
                  ? 'Camera access is disabled. Enable it in Settings to scan a sign-in QR code.'
                  : 'Bulwark Mail needs camera access to scan a sign-in QR code.'}
              </Text>
              <Button variant="default" size="md" onPress={() => void requestPermission()}>
                Allow camera access
              </Button>
            </View>
          ) : null}
        </SafeAreaView>
      </View>
    </Modal>
  );
}

function makeStyles(c: ThemePalette, theme: 'light' | 'dark') {
  const scrimColor = theme === 'light' ? 'rgba(248,250,252,0.72)' : 'rgba(0,0,0,0.6)';
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: '#000000' },
    overlay: { flex: 1, justifyContent: 'flex-start' },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.lg,
      paddingTop: Platform.OS === 'android' ? spacing.xl : spacing.sm,
      paddingBottom: spacing.md,
    },
    closeButton: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
    title: { ...typography.h3, color: c.text },
    scrim: { flex: 1, backgroundColor: scrimColor },
    scrimCenterRow: { flexDirection: 'row', height: 240 },
    scrimSide: { flex: 1, backgroundColor: scrimColor },
    scrimBottom: { alignItems: 'center', paddingTop: spacing.xl },
    frame: {
      width: 240,
      height: 240,
      borderWidth: 3,
      borderColor: c.text,
      borderRadius: radius.lg,
      backgroundColor: 'transparent',
    },
    hintWrap: { alignItems: 'center', gap: spacing.xs, paddingHorizontal: spacing.xxl },
    hintTitle: { ...typography.bodySemibold, color: c.text, textAlign: 'center' },
    hint: {
      ...typography.caption,
      color: c.textSecondary,
      textAlign: 'center',
    },
    permissionWrap: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.lg,
      paddingHorizontal: spacing.xxl,
      backgroundColor: c.background,
    },
    permissionText: { ...typography.body, color: c.text, textAlign: 'center' },
  });
}
