import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Email, Mailbox, StateChange } from '../api/types';
import { jmapClient } from '../api/jmap-client';
import {
  getMailboxes as fetchMailboxes,
  getMailboxesWithState,
  getSharedMailboxes,
  getMailboxesByIds,
  getMailboxChanges,
  queryEmails,
  getEmailQueryChanges,
  getEmails as fetchEmails,
  getEmailsWithState,
  getEmailChanges,
  getFullEmail,
  importEmailBlob,
  setEmailKeywords,
  setKeywordsForEmails,
  moveEmail,
  moveEmails as apiMoveEmails,
  archiveEmails as apiArchiveEmails,
  deleteEmail as apiDeleteEmail,
  deleteEmails as apiDeleteEmails,
  restoreEmailMailboxes,
  searchEmails as apiSearchEmails,
  unprefixMailboxId,
} from '../api/email';
import { mailboxesForSiblingOf } from '../lib/mailbox-tree';
import { toWildcardQuery } from '../lib/search-utils';
import { generateAccountId } from '../lib/account-utils';
import { useSettingsStore } from './settings-store';
import { useOfflineCacheStore } from './offline-cache-store';
import { useOutboxStore, applyOrQueue, applyOrQueueBatch, type OutboxOp } from './outbox-store';

// Keep the offline body cache consistent with an optimistic/queued mutation so
// re-opening a message while offline shows the change. Fire-and-forget.
function patchCache(id: string, changes: { keywords?: Record<string, boolean>; mailboxIds?: Record<string, boolean> }): void {
  void useOfflineCacheStore.getState().patch(id, changes);
}
function dropFromCache(ids: string[]): void {
  void useOfflineCacheStore.getState().remove(ids);
}
// Compute an email's full mailboxIds map after removing one mailbox and adding
// another — the idempotent target the outbox replays for a move/trash.
function mailboxesAfterMove(
  current: Record<string, boolean> | undefined,
  fromMailboxId: string | null,
  toMailboxId: string,
): Record<string, boolean> {
  const next: Record<string, boolean> = {};
  for (const [id, present] of Object.entries(current ?? {})) {
    if (present && id !== fromMailboxId) next[id] = true;
  }
  next[toMailboxId] = true;
  return next;
}

// Where a folder actually lives. The user's own folders keep their raw JMAP id
// and get no account override, so every existing call path stays exactly as it
// was; a shared (Stalwart group account) folder resolves to its owning account
// plus the unprefixed id the server knows it by.
interface MailboxRef {
  /** JMAP account override — undefined for the user's own folders. */
  accountId?: string;
  /** Id to send to the server, with any `<accountId>:` prefix stripped. */
  id: string;
}

function refFor(mailboxes: Mailbox[], mailboxId: string): MailboxRef {
  const mailbox = mailboxes.find((m) => m.id === mailboxId);
  if (!mailbox?.isShared) return { id: mailboxId };
  return { accountId: mailbox.accountId, id: mailbox.originalId ?? mailboxId };
}

function rawMailboxId(mailboxes: Mailbox[], mailboxId: string): string {
  return refFor(mailboxes, mailboxId).id;
}

// The JMAP account behind the folder currently on screen. Undefined for the
// user's own folders, which keeps every own-mail call on the default path.
function currentAccountId(state: EmailState): string | undefined {
  if (!state.currentMailboxId) return undefined;
  return refFor(state.mailboxes, state.currentMailboxId).accountId;
}

// Strip the shared-folder id prefix off a whole list. Server-side folder
// matching (archive year/month auto-foldering) compares ids and parent links
// against what Mailbox/set returns, which is always unprefixed.
function toRawMailboxes(mailboxes: Mailbox[]): Mailbox[] {
  return mailboxes.map((m) => (m.isShared
    ? {
      ...m,
      id: m.originalId ?? m.id,
      parentId: m.parentId ? unprefixMailboxId(m.parentId, m.accountId) : m.parentId,
    }
    : m));
}

// Key for `emailStates`. JMAP Email state tokens are per-account, so the
// primary account and each shared account track their own.
const PRIMARY_STATE_KEY = '@primary';
function stateKey(accountId?: string): string {
  return accountId ?? PRIMARY_STATE_KEY;
}

// Record (or forget, when the server said cannotCalculateChanges) one
// account's Email state without disturbing the others'.
function withEmailState(
  states: Record<string, string>,
  accountId: string | undefined,
  value: string | undefined,
): Record<string, string> {
  const key = stateKey(accountId);
  if (value === undefined) {
    const { [key]: _drop, ...rest } = states;
    return rest;
  }
  return { ...states, [key]: value };
}

// True only when the JMAP client is actually serving the email-store's active
// account. During an account switch there's a window between
// setActiveAccount() (which swaps the email-store view immediately) and
// jmapClient.loadAccount() resolving, when the client is still on the
// *previous* account. Without this guard, any fetchMailboxes/refreshEmails
// fired in that window (e.g. by an EmailListScreen useEffect reacting to
// the empty new-account view) would return the previous account's data and
// stamp it into the new account's snapshot.
function jmapClientServesActiveAccount(activeAccountId: string | null): boolean {
  if (!activeAccountId) return false;
  if (!jmapClient.isConnected) return false;
  const username = jmapClient.username;
  const serverUrl = jmapClient.serverUrl;
  if (!username || !serverUrl) return false;
  return generateAccountId(username, serverUrl) === activeAccountId;
}

export interface EmailFilters {
  from?: string;
  to?: string;
  subject?: string;
  dateAfter?: string;  // YYYY-MM-DD
  dateBefore?: string; // YYYY-MM-DD
  hasAttachment?: boolean; // undefined = unset, true = with, false = without
  isStarred?: boolean;
  isUnread?: boolean;
}

// Snapshot of an action that can still be reversed via the undo snackbar.
// We store the full email object so undo can re-insert it into the visible list
// optimistically without waiting for a refetch.
export interface UndoEntry {
  kind: 'archive' | 'delete' | 'move' | 'spam';
  /** Human-readable label shown in the snackbar (e.g. "Email archived"). */
  label: string;
  /** Time the entry was created - the snackbar uses this to drive its timer. */
  createdAt: number;
  /** JMAP account the messages live under; unset for the user's own mail. */
  accountId?: string;
  /** Each item is one email's pre-action mailboxIds, used to restore it. */
  items: Array<{ email: Email; originalMailboxIds: Record<string, boolean> }>;
}

// Cached emails for one mailbox (the base view: no search query, no filters).
// `queryState` is the JMAP queryState for the matching Email/query, used to
// drive Email/queryChanges on the next refresh.
interface MailboxSnapshot {
  emails: Email[];
  total: number;
  queryState?: string;
}

// Everything we cache for one account so switching accounts can restore the
// previous view instantly instead of going through a network round-trip.
interface AccountSnapshot {
  mailboxes: Mailbox[];
  mailboxState?: string;       // JMAP Mailbox state (drives Mailbox/changes)
  // JMAP Email state per JMAP account (drives Email/changes). Keyed by
  // `stateKey()`: the primary account plus any shared/group accounts.
  emailStates: Record<string, string>;
  currentMailboxId: string | null;
  mailboxSnapshots: Record<string, MailboxSnapshot>;
}

export interface EmailState {
  // ── Per-account persisted caches ──────────────────────────────
  // accountSnapshots is the source of truth for accounts the user is *not*
  // currently viewing. The active account's data lives in the top-level
  // fields below (`mailboxes`, `mailboxSnapshots`, `mailboxState`, `emailStates`,
  // `currentMailboxId`, `emails`, `totalEmails`, `queryState`) so consumers
  // keep reading the same shape they always have.
  accountSnapshots: Record<string, AccountSnapshot>;
  activeAccountId: string | null;

  // ── Active view (the currently-shown account/mailbox) ─────────
  mailboxes: Mailbox[];
  mailboxState?: string;
  emailStates: Record<string, string>;
  currentMailboxId: string | null;
  mailboxSnapshots: Record<string, MailboxSnapshot>;
  emails: Email[];
  totalEmails: number;
  queryState?: string;          // queryState for the currently-shown mailbox

  // ── UI state (not persisted, not per-account) ─────────────────
  loading: boolean;
  error: string | null;
  searchQuery: string;
  filters: EmailFilters;
  pendingUndo: UndoEntry | null;

  // ── Actions ────────────────────────────────────────────────────
  setActiveAccount: (accountId: string | null) => void;
  removeAccount: (accountId: string) => void;
  clearAllAccounts: () => void;
  fetchMailboxes: () => Promise<void>;
  selectMailbox: (mailboxId: string) => Promise<void>;
  loadMoreEmails: () => Promise<void>;
  refreshEmails: () => Promise<void>;
  importEmails: (
    files: { uri: string; name: string; mimeType?: string }[],
    mailboxId: string,
  ) => Promise<{ imported: number; failed: number }>;
  handleStateChange: (change: StateChange) => Promise<void>;
  getEmailDetail: (id: string, accountId?: string) => Promise<Email>;
  markRead: (emailId: string, accountId?: string) => Promise<void>;
  markUnread: (emailId: string) => Promise<void>;
  toggleStar: (emailId: string, starred: boolean) => Promise<void>;
  togglePin: (emailId: string, pinned: boolean) => Promise<void>;
  moveToMailbox: (emailId: string, fromMailboxId: string, toMailboxId: string) => Promise<void>;
  archiveEmail: (emailId: string) => Promise<void>;
  deleteEmail: (emailId: string, trashMailboxId: string, currentMailboxId: string) => Promise<void>;
  // ── Batch (multi-select) actions ──────────────────────────────
  archiveEmailsBatch: (emailIds: string[]) => Promise<void>;
  moveEmailsToMailbox: (emailIds: string[], toMailboxId: string) => Promise<void>;
  deleteEmailsBatch: (emailIds: string[], trashMailboxId: string, currentMailboxId: string) => Promise<void>;
  setKeywordForEmails: (emailIds: string[], token: string, on: boolean) => Promise<void>;
  undoLast: () => Promise<void>;
  clearUndo: () => void;
  searchEmails: (query: string) => Promise<Email[]>;
  setSearchQuery: (query: string) => void;
  setFilters: (filters: EmailFilters) => void;
  clearSearchAndFilters: () => void;
  reset: () => void;
}

function buildJmapFilter(
  mailboxId: string,
  searchQuery: string,
  filters: EmailFilters,
): Record<string, unknown> {
  const conditions: Record<string, unknown>[] = [{ inMailbox: mailboxId }];

  const trimmed = searchQuery.trim();
  if (trimmed) conditions.push({ text: toWildcardQuery(trimmed) });

  if (filters.from) conditions.push({ from: filters.from });
  if (filters.to) conditions.push({ to: filters.to });
  if (filters.subject) conditions.push({ subject: filters.subject });

  if (filters.dateAfter) {
    const d = new Date(filters.dateAfter);
    if (!isNaN(d.getTime())) conditions.push({ after: d.toISOString() });
  }
  if (filters.dateBefore) {
    const d = new Date(filters.dateBefore);
    if (!isNaN(d.getTime())) {
      d.setHours(23, 59, 59, 999);
      conditions.push({ before: d.toISOString() });
    }
  }

  if (filters.hasAttachment === true) conditions.push({ hasAttachment: true });
  else if (filters.hasAttachment === false) conditions.push({ hasAttachment: false });

  if (filters.isUnread === true) conditions.push({ notKeyword: '$seen' });
  else if (filters.isUnread === false) conditions.push({ hasKeyword: '$seen' });

  if (filters.isStarred === true) conditions.push({ hasKeyword: '$flagged' });
  else if (filters.isStarred === false) conditions.push({ notKeyword: '$flagged' });

  if (conditions.length === 1) return conditions[0];
  return { operator: 'AND', conditions };
}

// True when the user has no search/filters active. Only in this case do we
// touch the per-mailbox snapshot cache or use Email/queryChanges — once a
// filter is in play, the queryState belongs to a different query and the
// cached list no longer represents what's on screen.
function isBaseView(searchQuery: string, filters: EmailFilters): boolean {
  return !searchQuery.trim() && Object.keys(filters).length === 0;
}

// View fields to apply when returning from a search/filter to the base view:
// the cached base-view snapshot, shown immediately so the list doesn't keep
// displaying search results while the refresh is in flight (issue #10).
function restoredBaseView(state: EmailState): Partial<EmailState> {
  const snap = state.currentMailboxId
    ? state.mailboxSnapshots[state.currentMailboxId]
    : undefined;
  if (!snap) return {};
  return { emails: snap.emails, totalEmails: snap.total, queryState: snap.queryState };
}

function snapshotFromActive(state: EmailState): AccountSnapshot {
  // Persist the currently-visible mailbox into its snapshot before tucking
  // the whole account away.
  let mailboxSnapshots = state.mailboxSnapshots;
  if (state.currentMailboxId && isBaseView(state.searchQuery, state.filters)) {
    mailboxSnapshots = {
      ...mailboxSnapshots,
      [state.currentMailboxId]: {
        emails: state.emails,
        total: state.totalEmails,
        queryState: state.queryState,
      },
    };
  }
  return {
    mailboxes: state.mailboxes,
    mailboxState: state.mailboxState,
    emailStates: state.emailStates,
    currentMailboxId: state.currentMailboxId,
    mailboxSnapshots,
  };
}

function viewFromSnapshot(snap: AccountSnapshot | null): {
  mailboxes: Mailbox[];
  mailboxState?: string;
  emailStates: Record<string, string>;
  currentMailboxId: string | null;
  mailboxSnapshots: Record<string, MailboxSnapshot>;
  emails: Email[];
  totalEmails: number;
  queryState?: string;
} {
  if (!snap) {
    return {
      mailboxes: [],
      mailboxState: undefined,
      emailStates: {},
      currentMailboxId: null,
      mailboxSnapshots: {},
      emails: [],
      totalEmails: 0,
      queryState: undefined,
    };
  }
  const mailboxSnap = snap.currentMailboxId
    ? snap.mailboxSnapshots[snap.currentMailboxId]
    : undefined;
  return {
    mailboxes: snap.mailboxes,
    mailboxState: snap.mailboxState,
    emailStates: snap.emailStates ?? {},
    currentMailboxId: snap.currentMailboxId,
    mailboxSnapshots: snap.mailboxSnapshots,
    emails: mailboxSnap?.emails ?? [],
    totalEmails: mailboxSnap?.total ?? 0,
    queryState: mailboxSnap?.queryState,
  };
}

// JMAP's maxObjectsInGet bounds how many ids we can pull in one Email/get.
// Chunk to that ceiling (with a small safety fallback) so large change sets
// don't trip 429/413 responses.
async function fetchEmailsChunked(ids: string[], accountId?: string): Promise<Email[]> {
  if (ids.length === 0) return [];
  const cap = Math.max(1, jmapClient.getMaxObjectsInGet());
  const chunk = Math.min(cap, 200);
  if (ids.length <= chunk) return fetchEmails(ids, accountId);
  const out: Email[] = [];
  for (let i = 0; i < ids.length; i += chunk) {
    const slice = await fetchEmails(ids.slice(i, i + chunk), accountId);
    out.push(...slice);
  }
  return out;
}

// Merge a fresh batch of emails into an existing list keyed by id. New entries
// replace stale ones (keywords/mailboxIds may have changed); destroyed ids are
// dropped. Order is preserved according to the supplied id order — pass the
// authoritative id list from Email/query when re-syncing.
function applyEmailDiff(
  current: Email[],
  orderedIds: string[],
  fetched: Email[],
  destroyed: Set<string>,
): Email[] {
  const byId = new Map<string, Email>();
  for (const e of current) byId.set(e.id, e);
  for (const e of fetched) byId.set(e.id, e);
  const out: Email[] = [];
  for (const id of orderedIds) {
    if (destroyed.has(id)) continue;
    const e = byId.get(id);
    if (e) out.push(e);
  }
  return out;
}

export const useEmailStore = create<EmailState>()(
  persist(
    (set, get) => ({
  accountSnapshots: {},
  activeAccountId: null,

  mailboxes: [],
  mailboxState: undefined,
  emailStates: {},
  currentMailboxId: null,
  mailboxSnapshots: {},
  emails: [],
  totalEmails: 0,
  queryState: undefined,

  loading: false,
  error: null,
  searchQuery: '',
  filters: {},
  pendingUndo: null,

  // Swap which account's data is currently visible. The previous account's
  // view is tucked into accountSnapshots so a return-trip can restore it
  // without a network call; the new account's view is pulled from its
  // snapshot (or empty defaults if we've never seen it). Callers (auth-store)
  // run the network refresh afterwards.
  setActiveAccount: (accountId) => {
    const state = get();
    if (state.activeAccountId === accountId) return;

    const nextSnapshots = { ...state.accountSnapshots };
    if (state.activeAccountId) {
      nextSnapshots[state.activeAccountId] = snapshotFromActive(state);
    }
    const incoming = accountId ? nextSnapshots[accountId] ?? null : null;
    const view = viewFromSnapshot(incoming);

    set({
      accountSnapshots: nextSnapshots,
      activeAccountId: accountId,
      ...view,
      // UI state is reset on switch — search/filters and pending undo belong
      // to the previous account's intent.
      searchQuery: '',
      filters: {},
      pendingUndo: null,
      error: null,
      loading: false,
    });

    // Point the offline body cache at the same account so getEmailDetail's
    // fallback and selectMailbox's seed read from the right bucket. Fire-
    // and-forget — the cache returns empty until hydration completes,
    // which is the correct degraded behaviour.
    void useOfflineCacheStore.getState().setAccount(accountId);
    // Load the new account's outbox and try to drain it (no-op when offline or
    // the JMAP client isn't serving this account yet).
    void useOutboxStore.getState().setAccount(accountId).then(() => {
      void useOutboxStore.getState().flush();
    });
  },

  removeAccount: (accountId) => {
    const state = get();
    const { [accountId]: _drop, ...rest } = state.accountSnapshots;
    if (state.activeAccountId === accountId) {
      set({
        accountSnapshots: rest,
        activeAccountId: null,
        mailboxes: [],
        mailboxState: undefined,
        emailStates: {},
        currentMailboxId: null,
        mailboxSnapshots: {},
        emails: [],
        totalEmails: 0,
        queryState: undefined,
        searchQuery: '',
        filters: {},
        pendingUndo: null,
      });
      void useOfflineCacheStore.getState().setAccount(null);
      void useOutboxStore.getState().setAccount(null);
    } else {
      set({ accountSnapshots: rest });
    }
  },

  clearAllAccounts: () => {
    set({
      accountSnapshots: {},
      activeAccountId: null,
      mailboxes: [],
      mailboxState: undefined,
      emailStates: {},
      currentMailboxId: null,
      mailboxSnapshots: {},
      emails: [],
      totalEmails: 0,
      queryState: undefined,
      searchQuery: '',
      filters: {},
      pendingUndo: null,
      error: null,
      loading: false,
    });
    void useOfflineCacheStore.getState().setAccount(null);
    void useOutboxStore.getState().setAccount(null);
  },

  fetchMailboxes: async () => {
    // Skip silently when there's no live session, or when jmapClient is
    // mid-transition to a different account (see jmapClientServesActiveAccount).
    // Screens fire this from mount-time useEffects, and on cold start
    // App.tsx renders MainTabs before restoreSession() finishes; without
    // this guard the underlying API call would either throw "Not
    // authenticated - call connect() first" or — worse, during an account
    // switch — return the *previous* account's mailboxes and stamp them
    // into the new account's snapshot.
    const activeAccountId = get().activeAccountId;
    if (!jmapClientServesActiveAccount(activeAccountId)) return;

    const prevState = get().mailboxState;
    // Swap in a freshly-synced set of own folders while leaving the shared
    // (group account) ones alone, and vice versa — the two are fetched by
    // separate calls and must not clobber each other.
    const replaceOwn = (own: Mailbox[], mailboxState?: string) => {
      set({
        mailboxes: [...own, ...get().mailboxes.filter((m) => m.isShared)],
        ...(mailboxState !== undefined ? { mailboxState } : {}),
      });
    };

    try {
      let drainAgain = false;

      // Incremental path: ask for just what changed since last time. Fall
      // through to a full refetch when the server can't compute the diff or
      // we have no previous state to compare against.
      let syncedOwn = false;
      if (prevState) {
        const changes = await getMailboxChanges(prevState);
        // Bail if the user switched accounts during the await — anything we
        // set() now would land in the wrong account's bucket.
        if (get().activeAccountId !== activeAccountId) return;
        if (changes) {
          syncedOwn = true;
          // No changes at all — keep the cached list, just bump the state.
          if (
            changes.created.length === 0 &&
            changes.updated.length === 0 &&
            changes.destroyed.length === 0
          ) {
            set({ mailboxState: changes.newState });
          } else {
            const toFetch = [...changes.created, ...changes.updated];
            const fetched = toFetch.length > 0
              ? (await getMailboxesByIds(toFetch)).list
              : [];
            if (get().activeAccountId !== activeAccountId) return;
            const destroyed = new Set(changes.destroyed);
            const byId = new Map<string, Mailbox>();
            for (const m of get().mailboxes) {
              if (!m.isShared) byId.set(m.id, m);
            }
            for (const m of fetched) byId.set(m.id, m);
            for (const id of destroyed) byId.delete(id);
            replaceOwn(
              Array.from(byId.values()),
              changes.hasMoreChanges ? prevState : changes.newState,
            );
            // hasMoreChanges = there are still pending changes past the
            // server's response cap. Run the same path again to drain.
            drainAgain = changes.hasMoreChanges;
          }
        }
        // changes === null → cannotCalculateChanges. Fall through to full.
      }

      if (!syncedOwn) {
        const { list, state } = await getMailboxesWithState();
        if (get().activeAccountId !== activeAccountId) return;
        replaceOwn(list, state);
      }

      // Shared/group accounts have their own Mailbox state tokens, and there
      // are only ever a handful of them, so they're re-read in full rather
      // than diffed. Failing to reach one must not lose the own folders we
      // just synced, hence the separate try.
      try {
        const shared = await getSharedMailboxes();
        if (get().activeAccountId !== activeAccountId) return;
        set({ mailboxes: [...get().mailboxes.filter((m) => !m.isShared), ...shared] });
      } catch (err) {
        console.warn('[email-store] shared mailbox fetch failed:', err);
      }

      if (drainAgain) void get().fetchMailboxes();
    } catch (err) {
      console.warn('[email-store] fetchMailboxes failed:', err);
      if (get().activeAccountId !== activeAccountId) return;
      // Don't overwrite the cached list on a transient failure — the user
      // can still navigate folders. Only surface the error when we have no
      // mailboxes at all to show.
      if (get().mailboxes.length === 0) {
        set({ error: err instanceof Error ? err.message : 'Failed to load mailboxes' });
      }
    }
  },

  selectMailbox: async (mailboxId) => {
    const state = get();
    // Tuck the previously-visible mailbox into its snapshot so a return-trip
    // can restore it without a network call. Only do this for the base view —
    // a filter or search makes the visible list unrepresentative of the
    // cached "no-filter" snapshot.
    let mailboxSnapshots = state.mailboxSnapshots;
    if (
      state.currentMailboxId &&
      state.currentMailboxId !== mailboxId &&
      isBaseView(state.searchQuery, state.filters)
    ) {
      mailboxSnapshots = {
        ...mailboxSnapshots,
        [state.currentMailboxId]: {
          emails: state.emails,
          total: state.totalEmails,
          queryState: state.queryState,
        },
      };
    }

    const incoming = mailboxSnapshots[mailboxId];
    // Swap to the new mailbox's cached view immediately. If there's no
    // snapshot, fall through to the offline cache as a second-best seed;
    // if that's also empty we render the empty-state, not a spinner over
    // a blank list — better than the previous flash to "Loading…".
    let seededEmails: Email[] = incoming?.emails ?? [];
    let seededTotal = incoming?.total ?? 0;
    let seededQueryState = incoming?.queryState;

    if (seededEmails.length === 0) {
      const cacheStore = useOfflineCacheStore.getState();
      if (!cacheStore.hydrated) await cacheStore.hydrate();
      if (cacheStore.totalCount() > 0) {
        try {
          const limit = useSettingsStore.getState().emailsPerPage;
          // Cached messages carry raw JMAP mailboxIds, so look up by the
          // unprefixed id rather than the sidebar's shared-folder key.
          seededEmails = await cacheStore.getEmailsInMailbox(
            rawMailboxId(state.mailboxes, mailboxId),
            Math.max(limit, 50),
          );
          seededTotal = seededEmails.length;
        } catch (err) {
          console.warn('[email-store] cache seed failed:', err);
        }
      }
    }

    set({
      currentMailboxId: mailboxId,
      emails: seededEmails,
      totalEmails: seededTotal,
      queryState: seededQueryState,
      mailboxSnapshots,
      loading: true,
      error: null,
      searchQuery: '',
      filters: {},
      pendingUndo: null,
    });

    // Stop here if there's no live session OR jmapClient is mid-transition
    // to a different account. The cached seed already gave the user
    // something to look at, and the refetch driven by restoreSession() /
    // switchAccount will run the network half once the client catches up.
    if (!jmapClientServesActiveAccount(get().activeAccountId)) {
      set({ loading: false });
      return;
    }

    await get().refreshEmails();
  },

  loadMoreEmails: async () => {
    const { currentMailboxId, emails, totalEmails, loading, searchQuery, filters, activeAccountId } = get();
    if (!currentMailboxId || loading || emails.length >= totalEmails) return;
    if (!jmapClientServesActiveAccount(activeAccountId)) return;

    set({ loading: true });
    try {
      const ref = refFor(get().mailboxes, currentMailboxId);
      const filter = buildJmapFilter(ref.id, searchQuery, filters);
      const limit = useSettingsStore.getState().emailsPerPage;
      const { ids } = await queryEmails(ref.id, {
        position: emails.length,
        limit,
        filter,
        accountId: ref.accountId,
      });
      if (get().activeAccountId !== activeAccountId || get().currentMailboxId !== currentMailboxId) return;
      const newEmails = ids.length > 0 ? await fetchEmailsChunked(ids, ref.accountId) : [];
      if (get().activeAccountId !== activeAccountId || get().currentMailboxId !== currentMailboxId) return;
      const merged = [...emails, ...newEmails];
      const updates: Partial<EmailState> = { emails: merged, loading: false };
      if (isBaseView(searchQuery, filters)) {
        updates.mailboxSnapshots = {
          ...get().mailboxSnapshots,
          [currentMailboxId]: {
            emails: merged,
            total: get().totalEmails,
            queryState: get().queryState,
          },
        };
      }
      set(updates);
    } catch (err) {
      if (get().activeAccountId !== activeAccountId) return;
      set({ loading: false, error: err instanceof Error ? err.message : 'Failed to load more' });
    }
  },

  importEmails: async (files, mailboxId) => {
    // Loaded lazily so the store module stays free of expo-file-system at
    // import time (that native dep can't load in the test/SSR environment).
    const { uploadBytes } = await import('../api/blob');
    const { expandImportableEml } = await import('../lib/eml-import');
    // Both the blob upload and the import have to target the folder's owning
    // account, or the import references a blob the server can't see.
    const ref = refFor(get().mailboxes, mailboxId);
    let imported = 0;
    let failed = 0;
    for (const file of files) {
      try {
        // A .eml expands to one message; a .zip to one per .eml it contains.
        const emls = await expandImportableEml(file.uri, file.name, file.mimeType);
        if (emls.length === 0) failed += 1;
        for (const eml of emls) {
          try {
            const { blobId } = await uploadBytes(eml.bytes, 'message/rfc822', ref.accountId);
            await importEmailBlob(blobId, ref.id, undefined, ref.accountId);
            imported += 1;
          } catch {
            failed += 1;
          }
        }
      } catch {
        failed += 1;
      }
    }
    // Surface freshly imported messages if we imported into the open mailbox.
    if (imported > 0 && get().currentMailboxId === mailboxId) {
      await get().refreshEmails();
    }
    return { imported, failed };
  },

  refreshEmails: async () => {
    const state = get();
    const { currentMailboxId, searchQuery, filters, emails: existing, activeAccountId } = state;
    if (!currentMailboxId) return;
    if (!jmapClientServesActiveAccount(activeAccountId)) return;
    set({ loading: true, error: null });

    // A shared (group account) folder is queried against its owning account
    // with its unprefixed id; own folders resolve to no override at all.
    const ref = refFor(state.mailboxes, currentMailboxId);
    const emailState = state.emailStates[stateKey(ref.accountId)];
    const filter = buildJmapFilter(ref.id, searchQuery, filters);
    const limit = useSettingsStore.getState().emailsPerPage;
    const baseView = isBaseView(searchQuery, filters);

    // A response that lands after the user switched account/mailbox or
    // changed search/filters must not overwrite the newer view.
    const viewChanged = () =>
      get().activeAccountId !== activeAccountId ||
      get().currentMailboxId !== currentMailboxId ||
      get().searchQuery !== searchQuery ||
      get().filters !== filters;

    // The incremental path diffs against the *base-view* list, which lives in
    // the per-mailbox snapshot — NOT `emails`, which may still hold search or
    // filter results (right after clearing a search, or after a cold start
    // that rehydrated a persisted search-result list). Diffing against a
    // non-base list lets Email/queryChanges "confirm" the search results as
    // the whole mailbox and bakes them into the snapshot (issue #10). The
    // snapshot is only trusted when its window is plausibly complete —
    // anything shorter can't be patched incrementally and needs the full
    // re-query below to rebuild it.
    const snap = state.mailboxSnapshots[currentMailboxId];

    try {
      // Incremental sync path: requires the base unfiltered view AND a known
      // queryState (so Email/queryChanges has something to diff against).
      // Anything else — search, filter active, first-ever load — falls
      // through to a full re-query.
      if (
        baseView &&
        snap?.queryState &&
        snap.emails.length >= Math.min(limit, snap.total)
      ) {
        const baseEmails = snap.emails;
        const queryChanges = await getEmailQueryChanges(ref.id, snap.queryState, {
          filter: undefined,
          accountId: ref.accountId,
        });
        if (queryChanges) {
          // What's in the visible window now: drop removed ids, then apply
          // added (id, index) entries. Newly added ids need bodies fetched.
          const removed = new Set(queryChanges.removed);
          const addedIds = queryChanges.added.map((a) => a.id);

          // Email/changes catches updates to messages already in our list
          // (e.g. another device toggled $seen) that queryChanges wouldn't
          // report. Skipped when we have no emailState yet — first refresh
          // after a cold start primes it from the Email/get below.
          let updatedIds: string[] = [];
          let destroyedExtra: string[] = [];
          let nextEmailState: string | undefined = emailState;
          let emailChangesInvalid = false;
          if (emailState) {
            const ec = await getEmailChanges(emailState, undefined, ref.accountId);
            if (ec) {
              updatedIds = ec.updated;
              destroyedExtra = ec.destroyed;
              nextEmailState = ec.newState;
            } else {
              // cannotCalculateChanges (RFC 8620 §5.2): the cursor can no
              // longer be advanced incrementally. Per cursor provenance, only
              // a genuine Email/changes `newState` may ever become the next
              // cursor — an Email/get `state` token means something
              // different and must never be adopted as a substitute (D4).
              // Forget the cursor and fall through to the full re-query
              // below, which performs the mandated resync and reestablishes
              // a cursor from a fresh Email/get bootstrap.
              emailChangesInvalid = true;
            }
          }

          if (!emailChangesInvalid) {
            // Fetch only what we don't already have. `addedIds` are new to the
            // window; `updatedIds` may already be in the base list but their
            // keywords/mailboxIds need refreshing.
            const existingById = new Map(baseEmails.map((e) => [e.id, e]));
            const idsToFetch = [
              ...addedIds.filter((id) => !existingById.has(id)),
              ...updatedIds.filter((id) => existingById.has(id)),
            ];
            let fetchState: string | undefined;
            let fetched: Email[] = [];
            if (idsToFetch.length > 0) {
              const res = await getEmailsWithState(idsToFetch, ref.accountId);
              fetched = res.list;
              fetchState = res.state;
            }

            // Rebuild the visible window order: start with existing emails,
            // drop removed/destroyed, then splice added at their indices.
            const allDestroyed = new Set([...destroyedExtra, ...removed]);
            const kept = baseEmails.filter((e) => !allDestroyed.has(e.id));
            // Map updated entries onto kept array
            const fetchedById = new Map(fetched.map((e) => [e.id, e]));
            const updatedKept = kept.map((e) => fetchedById.get(e.id) ?? e);

            // Insert added entries at the indices the server gave us. Sort
            // ascending by index so each splice lands at the right offset.
            const sortedAdded = [...queryChanges.added].sort((a, b) => a.index - b.index);
            const out = [...updatedKept];
            for (const entry of sortedAdded) {
              const email = fetchedById.get(entry.id);
              if (!email) continue;
              const idx = Math.min(entry.index, out.length);
              out.splice(idx, 0, email);
            }
            // Cap the visible list to the user's page size — Email/queryChanges
            // can push entries past the original window if many were added.
            const trimmed = out.slice(0, Math.max(limit, out.length));

            const nextQueryState = queryChanges.newQueryState;
            const nextTotal = queryChanges.total;

            if (viewChanged()) return;

            set({
              emails: trimmed,
              totalEmails: nextTotal,
              queryState: nextQueryState,
              emailStates: withEmailState(
                get().emailStates,
                ref.accountId,
                // `nextEmailState` is only ever a genuine Email/changes
                // newState here; `fetchState` only fills in as a bootstrap
                // token when there was no prior cursor at all (`emailState`
                // falsy), never as a substitute for an invalidated one.
                nextEmailState ?? fetchState ?? emailState,
              ),
              loading: false,
              mailboxSnapshots: {
                ...get().mailboxSnapshots,
                [currentMailboxId]: {
                  emails: trimmed,
                  total: nextTotal,
                  queryState: nextQueryState,
                },
              },
            });
            return;
          }
          // emailChangesInvalid → fall through to the full re-query below.
        }
        // queryChanges === null → cannotCalculateChanges. Drop our queryState
        // and fall through to a full re-query, which will repopulate it.
      }

      // Full re-query path. Used when there's no prior queryState, when the
      // user has search/filters active (queryState only tracks the base
      // query), or when the server returned cannotCalculateChanges above.
      const queryRes = await queryEmails(ref.id, { limit, filter, accountId: ref.accountId });
      const fetched = queryRes.ids.length > 0
        ? await getEmailsWithState(queryRes.ids, ref.accountId)
        : { list: [], state: undefined as string | undefined };

      if (viewChanged()) return;

      const updates: Partial<EmailState> = {
        emails: fetched.list,
        totalEmails: queryRes.total,
        loading: false,
      };
      if (baseView) {
        updates.queryState = queryRes.queryState;
        updates.emailStates = withEmailState(get().emailStates, ref.accountId, fetched.state);
        updates.mailboxSnapshots = {
          ...get().mailboxSnapshots,
          [currentMailboxId]: {
            emails: fetched.list,
            total: queryRes.total,
            queryState: queryRes.queryState,
          },
        };
      }
      set(updates);
    } catch (err) {
      console.warn('[email-store] refreshEmails failed:', err);
      if (get().activeAccountId !== activeAccountId || get().currentMailboxId !== currentMailboxId) return;
      // Keep whatever's visible; only surface the error when the list is
      // empty. With cached emails on screen the OfflineBanner already
      // tells the user the data is stale.
      if (existing.length === 0) {
        try {
          const cacheStore = useOfflineCacheStore.getState();
          if (!cacheStore.hydrated) await cacheStore.hydrate();
          if (cacheStore.totalCount() > 0) {
            const cached = await cacheStore.getEmailsInMailbox(
              ref.id,
              Math.max(limit, 50),
            );
            if (
              get().activeAccountId === activeAccountId &&
              get().currentMailboxId === currentMailboxId &&
              cached.length > 0
            ) {
              set({ emails: cached, totalEmails: cached.length, loading: false, error: null });
              return;
            }
          }
        } catch (cacheErr) {
          console.warn('[email-store] refresh cache fallback failed:', cacheErr);
        }
      }
      set({
        loading: false,
        error: existing.length > 0 ? null : (err instanceof Error ? err.message : 'Failed to load emails'),
      });
    }
  },

  handleStateChange: async (change) => {
    if (!jmapClient.currentSession) return;
    // Drop changes that arrived for a different account than the one we're
    // currently showing (e.g. push notifications received during/just after
    // an account switch).
    if (!jmapClientServesActiveAccount(get().activeAccountId)) return;
    // Push/EventSource state changes cover every account in the session, so a
    // shared (group account) mailbox reports under its own account id. Fold
    // them all in: any account's Mailbox change refreshes the folder list, but
    // only the account behind the open folder needs its message list re-read.
    const primaryId = jmapClient.accountId;
    const state = get();
    const currentAccountId =
      state.currentMailboxId
        ? refFor(state.mailboxes, state.currentMailboxId).accountId ?? primaryId
        : primaryId;
    const known = new Set([primaryId, ...jmapClient.getSharedMailAccounts().map((a) => a.id)]);

    let mailboxChanged = false;
    let emailChanged = false;
    for (const [accountId, accountChanges] of Object.entries(change.changed ?? {})) {
      if (!known.has(accountId) || !accountChanges) continue;
      if ('Mailbox' in accountChanges) mailboxChanged = true;
      if (accountId !== currentAccountId) continue;
      if ('Email' in accountChanges || 'EmailDelivery' in accountChanges) emailChanged = true;
    }
    if (!mailboxChanged && !emailChanged) return;

    if (mailboxChanged) {
      await get().fetchMailboxes();
    }
    if (emailChanged && get().currentMailboxId) {
      await get().refreshEmails();
    }
  },

  setSearchQuery: (query) => {
    const state = get();
    const backToBase =
      !isBaseView(state.searchQuery, state.filters) && isBaseView(query, state.filters);
    set({
      searchQuery: query,
      ...(backToBase ? restoredBaseView(state) : {}),
    });
    void get().refreshEmails();
  },

  setFilters: (filters) => {
    const state = get();
    const backToBase =
      !isBaseView(state.searchQuery, state.filters) && isBaseView(state.searchQuery, filters);
    set({
      filters,
      ...(backToBase ? restoredBaseView(state) : {}),
    });
    void get().refreshEmails();
  },

  clearSearchAndFilters: () => {
    const state = get();
    if (!state.searchQuery && Object.keys(state.filters).length === 0) return;
    set({ searchQuery: '', filters: {}, ...restoredBaseView(state) });
    void get().refreshEmails();
  },

  getEmailDetail: async (id, accountId) => {
    // Try the network first so the user sees fresh keywords/flags. If that
    // fails (offline / server unreachable), fall back to the offline cache
    // when the message is in it. Without the cache hit, propagate the error
    // so the caller can surface it. `accountId` targets a group/shared inbox
    // message opened from the unified view.
    try {
      const fresh = await getFullEmail(id, accountId);
      // Opportunistically refresh the cached copy so the next offline open
      // reflects the latest keywords without needing a full sync.
      const cache = useOfflineCacheStore.getState();
      if (cache.has(id)) {
        try {
          const size = JSON.stringify(fresh).length;
          await cache.put(fresh, size);
        } catch { /* ignore — best-effort refresh */ }
      }
      return fresh;
    } catch (err) {
      const cached = await useOfflineCacheStore.getState().get(id);
      if (cached) return cached;
      throw err;
    }
  },

  markRead: async (emailId, accountId) => {
    const state = get();
    const email = state.emails.find((e) => e.id === emailId);
    const nextKeywords = { ...(email?.keywords ?? {}), $seen: true };
    // A group/shared message opened from the unified inbox lives under another
    // JMAP account and isn't in the active list/cache or the (account-scoped)
    // offline queue — mark it read directly against its owning account.
    if (accountId && !email) {
      await setEmailKeywords(emailId, nextKeywords, accountId);
      return;
    }
    const owner = accountId ?? currentAccountId(state);
    await applyOrQueue({ kind: 'keywords', emailId, accountId: owner, keywords: nextKeywords });
    set({
      emails: get().emails.map((e) =>
        e.id === emailId ? { ...e, keywords: nextKeywords } : e,
      ),
    });
    patchCache(emailId, { keywords: nextKeywords });
  },

  markUnread: async (emailId) => {
    const state = get();
    const email = state.emails.find((e) => e.id === emailId);
    if (!email) return;
    const { $seen, ...rest } = email.keywords;
    await applyOrQueue({
      kind: 'keywords',
      emailId,
      accountId: currentAccountId(state),
      keywords: rest,
    });
    set({
      emails: get().emails.map((e) =>
        e.id === emailId ? { ...e, keywords: rest } : e,
      ),
    });
    patchCache(emailId, { keywords: rest });
  },

  toggleStar: async (emailId, starred) => {
    const state = get();
    const email = state.emails.find((e) => e.id === emailId);
    if (!email) return;
    const keywords = { ...email.keywords };
    if (starred) {
      keywords.$flagged = true;
    } else {
      delete keywords.$flagged;
    }
    await applyOrQueue({
      kind: 'keywords',
      emailId,
      accountId: currentAccountId(state),
      keywords,
    });
    set({
      emails: get().emails.map((e) =>
        e.id === emailId ? { ...e, keywords } : e,
      ),
    });
    patchCache(emailId, { keywords });
  },

  togglePin: async (emailId, pinned) => {
    const state = get();
    const email = state.emails.find((e) => e.id === emailId);
    if (!email) return;
    const keywords = { ...email.keywords };
    if (pinned) {
      keywords.$important = true;
    } else {
      delete keywords.$important;
    }
    await applyOrQueue({
      kind: 'keywords',
      emailId,
      accountId: currentAccountId(state),
      keywords,
    });
    set({
      emails: get().emails.map((e) =>
        e.id === emailId ? { ...e, keywords } : e,
      ),
    });
    patchCache(emailId, { keywords });
  },

  moveToMailbox: async (emailId, fromMailboxId, toMailboxId) => {
    const state = get();
    const email = state.emails.find((e) => e.id === emailId);
    const from = refFor(state.mailboxes, fromMailboxId);
    const to = refFor(state.mailboxes, toMailboxId);
    // A single Email/set is scoped to one account, so there's no move between
    // the user's own folders and a shared account's (or between two shared
    // accounts) — that would be a copy-then-delete across accounts.
    if (from.accountId !== to.accountId) {
      set({ error: 'Messages can only be moved within the same account' });
      return;
    }
    const original = email ? { ...email.mailboxIds } : null;
    const target = mailboxesAfterMove(email?.mailboxIds, from.id, to.id);

    await applyOrQueue(
      { kind: 'mailboxes', emailId, accountId: from.accountId, mailboxIds: target },
      () => moveEmail(emailId, from.id, to.id, from.accountId),
    );
    set({ emails: get().emails.filter((e) => e.id !== emailId) });
    patchCache(emailId, { mailboxIds: target });

    if (email && original) {
      const targetName = get().mailboxes.find((m) => m.id === toMailboxId)?.name;
      set({
        pendingUndo: {
          kind: 'move',
          label: targetName ? `Email moved to ${targetName}` : 'Email moved',
          createdAt: Date.now(),
          accountId: from.accountId,
          items: [{ email, originalMailboxIds: original }],
        },
      });
    }
  },

  archiveEmail: async (emailId) => {
    const state = get();
    const email = state.emails.find((e) => e.id === emailId);
    if (!email) return;

    // Archive into the *same account's* Archive folder — a shared mailbox's
    // messages can't be filed into the user's own.
    const scoped = mailboxesForSiblingOf(state.mailboxes, state.currentMailboxId);
    const archiveMailbox = scoped.find(
      (m) => m.role === 'archive' || m.name.toLowerCase() === 'archive',
    );
    if (!archiveMailbox) return;
    const archive = refFor(state.mailboxes, archiveMailbox.id);
    if (email.mailboxIds?.[archive.id]) return;

    const mode = useSettingsStore.getState().archiveMode;
    const original = { ...email.mailboxIds };

    // Online keeps the rich year/month auto-foldering. Offline degrades to the
    // archive root (we can't create folders without a connection); the queued
    // op replays as a plain move into Archive.
    const { queued } = await applyOrQueue(
      {
        kind: 'mailboxes',
        emailId,
        accountId: archive.accountId,
        mailboxIds: { [archive.id]: true },
      },
      () => apiArchiveEmails(
        [{ id: email.id, receivedAt: email.receivedAt }],
        archive.id,
        mode,
        toRawMailboxes(scoped),
        archive.accountId,
      ),
    );

    set({
      emails: get().emails.filter((e) => e.id !== emailId),
      pendingUndo: {
        kind: 'archive',
        label: 'Email archived',
        createdAt: Date.now(),
        accountId: archive.accountId,
        items: [{ email, originalMailboxIds: original }],
      },
    });
    patchCache(emailId, { mailboxIds: { [archive.id]: true } });

    // Auto-sort modes may have created new year/month folders - refresh the
    // mailbox list so the sidebar picks them up on the next render. Skip when
    // the action was only queued (no folders were created offline).
    if (mode !== 'single' && !queued) {
      void get().fetchMailboxes();
    }
  },

  deleteEmail: async (emailId, trashMailboxId, currentMailboxId) => {
    const state = get();
    const email = state.emails.find((e) => e.id === emailId);
    const original = email ? { ...email.mailboxIds } : null;
    const settings = useSettingsStore.getState();
    const trash = refFor(state.mailboxes, trashMailboxId);
    const source = refFor(state.mailboxes, currentMailboxId);
    const junkMailbox = mailboxesForSiblingOf(state.mailboxes, currentMailboxId)
      .find((m) => m.role === 'junk' || m.role === 'spam');
    const junkId = junkMailbox ? rawMailboxId(state.mailboxes, junkMailbox.id) : null;
    const inJunk = !!(junkId && email?.mailboxIds?.[junkId]);
    const inTrash = currentMailboxId === trashMailboxId;

    // Resolve effective destination:
    // - already in trash → must destroy (no further folder to move to)
    // - in junk and the user opted to skip the trash for junk → destroy
    // - the user set 'permanent' as the global default → destroy
    // - otherwise → move to trash and offer undo
    const destroy =
      inTrash ||
      settings.deleteAction === 'permanent' ||
      (settings.permanentlyDeleteJunk && inJunk);

    if (destroy) {
      // Use the trash mailbox as the "current" so apiDeleteEmail takes the
      // destroy branch even when the source folder isn't trash.
      await applyOrQueue(
        { kind: 'destroy', emailId, accountId: trash.accountId },
        () => apiDeleteEmail(emailId, trash.id, trash.id, trash.accountId),
      );
      dropFromCache([emailId]);
    } else {
      const target = mailboxesAfterMove(email?.mailboxIds, source.id, trash.id);
      await applyOrQueue(
        { kind: 'mailboxes', emailId, accountId: source.accountId, mailboxIds: target },
        () => apiDeleteEmail(emailId, trash.id, source.id, source.accountId),
      );
      // "Move to Trash and mark as read" (#323): when the user picked that
      // delete action, also clear unread state for messages moved to trash.
      if (settings.deleteAction === 'trash-and-read' && email && !email.keywords?.$seen) {
        const nextKeywords = { ...email.keywords, $seen: true };
        await applyOrQueue({
          kind: 'keywords',
          emailId,
          accountId: source.accountId,
          keywords: nextKeywords,
        });
        patchCache(emailId, { mailboxIds: target, keywords: nextKeywords });
      } else {
        patchCache(emailId, { mailboxIds: target });
      }
    }
    set({ emails: get().emails.filter((e) => e.id !== emailId) });

    // Permanent destroy can't be undone - skip the snackbar so we don't
    // promise an undo we can't deliver.
    if (email && original && !destroy) {
      set({
        pendingUndo: {
          kind: 'delete',
          label: 'Email moved to Trash',
          createdAt: Date.now(),
          accountId: source.accountId,
          items: [{ email, originalMailboxIds: original }],
        },
      });
    }
  },

  // ── Batch actions ─────────────────────────────────────────────
  // Each produces a single combined UndoEntry (UndoEntry.items is an array),
  // so a multi-select archive/move/delete is reversed with one snackbar tap.

  archiveEmailsBatch: async (emailIds) => {
    const state = get();
    const scoped = mailboxesForSiblingOf(state.mailboxes, state.currentMailboxId);
    const archiveMailbox = scoped.find(
      (m) => m.role === 'archive' || m.name.toLowerCase() === 'archive',
    );
    if (!archiveMailbox) return;
    const archive = refFor(state.mailboxes, archiveMailbox.id);
    const targets = state.emails.filter(
      (e) => emailIds.includes(e.id) && !e.mailboxIds?.[archive.id],
    );
    if (targets.length === 0) return;

    const mode = useSettingsStore.getState().archiveMode;
    const items = targets.map((e) => ({ email: e, originalMailboxIds: { ...e.mailboxIds } }));
    const archiveTarget = { [archive.id]: true };

    const { queued } = await applyOrQueueBatch(
      targets.map((e): OutboxOp => ({
        kind: 'mailboxes',
        emailId: e.id,
        accountId: archive.accountId,
        mailboxIds: archiveTarget,
      })),
      () => apiArchiveEmails(
        targets.map((e) => ({ id: e.id, receivedAt: e.receivedAt })),
        archive.id,
        mode,
        toRawMailboxes(scoped),
        archive.accountId,
      ),
    );

    const removed = new Set(targets.map((e) => e.id));
    set({
      emails: get().emails.filter((e) => !removed.has(e.id)),
      pendingUndo: {
        kind: 'archive',
        label: targets.length === 1 ? 'Email archived' : `${targets.length} emails archived`,
        createdAt: Date.now(),
        accountId: archive.accountId,
        items,
      },
    });
    for (const e of targets) patchCache(e.id, { mailboxIds: archiveTarget });

    if (mode !== 'single' && !queued) void get().fetchMailboxes();
  },

  moveEmailsToMailbox: async (emailIds, toMailboxId) => {
    const { emails, currentMailboxId, mailboxes } = get();
    if (!currentMailboxId || toMailboxId === currentMailboxId) return;
    const source = refFor(mailboxes, currentMailboxId);
    const to = refFor(mailboxes, toMailboxId);
    // See moveToMailbox: one Email/set can't span two accounts.
    if (source.accountId !== to.accountId) {
      set({ error: 'Messages can only be moved within the same account' });
      return;
    }
    const targets = emails.filter((e) => emailIds.includes(e.id));
    if (targets.length === 0) return;

    const items = targets.map((e) => ({ email: e, originalMailboxIds: { ...e.mailboxIds } }));

    await applyOrQueueBatch(
      targets.map((e): OutboxOp => ({
        kind: 'mailboxes',
        emailId: e.id,
        accountId: source.accountId,
        mailboxIds: mailboxesAfterMove(e.mailboxIds, source.id, to.id),
      })),
      () => apiMoveEmails(targets.map((e) => e.id), source.id, to.id, source.accountId),
    );

    const removed = new Set(targets.map((e) => e.id));
    for (const e of targets) {
      patchCache(e.id, { mailboxIds: mailboxesAfterMove(e.mailboxIds, source.id, to.id) });
    }
    const targetName = mailboxes.find((m) => m.id === toMailboxId)?.name;
    set({
      emails: get().emails.filter((e) => !removed.has(e.id)),
      pendingUndo: {
        kind: 'move',
        label: targetName
          ? `${targets.length === 1 ? 'Email' : `${targets.length} emails`} moved to ${targetName}`
          : 'Emails moved',
        createdAt: Date.now(),
        accountId: source.accountId,
        items,
      },
    });
  },

  deleteEmailsBatch: async (emailIds, trashMailboxId, currentMailboxId) => {
    const { emails, mailboxes } = get();
    const settings = useSettingsStore.getState();
    const trash = refFor(mailboxes, trashMailboxId);
    const source = refFor(mailboxes, currentMailboxId);
    const junkMailbox = mailboxesForSiblingOf(mailboxes, currentMailboxId)
      .find((m) => m.role === 'junk' || m.role === 'spam');
    const junkId = junkMailbox ? rawMailboxId(mailboxes, junkMailbox.id) : null;
    const inTrash = currentMailboxId === trashMailboxId;
    const targets = emails.filter((e) => emailIds.includes(e.id));
    if (targets.length === 0) return;

    // Split into permanent-destroy vs move-to-trash following the same policy
    // as the single delete: trash folder, global "permanent" default, or the
    // skip-trash-for-junk option each force a destroy.
    const toDestroy: Email[] = [];
    const toTrash: Email[] = [];
    for (const e of targets) {
      const inJunk = !!(junkId && e.mailboxIds?.[junkId]);
      const destroy =
        inTrash ||
        settings.deleteAction === 'permanent' ||
        (settings.permanentlyDeleteJunk && inJunk);
      (destroy ? toDestroy : toTrash).push(e);
    }

    // "Move to Trash and mark as read" (#323): also clear unread state for the
    // moved-to-trash messages when that delete action is selected.
    const toMarkRead =
      settings.deleteAction === 'trash-and-read'
        ? toTrash.filter((e) => !e.keywords?.$seen)
        : [];
    const markReadKeywords = new Map(
      toMarkRead.map((e) => [e.id, { ...e.keywords, $seen: true }]),
    );

    const ops: OutboxOp[] = [
      ...toDestroy.map((e): OutboxOp => ({
        kind: 'destroy',
        emailId: e.id,
        accountId: trash.accountId,
      })),
      ...toTrash.map((e): OutboxOp => ({
        kind: 'mailboxes',
        emailId: e.id,
        accountId: source.accountId,
        mailboxIds: mailboxesAfterMove(e.mailboxIds, source.id, trash.id),
      })),
      ...toMarkRead.map((e): OutboxOp => ({
        kind: 'keywords',
        emailId: e.id,
        accountId: source.accountId,
        keywords: markReadKeywords.get(e.id)!,
      })),
    ];
    await applyOrQueueBatch(ops, async () => {
      if (toDestroy.length > 0) {
        await apiDeleteEmails(toDestroy.map((e) => e.id), trash.id, trash.id, trash.accountId);
      }
      if (toTrash.length > 0) {
        await apiMoveEmails(toTrash.map((e) => e.id), source.id, trash.id, source.accountId);
      }
      if (toMarkRead.length > 0) {
        await setKeywordsForEmails(
          toMarkRead.map((e) => ({ id: e.id, keywords: markReadKeywords.get(e.id)! })),
          source.accountId,
        );
      }
    });

    if (toDestroy.length > 0) dropFromCache(toDestroy.map((e) => e.id));
    for (const e of toTrash) {
      patchCache(e.id, {
        mailboxIds: mailboxesAfterMove(e.mailboxIds, source.id, trash.id),
        ...(markReadKeywords.has(e.id) ? { keywords: markReadKeywords.get(e.id) } : {}),
      });
    }

    const removed = new Set(targets.map((e) => e.id));
    set({ emails: get().emails.filter((e) => !removed.has(e.id)) });

    // Only the moved-to-trash items are recoverable; destroyed ones are gone.
    if (toTrash.length > 0) {
      set({
        pendingUndo: {
          kind: 'delete',
          label: toTrash.length === 1 ? 'Email moved to Trash' : `${toTrash.length} emails moved to Trash`,
          createdAt: Date.now(),
          accountId: source.accountId,
          items: toTrash.map((e) => ({ email: e, originalMailboxIds: { ...e.mailboxIds } })),
        },
      });
    }
  },

  setKeywordForEmails: async (emailIds, token, on) => {
    const state = get();
    const targets = state.emails.filter((e) => emailIds.includes(e.id));
    if (targets.length === 0) return;
    const owner = currentAccountId(state);
    const updates = targets.map((e) => {
      const keywords = { ...e.keywords };
      if (on) keywords[token] = true;
      else delete keywords[token];
      return { id: e.id, keywords };
    });
    await applyOrQueueBatch(
      updates.map((u): OutboxOp => ({
        kind: 'keywords',
        emailId: u.id,
        accountId: owner,
        keywords: u.keywords,
      })),
      () => setKeywordsForEmails(updates, owner),
    );
    const byId = new Map(updates.map((u) => [u.id, u.keywords]));
    set({
      emails: get().emails.map((e) =>
        byId.has(e.id) ? { ...e, keywords: byId.get(e.id)! } : e,
      ),
    });
    for (const u of updates) patchCache(u.id, { keywords: u.keywords });
  },

  undoLast: async () => {
    const entry = get().pendingUndo;
    if (!entry) return;
    set({ pendingUndo: null });

    try {
      await applyOrQueueBatch(
        entry.items.map((it): OutboxOp => ({
          kind: 'mailboxes',
          emailId: it.email.id,
          accountId: entry.accountId,
          mailboxIds: it.originalMailboxIds,
        })),
        () => restoreEmailMailboxes(
          entry.items.map((it) => ({ id: it.email.id, mailboxIds: it.originalMailboxIds })),
          entry.accountId,
        ),
      );
      for (const it of entry.items) {
        patchCache(it.email.id, { mailboxIds: it.originalMailboxIds });
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Undo failed' });
      return;
    }

    // Re-insert each restored email into the visible list if its original
    // mailboxIds include the current view. Server is the source of truth for
    // ordering, but local re-insertion gives the user instant feedback.
    const { currentMailboxId, emails, mailboxes } = get();
    if (currentMailboxId) {
      const currentRawId = rawMailboxId(mailboxes, currentMailboxId);
      const restored = entry.items
        .filter((it) => it.originalMailboxIds[currentRawId])
        .map((it) => ({ ...it.email, mailboxIds: it.originalMailboxIds }));
      if (restored.length > 0) {
        const merged = [...restored, ...emails].sort(
          (a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime(),
        );
        set({ emails: merged });
      }
    }
  },

  clearUndo: () => set({ pendingUndo: null }),

  searchEmails: async (query) => {
    // Search the account whose folder is open, so a shared mailbox searches
    // its own messages rather than the user's.
    const owner = currentAccountId(get());
    const ids = await apiSearchEmails(query, undefined, 30, owner);
    if (ids.length === 0) return [];
    return fetchEmails(ids, owner);
  },

  reset: () => set({
    mailboxes: [],
    mailboxState: undefined,
    emailStates: {},
    currentMailboxId: null,
    mailboxSnapshots: {},
    emails: [],
    totalEmails: 0,
    queryState: undefined,
    loading: false,
    error: null,
    searchQuery: '',
    filters: {},
  }),
    }),
    {
      // Persist the per-account caches and the active view so the UI can
      // render instantly on re-open / account switch, before the JMAP
      // session has finished restoring. auth-store triggers a background
      // refresh once the session is ready.
      name: 'email-cache',
      storage: createJSONStorage(() => AsyncStorage),
      version: 2,
      // v0 → v1: drop every cached queryState. Pre-v1 builds could persist a
      // search-result list next to the base view's queryState, and the
      // incremental sync path would then "confirm" those search results as
      // the whole mailbox and bake them into the snapshot (issue #10).
      // Without a queryState the next refresh does a full re-query, which
      // rebuilds any poisoned window from the server.
      //
      // v1 → v2: the single `emailState` became `emailStates`, keyed per JMAP
      // account so shared (group account) folders track their own. The old
      // token is dropped; the next refresh re-primes it from Email/get.
      migrate: (persisted, version) => {
        const s = persisted as Pick<
          EmailState,
          'accountSnapshots' | 'mailboxSnapshots' | 'queryState'
        > & Record<string, unknown>;

        const dropEmailState = (input: Record<string, unknown>): Record<string, unknown> => {
          const { emailState: _drop, ...rest } = input;
          return { ...rest, emailStates: {} };
        };

        if (version >= 2) return persisted as EmailState;
        if (version >= 1) {
          const accountSnapshots: Record<string, AccountSnapshot> = {};
          for (const [id, acc] of Object.entries(s.accountSnapshots ?? {})) {
            accountSnapshots[id] = dropEmailState(
              acc as unknown as Record<string, unknown>,
            ) as unknown as AccountSnapshot;
          }
          return { ...dropEmailState(s), accountSnapshots } as unknown as EmailState;
        }

        const stripQueryStates = (
          snaps: Record<string, MailboxSnapshot> | undefined,
        ): Record<string, MailboxSnapshot> =>
          Object.fromEntries(
            Object.entries(snaps ?? {}).map(([id, snap]) => [
              id,
              { ...snap, queryState: undefined },
            ]),
          );
        const accountSnapshots: Record<string, AccountSnapshot> = {};
        for (const [id, acc] of Object.entries(s.accountSnapshots ?? {})) {
          accountSnapshots[id] = dropEmailState({
            ...acc,
            mailboxSnapshots: stripQueryStates(acc.mailboxSnapshots),
          }) as unknown as AccountSnapshot;
        }
        return {
          ...dropEmailState(s),
          accountSnapshots,
          mailboxSnapshots: stripQueryStates(s.mailboxSnapshots),
          queryState: undefined,
        } as unknown as EmailState;
      },
      partialize: (state) => ({
        accountSnapshots: state.accountSnapshots,
        activeAccountId: state.activeAccountId,
        mailboxes: state.mailboxes,
        mailboxState: state.mailboxState,
        emailStates: state.emailStates,
        currentMailboxId: state.currentMailboxId,
        mailboxSnapshots: state.mailboxSnapshots,
        emails: state.emails,
        totalEmails: state.totalEmails,
        queryState: state.queryState,
      }),
    },
  ),
);
