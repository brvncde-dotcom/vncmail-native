// A fake JMAP server with a REAL change log, implementing `JmapPort`.
//
// This is the Stage C equivalent of Stage B's node:sqlite driver: the point is that
// the engine's rules get exercised against something that actually behaves like the
// protocol — monotonic state tokens, `maxChanges` truncation with legitimate
// intermediate states, create/update/destroy overlap, `notFound`, inclusive `after`
// filtering, and a configurable change-log floor so `cannotCalculateChanges` can be
// provoked rather than stubbed.
//
// A `vi.fn()` returning canned arrays could not test any of that, and the failure
// modes §11 cares about (a page truncated mid-drain, a message destroyed between two
// calls, a cursor older than the log) only exist in the interaction.

import type { Email, Mailbox } from '../../api/types';
import { AnchorNotFoundError } from '../../api/email';
import type { EmailGetResult, JmapPort } from '../jmap-port';
import { asChangesState, asSnapshotState } from '../states';
import type { EmailChangesResult, MailboxChangesResult } from '../../api/email';

interface Versioned<T> {
  value: T;
  createdAtV: number;
  updatedAtV: number;
  destroyedAtV: number | null;
}

export interface FakeServerOptions {
  accountId?: string;
  /** Cursors older than this are answered with cannotCalculateChanges (F9). */
  changeLogFloor?: number;
  maxObjectsInGet?: number;
}

function stateToken(v: number): string {
  return `s${v}`;
}

function parseState(state: string): number | null {
  const m = /^s(\d+)$/.exec(state);
  return m ? Number(m[1]) : null;
}

export class FakeJmapServer {
  private version = 0;
  private emails = new Map<string, Versioned<Email>>();
  private mailboxes = new Map<string, Versioned<Mailbox>>();

  readonly accountId: string;
  changeLogFloor: number;
  maxObjectsInGetValue: number;

  /** Per-method fault injection. Set to a factory to throw on the next call. */
  faults: Partial<Record<
    'emailChanges' | 'mailboxChanges' | 'getEnvelopes' | 'getMutable' | 'getBodies' | 'queryWindow' | 'captureStates',
    (() => Error) | null
  >> = {};

  /** Counts every call, so "no body refetch occurred" is a real assertion. */
  readonly calls: Record<string, number> = {};

  /** When set, `updatedProperties` is reported for Mailbox/changes (§5.2). */
  mailboxUpdatedProperties: string[] | null = null;

  /** When true, `oldState` is echoed with a cosmetic suffix (F39). */
  echoCosmeticOldState = false;

  /** When set, the account the client "serves" differs — the D6 hazard. */
  servedAccountId: string | null = null;

  private anchorSupported = true;

  constructor(options: FakeServerOptions = {}) {
    this.accountId = options.accountId ?? 'jmap-acct-1';
    this.changeLogFloor = options.changeLogFloor ?? 0;
    this.maxObjectsInGetValue = options.maxObjectsInGet ?? 500;
  }

  // ── authoring ──

  private bump(): number {
    this.version += 1;
    return this.version;
  }

  get currentVersion(): number {
    return this.version;
  }

  disableAnchor(): void {
    this.anchorSupported = false;
  }

  /**
   * Make every EXISTING cursor too old, so `/changes` answers
   * cannotCalculateChanges — the server lost or rebuilt its change log (F9).
   *
   * The bump matters: `changeLogFloor` rejects a cursor when `since < floor`, so
   * setting the floor to the CURRENT version without advancing it first leaves an
   * existing cursor (already at that version) perfectly valid, and setting it one
   * ABOVE the current version would reject even a freshly captured cursor — an
   * artificial invalidation loop rather than the condition F9 is about.
   */
  expireChangeLog(): void {
    this.bump();
    this.changeLogFloor = this.version;
  }

  createEmail(email: Partial<Email> & { id: string; receivedAt: string }): Email {
    const v = this.bump();
    const full: Email = {
      threadId: `T-${email.id}`,
      mailboxIds: { inbox: true },
      keywords: {},
      size: 1000,
      hasAttachment: false,
      subject: `subject ${email.id}`,
      preview: 'preview',
      from: [{ email: 'sender@example.com' }],
      to: [{ email: 'me@example.com' }],
      textBody: [{ partId: '1', type: 'text/plain' }],
      bodyValues: { '1': { value: `body of ${email.id}` } },
      blobId: `blob-${email.id}`,
      ...email,
    };
    this.emails.set(full.id, {
      value: full,
      createdAtV: v,
      updatedAtV: v,
      destroyedAtV: null,
    });
    return full;
  }

  /** Only `keywords` and `mailboxIds` are mutable (RFC 8621 §4.1). */
  updateEmail(id: string, patch: Pick<Partial<Email>, 'keywords' | 'mailboxIds'>): void {
    const record = this.emails.get(id);
    if (!record || record.destroyedAtV !== null) return;
    record.value = { ...record.value, ...patch };
    record.updatedAtV = this.bump();
  }

  destroyEmail(id: string): void {
    const record = this.emails.get(id);
    if (!record || record.destroyedAtV !== null) return;
    record.destroyedAtV = this.bump();
  }

  createMailbox(mailbox: Partial<Mailbox> & { id: string; name: string }): void {
    const v = this.bump();
    this.mailboxes.set(mailbox.id, {
      value: {
        parentId: null,
        role: null,
        sortOrder: 0,
        totalEmails: 0,
        unreadEmails: 0,
        totalThreads: 0,
        unreadThreads: 0,
        myRights: {
          mayReadItems: true,
          mayAddItems: true,
          mayRemoveItems: true,
          maySetSeen: true,
          maySetKeywords: true,
          mayCreateChild: true,
          mayRename: true,
          mayDelete: true,
          maySubmit: true,
        } as Mailbox['myRights'],
        isSubscribed: true,
        ...mailbox,
      } as Mailbox,
      createdAtV: v,
      updatedAtV: v,
      destroyedAtV: null,
    });
  }

  updateMailboxCounts(id: string, counts: Partial<Mailbox>): void {
    const record = this.mailboxes.get(id);
    if (!record || record.destroyedAtV !== null) return;
    record.value = { ...record.value, ...counts };
    record.updatedAtV = this.bump();
  }

  destroyMailbox(id: string): void {
    const record = this.mailboxes.get(id);
    if (!record || record.destroyedAtV !== null) return;
    record.destroyedAtV = this.bump();
  }

  liveEmailIds(): string[] {
    return [...this.emails.values()]
      .filter((r) => r.destroyedAtV === null)
      .map((r) => r.value.id)
      .sort();
  }

  // ── the change log ──

  private changesFor<T>(
    store: Map<string, Versioned<T>>,
    since: number,
    maxChanges: number,
  ): { created: string[]; updated: string[]; destroyed: string[]; newState: number; hasMore: boolean } {
    interface Candidate {
      id: string;
      v: number;
      bucket: 'created' | 'updated' | 'destroyed';
    }
    const candidates: Candidate[] = [];
    for (const [id, r] of store) {
      if (r.destroyedAtV !== null && r.destroyedAtV > since) {
        // RFC 8620 §5.2: created+destroyed since the old state SHOULD be omitted
        // entirely, and this server does.
        if (r.createdAtV > since) continue;
        candidates.push({ id, v: r.destroyedAtV, bucket: 'destroyed' });
        continue;
      }
      if (r.destroyedAtV !== null) continue;
      if (r.createdAtV > since) {
        candidates.push({ id, v: r.createdAtV, bucket: 'created' });
        continue;
      }
      if (r.updatedAtV > since) {
        candidates.push({ id, v: r.updatedAtV, bucket: 'updated' });
      }
    }

    candidates.sort((a, b) => a.v - b.v || a.id.localeCompare(b.id));
    const taken = candidates.slice(0, Math.max(1, maxChanges));
    const hasMore = taken.length < candidates.length;
    // An intermediate state is sanctioned when hasMoreChanges is true (RFC 8620
    // §5.2) — which is the ONLY reason crash recovery costs one page not a resync.
    const newState = hasMore ? taken[taken.length - 1].v : this.version;

    return {
      created: taken.filter((c) => c.bucket === 'created').map((c) => c.id),
      updated: taken.filter((c) => c.bucket === 'updated').map((c) => c.id),
      destroyed: taken.filter((c) => c.bucket === 'destroyed').map((c) => c.id),
      newState,
      hasMore,
    };
  }

  private count(name: string): void {
    this.calls[name] = (this.calls[name] ?? 0) + 1;
  }

  private throwIfFaulty(name: keyof FakeJmapServer['faults']): void {
    const fault = this.faults[name];
    if (fault) {
      this.faults[name] = null;
      throw fault();
    }
  }

  private project(email: Email, properties: string[]): Email {
    const out: Record<string, unknown> = { id: email.id };
    for (const p of properties) {
      if (p === 'id') continue;
      out[p] = (email as unknown as Record<string, unknown>)[p];
    }
    return out as unknown as Email;
  }

  // ── the port ──

  asPort(): JmapPort {
    const server = this;
    return {
      async mailboxChanges(sinceState, accountId): Promise<MailboxChangesResult | null> {
        server.count('mailboxChanges');
        server.throwIfFaulty('mailboxChanges');
        server.assertAccount(accountId);
        const since = parseState(sinceState);
        if (since === null || since < server.changeLogFloor) return null;
        const res = server.changesFor(server.mailboxes, since, server.maxObjectsInGetValue);
        return {
          oldState: asChangesState(
            server.echoCosmeticOldState ? `${sinceState} ` : sinceState,
          ),
          newState: asChangesState(stateToken(res.newState)),
          hasMoreChanges: res.hasMore,
          created: res.created,
          updated: res.updated,
          destroyed: res.destroyed,
          updatedProperties: server.mailboxUpdatedProperties,
        };
      },

      async emailChanges(sinceState, maxChanges, accountId): Promise<EmailChangesResult | null> {
        server.count('emailChanges');
        server.throwIfFaulty('emailChanges');
        server.assertAccount(accountId);
        const since = parseState(sinceState);
        if (since === null || since < server.changeLogFloor) return null;
        const res = server.changesFor(server.emails, since, maxChanges);
        return {
          oldState: asChangesState(
            server.echoCosmeticOldState ? `${sinceState} ` : sinceState,
          ),
          newState: asChangesState(stateToken(res.newState)),
          hasMoreChanges: res.hasMore,
          created: res.created,
          updated: res.updated,
          destroyed: res.destroyed,
        };
      },

      async getEnvelopes(ids, accountId): Promise<EmailGetResult> {
        server.count('getEnvelopes');
        server.throwIfFaulty('getEnvelopes');
        server.assertAccount(accountId);
        return server.getEmails(ids, [
          'id', 'threadId', 'mailboxIds', 'keywords', 'size',
          'receivedAt', 'from', 'to', 'cc', 'subject', 'preview', 'hasAttachment',
        ]);
      },

      async getMutable(ids, accountId): Promise<EmailGetResult> {
        server.count('getMutable');
        server.throwIfFaulty('getMutable');
        server.assertAccount(accountId);
        return server.getEmails(ids, ['id', 'keywords', 'mailboxIds']);
      },

      async getBodies(ids, accountId): Promise<EmailGetResult> {
        server.count('getBodies');
        server.throwIfFaulty('getBodies');
        server.assertAccount(accountId);
        return server.getEmails(ids, [
          'id', 'receivedAt', 'bodyStructure', 'textBody', 'htmlBody',
          'bodyValues', 'attachments', 'blobId', 'bcc', 'replyTo', 'sentAt',
        ]);
      },

      async getMailboxesFull(accountId): Promise<Mailbox[]> {
        server.count('getMailboxesFull');
        server.assertAccount(accountId);
        return [...server.mailboxes.values()]
          .filter((r) => r.destroyedAtV === null)
          .map((r) => ({ ...r.value }));
      },

      async getMailboxesByIdsFull(ids, accountId): Promise<Mailbox[]> {
        server.count('getMailboxesByIdsFull');
        server.assertAccount(accountId);
        return ids
          .map((id) => server.mailboxes.get(id))
          .filter((r): r is Versioned<Mailbox> => Boolean(r && r.destroyedAtV === null))
          .map((r) => ({ ...r.value }));
      },

      async getMailboxCounts(ids, accountId): Promise<Mailbox[]> {
        server.count('getMailboxCounts');
        server.assertAccount(accountId);
        return ids
          .map((id) => server.mailboxes.get(id))
          .filter((r): r is Versioned<Mailbox> => Boolean(r && r.destroyedAtV === null))
          .map((r) => ({
            id: r.value.id,
            totalEmails: r.value.totalEmails,
            unreadEmails: r.value.unreadEmails,
            totalThreads: r.value.totalThreads,
            unreadThreads: r.value.unreadThreads,
          }) as Mailbox);
      },

      async queryWindow(options): Promise<{ ids: string[] }> {
        server.count('queryWindow');
        server.throwIfFaulty('queryWindow');
        server.assertAccount(options.accountId);
        if (options.anchor !== undefined && !server.anchorSupported) {
          throw new AnchorNotFoundError();
        }
        let live = [...server.emails.values()]
          .filter((r) => r.destroyedAtV === null)
          .map((r) => r.value);
        // RFC 8621 §4.4.1: `after` is INCLUSIVE ("the same or after"), `before` is
        // exclusive ("must be before").
        if (options.after !== undefined) {
          live = live.filter((e) => e.receivedAt >= options.after!);
        }
        if (options.before !== undefined) {
          live = live.filter((e) => e.receivedAt < options.before!);
        }
        const ascending = options.isAscending ?? true;
        live.sort((a, b) =>
          a.receivedAt === b.receivedAt
            ? a.id.localeCompare(b.id)
            : (a.receivedAt < b.receivedAt ? -1 : 1) * (ascending ? 1 : -1),
        );
        let ids = live.map((e) => e.id);
        if (options.anchor !== undefined) {
          const at = ids.indexOf(options.anchor);
          if (at === -1) throw new AnchorNotFoundError();
          ids = ids.slice(at + (options.anchorOffset ?? 1));
        }
        return { ids: ids.slice(0, options.limit) };
      },

      async captureStates(accountId) {
        server.count('captureStates');
        server.throwIfFaulty('captureStates');
        server.assertAccount(accountId);
        return {
          mailbox: asSnapshotState(stateToken(server.version)),
          email: asSnapshotState(stateToken(server.version)),
        };
      },

      maxObjectsInGet: () => server.maxObjectsInGetValue,
      maxCallsInRequest: () => 16,
      servesAccount: (jmapAccountId) =>
        (server.servedAccountId ?? server.accountId) === jmapAccountId,
    };
  }

  private assertAccount(accountId: string): void {
    // Mirrors the real client: every call carries an explicit accountId (the D6
    // account-pinning primitive), and answering for the wrong one would be a bug.
    if (accountId !== this.accountId) {
      throw new Error(`accountNotFound: fake server serves ${this.accountId}, asked for ${accountId}`);
    }
  }

  private getEmails(ids: string[], properties: string[]): EmailGetResult {
    const list: Email[] = [];
    const notFound: string[] = [];
    for (const id of ids) {
      const r = this.emails.get(id);
      if (!r || r.destroyedAtV !== null) {
        // F11: an id destroyed between /changes and /get. Normal, not an error.
        notFound.push(id);
        continue;
      }
      list.push(this.project(r.value, properties));
    }
    return { list, notFound };
  }
}

export { stateToken as fakeStateToken };
