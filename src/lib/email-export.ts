import { Platform } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Sharing from 'expo-sharing';
import { jmapClient } from '../api/jmap-client';
import { getDownloadUrl } from '../api/blob';
import type { Email } from '../api/types';
import { useSettingsStore } from '../stores/settings-store';
import {
  attachmentDownloadFilename,
  emailExportFilename,
  type EmailFilenameOptions,
} from './download-filename';
import { getClientCertAlias, secureFetch } from './client-cert';

const RFC822 = 'message/rfc822';
const FLAG_GRANT_READ_URI_PERMISSION = 0x00000001;

// Read the user's filename template + transform preferences for exports.
function emailFileOptions(): EmailFilenameOptions {
  const s = useSettingsStore.getState();
  return {
    template: s.emailExportTemplate,
    spaceReplacement: s.exportSpaceReplacement,
    lowercase: s.exportLowercase,
    stripDiacritics: s.exportStripDiacritics,
  };
}

function attachmentFileOptions(): EmailFilenameOptions {
  const s = useSettingsStore.getState();
  return {
    template: s.attachmentExportTemplate,
    spaceReplacement: s.exportSpaceReplacement,
    lowercase: s.exportLowercase,
    stripDiacritics: s.exportStripDiacritics,
  };
}

function authHeader(): string {
  return jmapClient.authHeader;
}

function safeAttachmentName(name: string | undefined, type: string | undefined): string {
  const fallbackExt = type?.split('/')[1]?.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
  const cleaned = (name ?? '').replace(/[\\/:*?"<>|]/g, '_').trim();
  if (cleaned) return cleaned.slice(0, 120);
  return `attachment.${fallbackExt}`;
}

// expo-sharing only accepts `file://` URLs and rejects `content://` with
// "Only local file URLs are supported". On Android it then wraps the file
// itself with its bundled SharingFileProvider before launching the share
// intent, so every `Sharing.shareAsync` below gets `downloaded.uri` and must
// NOT be pre-translated to `downloaded.contentUri`. `openWithViewer` is the
// one exception: it assembles the intent itself, so there it's the reverse —
// only a content URI is grantable to another app.

// Android-only: hand the file to whichever app owns the type (PDF viewer,
// gallery, video player, ...) rather than to the share sheet. Returns false
// when the handoff didn't happen so the caller can fall back to sharing —
// most often because no installed app handles the MIME type, in which case
// startActivityAsync rejects with ActivityNotFoundException.
async function openWithViewer(file: File, mimeType: string): Promise<boolean> {
  try {
    await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
      // Read-only grant, scoped to the receiving app for the life of the
      // intent. Deliberately no FLAG_ACTIVITY_NEW_TASK: expo-intent-launcher
      // uses startActivityForResult, and a new task cancels that result.
      data: file.contentUri,
      type: mimeType,
      flags: FLAG_GRANT_READ_URI_PERMISSION,
    });
    return true;
  } catch (e) {
    console.warn('[attachments] no viewer for', mimeType, '- falling back to share:', e);
    return false;
  }
}

// Routes the download via the client-cert-aware native module when the user
// has picked a cert, and via expo-file-system's native streaming downloader
// otherwise. The streaming path scales to large attachments without buffering
// in JS, so we keep using it as the default.
async function downloadInto(
  url: string,
  dest: File,
  parent: Directory,
): Promise<File> {
  const alias = await getClientCertAlias();
  if (!alias) {
    // The static returns a separately-typed `FileSystemFile`; we already
    // have a fully-typed `File` referencing the same uri, so we ignore the
    // return value and re-use our `dest` reference for downstream code.
    await File.downloadFileAsync(url, dest, {
      headers: { Authorization: authHeader() },
      idempotent: true,
    });
    return dest;
  }
  const response = await secureFetch(url, {
    headers: { Authorization: authHeader() },
  });
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status}`);
  }
  if (!parent.exists) parent.create({ intermediates: true, idempotent: true });
  if (dest.exists) dest.delete();
  const buffer = await response.arrayBuffer();
  dest.create();
  dest.write(new Uint8Array(buffer));
  return dest;
}

export async function shareAttachment(
  blobId: string,
  name: string | undefined,
  type: string | undefined,
  email?: Email | null,
  // Owning account for blobs shared by another principal (Files app).
  accountId?: string,
): Promise<void> {
  const filename = email
    ? attachmentDownloadFilename(email, { name, type }, attachmentFileOptions())
    : safeAttachmentName(name, type);
  const mimeType = type || 'application/octet-stream';
  const dest = new File(Paths.cache, filename);
  const url = getDownloadUrl(blobId, filename, mimeType, accountId);
  const downloaded = await downloadInto(url, dest, Paths.cache);

  if (Platform.OS === 'android' && (await openWithViewer(downloaded, mimeType))) {
    return;
  }
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Sharing is not available on this device');
  }
  await Sharing.shareAsync(downloaded.uri, {
    mimeType,
    dialogTitle: filename,
  });
}

// Save-to-disk variant. iOS doesn't expose a user-visible "Downloads" folder,
// so on both platforms we land the file in the document directory and hand it
// to the share sheet — which on iOS surfaces "Save to Files" and on Android
// surfaces the system save dialog. Unlike the 'preview' counterpart
// (shareAttachment), this one keeps the share sheet on Android as well: "save
// a copy" is a share-sheet destination, not something a viewer app handles.
export async function downloadAttachment(
  blobId: string,
  name: string | undefined,
  type: string | undefined,
  email?: Email | null,
  // Owning account for blobs shared by another principal (Files app).
  accountId?: string,
): Promise<void> {
  const filename = email
    ? attachmentDownloadFilename(email, { name, type }, attachmentFileOptions())
    : safeAttachmentName(name, type);
  const mimeType = type || 'application/octet-stream';
  const dest = new File(Paths.document, filename);
  const url = getDownloadUrl(blobId, filename, mimeType, accountId);
  const downloaded = await downloadInto(url, dest, Paths.document);
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Sharing is not available on this device');
  }
  await Sharing.shareAsync(downloaded.uri, {
    mimeType,
    dialogTitle: filename,
  });
}

export async function fetchRawEmail(blobId: string, accountId?: string): Promise<string> {
  const url = getDownloadUrl(blobId, 'email.eml', RFC822, accountId);
  const r = await secureFetch(url, { headers: { Authorization: authHeader() } });
  if (!r.ok) throw new Error(`Download failed: ${r.status}`);
  return r.text();
}

function safeFilename(subject: string | undefined): string {
  const base = (subject ?? 'email').replace(/[^\w\s-]/g, '').trim().slice(0, 60) || 'email';
  return `${base}.eml`;
}

export async function shareEmailEml(
  blobId: string,
  email?: Email | null,
  subjectFallback?: string,
  // Owning account when the message lives in a shared/group mailbox.
  accountId?: string,
): Promise<void> {
  const filename = email
    ? emailExportFilename(email, emailFileOptions())
    : safeFilename(subjectFallback);
  const dest = new File(Paths.cache, filename);
  const url = getDownloadUrl(blobId, dest.name, RFC822, accountId);
  const downloaded = await downloadInto(url, dest, Paths.cache);
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Sharing is not available on this device');
  }
  await Sharing.shareAsync(downloaded.uri, {
    mimeType: RFC822,
    dialogTitle: 'Share email',
    UTI: 'public.email-message',
  });
}
