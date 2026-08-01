const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const VERSION = fs.readFileSync(path.join(__dirname, 'VERSION'), 'utf8').trim();

let COMMIT = process.env.GITHUB_SHA || '';
if (!COMMIT) {
  try {
    COMMIT = execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    COMMIT = 'dev';
  }
}
COMMIT = COMMIT.slice(0, 7);

// App Store Connect rejects a build whose CFBundleVersion it has already seen
// for this CFBundleShortVersionString, so this has to advance on every upload
// even when VERSION does not. CI passes the workflow run number; local builds
// fall back to 1 (never uploaded).
const IOS_BUILD_NUMBER = process.env.IOS_BUILD_NUMBER || '1';

module.exports = {
  expo: {
    name: 'Bulwark Mobile',
    slug: 'bulwark-mobile',
    scheme: 'bulwarkmobile',
    version: VERSION,
    orientation: 'portrait',
    icon: './assets/icon.png',
    userInterfaceStyle: 'dark',
    newArchEnabled: true,
    splash: {
      image: './assets/splash-icon.png',
      resizeMode: 'contain',
      backgroundColor: '#09090b',
    },
    ios: {
      supportsTablet: true,
      bundleIdentifier: 'org.bulwarkmail.mobile',
      buildNumber: IOS_BUILD_NUMBER,
      config: {
        // The app only speaks HTTPS/TLS and uses platform crypto, which is
        // exempt. Declaring it here skips the manual export-compliance
        // questionnaire that otherwise blocks every TestFlight build.
        usesNonExemptEncryption: false,
      },
    },
    android: {
      adaptiveIcon: {
        foregroundImage: './assets/adaptive-icon.png',
        backgroundColor: '#09090b',
      },
      edgeToEdgeEnabled: true,
      predictiveBackGestureEnabled: false,
      package: 'com.anonymous.bulwarkmobile',
    },
    web: {
      favicon: './assets/favicon.png',
    },
    plugins: [
      'expo-secure-store',
      '@react-native-community/datetimepicker',
      'expo-localization',
      [
        'expo-camera',
        {
          cameraPermission:
            'Bulwark Mail uses the camera to scan sign-in QR codes shown in webmail.',
          // QR scanning never records audio; leaving the mic entry in would be
          // an unexplained permission in App Review.
          microphonePermission: false,
        },
      ],
      [
        'expo-image-picker',
        {
          photosPermission:
            'Bulwark Mail needs access to your photos so you can attach them to emails and set contact photos.',
          // Only launchImageLibraryAsync is used - no in-app capture.
          cameraPermission: false,
          microphonePermission: false,
        },
      ],
    ],
    extra: {
      commit: COMMIT,
    },
  },
};
