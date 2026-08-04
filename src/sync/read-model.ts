// Turning stored rows back into the `Email` shape the UI already speaks.
//
// The engine's storage model is deliberately two-tier (§2.1): an envelope is ~1 KB and is
// what the offline list, the FTS index and the retention decision need, while a body is
// 10-500 KB and only needed when a message is opened. The UI's `Email` type is the union
// of both, so a list read produces an envelope-only `Email` and a detail read merges the
// body in.

import type { Email } from '../api/types';
import type { BodyRow, EnvelopeRow } from './store';

/** Envelope tier only — no body parts. Enough for a list row. */
export function envelopeToEmail(row: EnvelopeRow): Email {
  return {
    id: row.id,
    threadId: row.threadId ?? row.id,
    mailboxIds: { ...row.mailboxIds },
    keywords: { ...row.keywords },
    size: row.size ?? 0,
    receivedAt: row.receivedAt,
    from: row.from ?? undefined,
    to: row.to ?? undefined,
    cc: row.cc ?? undefined,
    subject: row.subject ?? undefined,
    preview: row.preview ?? undefined,
    hasAttachment: row.hasAttachment,
  };
}

/**
 * Merge the body tier onto an envelope. `body.json` is opaque to the store on purpose —
 * it is exactly the property set §2.1 lists for the body tier — so a parse failure here
 * means a corrupt row rather than a schema mismatch, and the envelope is still usable.
 */
export function withBody(email: Email, body: BodyRow | null): Email {
  if (!body) return email;
  try {
    const parsed = JSON.parse(body.json) as Partial<Email>;
    return { ...email, ...parsed, id: email.id };
  } catch {
    console.warn('[sync] unparseable body row for', email.id, '- returning envelope only');
    return email;
  }
}
