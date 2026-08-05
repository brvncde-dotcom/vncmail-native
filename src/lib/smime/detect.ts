/**
 * Cheap S/MIME detection from a JMAP Email, before anything is downloaded.
 *
 * Detection is deliberately structural (part types and filenames) and only
 * decides *whether* to fetch the raw message. What kind of CMS it actually is
 * comes from the DER's own ContentInfo OID later, not from a Content-Type
 * parameter a sender controls.
 */
import type { BodyPart, Email } from '../../api/types';

const MAX_WALK_DEPTH = 20;

export type SmimeKind = 'none' | 'pkcs7-mime' | 'multipart-signed';

const PKCS7_MIME_TYPES = new Set([
  'application/pkcs7-mime',
  'application/x-pkcs7-mime',
]);

const PKCS7_SIGNATURE_TYPES = new Set([
  'application/pkcs7-signature',
  'application/x-pkcs7-signature',
]);

function walk(part: BodyPart | undefined, depth: number, visit: (p: BodyPart) => void): void {
  if (!part || depth >= MAX_WALK_DEPTH) return;
  visit(part);
  for (const child of part.subParts ?? []) walk(child, depth + 1, visit);
}

export function detectSmime(email: Email): SmimeKind {
  let hasPkcs7Mime = false;
  let hasSignedMultipart = false;
  let hasSignaturePart = false;

  walk(email.bodyStructure, 0, (part) => {
    const type = (part.type ?? '').toLowerCase();
    if (PKCS7_MIME_TYPES.has(type)) hasPkcs7Mime = true;
    if (PKCS7_SIGNATURE_TYPES.has(type)) hasSignaturePart = true;
    if (type === 'multipart/signed') hasSignedMultipart = true;
  });

  // Some servers omit bodyStructure but still list the CMS blob as an
  // attachment; `smime.p7m`/`smime.p7s` are the RFC-recommended names.
  for (const att of email.attachments ?? []) {
    const type = (att.type ?? '').toLowerCase();
    const name = (att.name ?? '').toLowerCase();
    if (PKCS7_MIME_TYPES.has(type) || name === 'smime.p7m') hasPkcs7Mime = true;
    if (PKCS7_SIGNATURE_TYPES.has(type) || name === 'smime.p7s') hasSignaturePart = true;
  }

  if (hasPkcs7Mime) return 'pkcs7-mime';
  if (hasSignedMultipart && hasSignaturePart) return 'multipart-signed';
  if (hasSignaturePart) return 'multipart-signed';
  return 'none';
}

export function isSmime(email: Email): boolean {
  return detectSmime(email) !== 'none';
}
