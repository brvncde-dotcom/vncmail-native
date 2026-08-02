import { describe, it, expect, vi, beforeEach } from 'vitest';

// Platform.OS is flipped per test, so hoist a mutable object into the module
// mock rather than using the fixed 'android' stub from test-setup.
const { platform } = vi.hoisted(() => ({ platform: { OS: 'android' as string, Version: 33 } }));

vi.mock('react-native', () => ({
  Platform: platform,
  NativeModules: {},
  NativeEventEmitter: class {
    addListener() {
      return { remove: () => undefined };
    }
  },
}));

// A `File` that records both URL forms, so tests can assert which one each
// handoff path was given: expo-sharing needs `file://`, an Intent needs
// `content://`.
vi.mock('expo-file-system', () => {
  class File {
    name: string;
    uri: string;
    contentUri: string;
    exists = true;
    constructor(dir: { uri: string }, name: string) {
      this.name = name;
      this.uri = `${dir.uri}${name}`;
      this.contentUri = `content://org.bulwarkmail.mobile.FileSystemFileProvider/${name}`;
    }
    create() {}
    delete() {}
    write() {}
    static downloadFileAsync = vi.fn(async () => undefined);
  }
  return {
    File,
    Directory: class {},
    Paths: { cache: { uri: 'file:///cache/' }, document: { uri: 'file:///documents/' } },
  };
});

vi.mock('expo-intent-launcher', () => ({
  startActivityAsync: vi.fn(async () => ({ resultCode: -1 })),
}));

vi.mock('expo-sharing', () => ({
  isAvailableAsync: vi.fn(async () => true),
  shareAsync: vi.fn(async () => undefined),
}));

vi.mock('../client-cert', () => ({
  getClientCertAlias: vi.fn(async () => null),
  secureFetch: vi.fn(),
}));

vi.mock('../../api/jmap-client', () => ({
  jmapClient: { authHeader: 'Bearer token' },
}));

vi.mock('../../api/blob', () => ({
  getDownloadUrl: vi.fn((blobId: string, name: string) => `https://mail.example.com/${blobId}/${name}`),
}));

import * as IntentLauncher from 'expo-intent-launcher';
import * as Sharing from 'expo-sharing';
import { shareAttachment, downloadAttachment } from '../email-export';

const VIEW = 'android.intent.action.VIEW';
const FLAG_GRANT_READ_URI_PERMISSION = 0x00000001;

describe('shareAttachment (preview)', () => {
  beforeEach(() => {
    platform.OS = 'android';
    vi.mocked(IntentLauncher.startActivityAsync).mockClear().mockResolvedValue({ resultCode: -1 });
    vi.mocked(Sharing.shareAsync).mockClear();
  });

  it('hands the file to a viewer app via a VIEW intent on Android', async () => {
    await shareAttachment('blob-1', 'report.pdf', 'application/pdf');

    expect(IntentLauncher.startActivityAsync).toHaveBeenCalledWith(VIEW, {
      data: 'content://org.bulwarkmail.mobile.FileSystemFileProvider/report.pdf',
      type: 'application/pdf',
      flags: FLAG_GRANT_READ_URI_PERMISSION,
    });
    // The share sheet is what the direct handoff exists to avoid.
    expect(Sharing.shareAsync).not.toHaveBeenCalled();
  });

  it('falls back to the share sheet when no app handles the type', async () => {
    vi.mocked(IntentLauncher.startActivityAsync).mockRejectedValue(
      new Error('No Activity found to handle Intent'),
    );

    await shareAttachment('blob-2', 'weird.xyz', 'application/x-weird');

    // file:// — expo-sharing rejects content:// URLs outright.
    expect(Sharing.shareAsync).toHaveBeenCalledWith('file:///cache/weird.xyz', {
      mimeType: 'application/x-weird',
      dialogTitle: 'weird.xyz',
    });
  });

  it('surfaces a download failure instead of silently falling back', async () => {
    const { File } = await import('expo-file-system');
    vi.mocked(File.downloadFileAsync).mockRejectedValueOnce(new Error('Download failed: 404'));

    await expect(shareAttachment('blob-3', 'gone.pdf', 'application/pdf')).rejects.toThrow(
      'Download failed: 404',
    );
    expect(IntentLauncher.startActivityAsync).not.toHaveBeenCalled();
  });

  it('uses the share sheet on iOS', async () => {
    platform.OS = 'ios';

    await shareAttachment('blob-4', 'photo.jpg', 'image/jpeg');

    expect(IntentLauncher.startActivityAsync).not.toHaveBeenCalled();
    expect(Sharing.shareAsync).toHaveBeenCalledWith('file:///cache/photo.jpg', {
      mimeType: 'image/jpeg',
      dialogTitle: 'photo.jpg',
    });
  });
});

describe('downloadAttachment (save a copy)', () => {
  beforeEach(() => {
    platform.OS = 'android';
    vi.mocked(IntentLauncher.startActivityAsync).mockClear().mockResolvedValue({ resultCode: -1 });
    vi.mocked(Sharing.shareAsync).mockClear();
  });

  it('keeps the share sheet on Android so the save dialog stays reachable', async () => {
    await downloadAttachment('blob-5', 'report.pdf', 'application/pdf');

    expect(IntentLauncher.startActivityAsync).not.toHaveBeenCalled();
    expect(Sharing.shareAsync).toHaveBeenCalledWith('file:///documents/report.pdf', {
      mimeType: 'application/pdf',
      dialogTitle: 'report.pdf',
    });
  });
});
