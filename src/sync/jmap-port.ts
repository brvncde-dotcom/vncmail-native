// The network surface the engine needs, as an injectable interface.
//
// Same reasoning as Stage B's `SqliteDriver` seam: the engine's rules are the
// valuable part and they must be testable without a JMAP server. §10.5 already
// requires the engine to be callable headless with no dependency on React, a
// mounted component, or a Zustand store for correctness — a port is what makes that
// enforceable rather than aspirational.
//
// `createJmapPort()` is the real adapter over `src/api/email.ts`. It carries
// `accountIdOverride` through EVERY call: that is the account-pinning primitive the
// D6 fix added, and §8.3 requires the cycle to verify the client still serves its
// account before every network call — not just at cycle start, because a cycle is
// long-lived and `switchAccount` can land in the middle of it.

import {
  captureStates,
  EMAIL_LIST_PROPERTIES,
  EMAIL_MUTABLE_PROPERTIES,
  getEmailChanges,
  getEmailProperties,
  getFullEmails,
  getMailboxChanges,
  getMailboxesRaw,
  getMailboxProperties,
  queryEmailWindow,
  type EmailChangesResult,
  type MailboxChangesResult,
} from '../api/email';
import { jmapClient } from '../api/jmap-client';
import type { Email, Mailbox } from '../api/types';
import type { SnapshotState } from './states';

export interface EmailGetResult {
  list: Email[];
  notFound: string[];
}

export interface JmapPort {
  /**
   * `null` means `cannotCalculateChanges` and NOTHING else. Every other
   * method-level error throws, so a transient failure can never be mistaken for a
   * state invalidation — that distinction is the D5 fix already on `main` and is
   * deliberately not re-implemented here.
   */
  mailboxChanges(
    sinceState: string,
    accountId: string,
  ): Promise<MailboxChangesResult | null>;
  emailChanges(
    sinceState: string,
    maxChanges: number,
    accountId: string,
  ): Promise<EmailChangesResult | null>;

  /** Envelope tier — `EMAIL_LIST_PROPERTIES`. */
  getEnvelopes(ids: string[], accountId: string): Promise<EmailGetResult>;
  /** 3 properties — `keywords` + `mailboxIds` + `id`. Never bodies (§5.3). */
  getMutable(ids: string[], accountId: string): Promise<EmailGetResult>;
  /** Body tier, for jobs C1/C2. */
  getBodies(ids: string[], accountId: string): Promise<EmailGetResult>;

  getMailboxesFull(accountId: string): Promise<Mailbox[]>;
  getMailboxesByIdsFull(ids: string[], accountId: string): Promise<Mailbox[]>;
  getMailboxCounts(ids: string[], accountId: string): Promise<Mailbox[]>;

  /** §6.1's ascending keyset page. Throws `AnchorNotFoundError` on a rejected anchor. */
  queryWindow(options: {
    after?: string;
    before?: string;
    limit: number;
    isAscending?: boolean;
    anchor?: string;
    anchorOffset?: number;
    accountId: string;
  }): Promise<{ ids: string[] }>;

  /** §4.1 step 1: both cursor positions in one request, before touching data. */
  captureStates(accountId: string): Promise<{ mailbox: SnapshotState; email: SnapshotState }>;

  /** Re-read per cycle: `maxObjectsInGet` can change when the session is re-read (F19). */
  maxObjectsInGet(): number;
  maxCallsInRequest(): number;

  /**
   * §8.3: does the singleton client still serve this account? Checked before every
   * network call, which is what closes D6 — a fetch issued for account A can never
   * be written under account B.
   */
  servesAccount(jmapAccountId: string): boolean;
}

export function createJmapPort(): JmapPort {
  return {
    mailboxChanges: (sinceState, accountId) => getMailboxChanges(sinceState, accountId),
    emailChanges: (sinceState, maxChanges, accountId) =>
      getEmailChanges(sinceState, maxChanges, accountId),

    getEnvelopes: (ids, accountId) =>
      getEmailProperties(ids, EMAIL_LIST_PROPERTIES, accountId).then(({ list, notFound }) => ({
        list,
        notFound,
      })),
    getMutable: (ids, accountId) =>
      getEmailProperties(ids, EMAIL_MUTABLE_PROPERTIES, accountId).then(
        ({ list, notFound }) => ({ list, notFound }),
      ),
    getBodies: async (ids, accountId) => {
      // `getFullEmails` already chunks to `min(25, maxObjectsInGet)` and sets
      // `maxBodyValueBytes`, which is the behaviour worth keeping from the old sync.
      const list = await getFullEmails(ids, accountId);
      const returned = new Set(list.map((e) => e.id));
      return { list, notFound: ids.filter((id) => !returned.has(id)) };
    },

    getMailboxesFull: (accountId) => getMailboxesRaw(accountId).then((r) => r.list),
    // `undefined` properties = the full object (RFC 8620 §5.1).
    getMailboxesByIdsFull: (ids, accountId) =>
      getMailboxProperties(ids, undefined, accountId),
    getMailboxCounts: (ids, accountId) =>
      getMailboxProperties(
        ids,
        ['id', 'totalEmails', 'unreadEmails', 'totalThreads', 'unreadThreads'],
        accountId,
      ),

    queryWindow: (options) => queryEmailWindow(options),
    captureStates: (accountId) => captureStates(accountId),

    maxObjectsInGet: () => jmapClient.getMaxObjectsInGet(),
    maxCallsInRequest: () => jmapClient.getMaxCallsInRequest(),
    servesAccount: (jmapAccountId) =>
      jmapClient.isConnected && jmapClient.accountId === jmapAccountId,
  };
}
