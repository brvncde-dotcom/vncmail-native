// Jobs A1 and A2: the `Mailbox/changes` / `Email/changes` drain (design §6.3).
//
// The one rule everything else hangs off is I1, CURSOR-LAST: a cursor is written
// only after every record mutation implied by its page is durable. A crash
// re-delivers a page (at-least-once), never skips one. Under SQLite this is a real
// transaction rather than a write-ordering convention, which is what §14.3's
// reordering bought.

import { AnchorNotFoundError } from '../api/email';
import {
  applyEmailPage,
  applyMailboxPage,
  type ChangesPage,
  planEmailFetches,
  planMailboxFetches,
} from './apply';
// `EmailChangesResult` / `MailboxChangesResult` are structurally `ChangesPage`
// (both carry branded ChangesState since §12.1), so no cast is needed to pass
// them through. If that ever stops being true, the compiler says so here rather
// than a cast hiding it.
import { escalateOnFailure, type MaxChangesRung, resetOnAdvance, rungValue } from './cursor';
import { classify, StateInvalidError } from './errors';
import type { JmapPort } from './jmap-port';
import type { PendingIndex } from './overlay';
import type { Email, Mailbox } from '../api/types';
import type { CursorKey, RowKey, SyncCursor, SyncStore, SyncTxn } from './store';
import type { CursorType, JmapAccountId } from './states';

export type DrainOutcome = 'ok' | 'partial' | 'failed' | 'state-invalid' | 'aborted';

export interface DrainResult {
  outcome: DrainOutcome;
  pagesApplied: number;
  madeProgress: boolean;
  /** Set when `outcome === 'state-invalid'`, so the caller can reconcile. */
  invalidReason?: 'cannotCalculateChanges' | 'oldStateMismatch';
  error?: string;
}

export interface DrainContext {
  store: SyncStore;
  port: JmapPort;
  jmapAccountId: JmapAccountId;
  /** ISO floor of the body window, or null to enqueue no bodies. */
  bodyFrom: string | null;
  pending?: PendingIndex;
  /** Remaining page budget for this cursor this cycle (§6.4). */
  pageBudget: number;
  /** Cooperative deadline, checked between pages (§6.4, §10.5). */
  deadlineAt: number;
  now(): number;
  /** Abort at the next page boundary: background, logout, T10, network loss (§10.3). */
  shouldAbort(): boolean;
  log?: (level: 'warn' | 'error' | 'info', message: string) => void;
}

function log(ctx: DrainContext, level: 'warn' | 'error' | 'info', message: string): void {
  ctx.log?.(level, message);
}

/**
 * Chunk to the batch size the session advertises. Bounding `maxChanges` keeps a
 * page's fetch inside one `Email/get` batch, so a page is a small, quickly
 * committable unit — which is what makes crash recovery cost one page instead of a
 * resync.
 */
function chunk<T>(items: readonly T[], size: number): T[][] {
  if (items.length === 0) return [];
  const bound = Math.max(1, size);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += bound) out.push(items.slice(i, i + bound));
  return out;
}

async function fetchAll<T>(
  ids: string[],
  size: number,
  fetch: (batch: string[]) => Promise<{ list: T[]; notFound: string[] }>,
): Promise<{ list: T[]; notFound: string[] }> {
  const list: T[] = [];
  const notFound: string[] = [];
  for (const batch of chunk(ids, size)) {
    const res = await fetch(batch);
    list.push(...res.list);
    notFound.push(...res.notFound);
  }
  return { list, notFound };
}

/**
 * §7.6.1 — confirm an `oldState` mismatch before escalating (S10's fix).
 *
 * RFC 8620 §5.2 has the server echo `sinceState` as `oldState`, so a mismatch means
 * the server is not answering the question we asked. Revision 1 escalated straight
 * to reconcile. But if a server ever echoes a semantically-equal, non-byte-identical
 * `oldState`, EVERY cycle would trip it, reconcile, seed a fresh cursor, and trip
 * again — unbounded full-window rescans, and `consecutiveFailures` never catches it
 * because each reconcile "succeeds" (F39).
 *
 * So: re-issue the same call once and compare again. A match is a logged transient
 * anomaly; only a confirmed mismatch escalates.
 */
async function confirmOldStateMismatch<T extends { oldState: string }>(
  ctx: DrainContext,
  reissue: () => Promise<T | null>,
  expected: string,
): Promise<{ confirmed: true } | { confirmed: false; page: T }> {
  const again = await reissue();
  if (again === null) {
    // The re-issue itself came back cannotCalculateChanges — that IS a state
    // invalidation, so treat the mismatch as confirmed.
    return { confirmed: true };
  }
  if (again.oldState !== expected) return { confirmed: true };
  log(
    ctx,
    'warn',
    `oldState mismatch on re-issue matched (${expected}); treating as a transient server anomaly, not an invalidation (F39)`,
  );
  return { confirmed: false, page: again };
}

// ─────────────────────────────────────────────────────────────────────────────
// Job A1 — Mailbox/changes
// ─────────────────────────────────────────────────────────────────────────────

export async function drainMailboxChanges(
  ctx: DrainContext,
  cursor: SyncCursor,
): Promise<DrainResult> {
  const key: CursorKey = { jmapAccountId: ctx.jmapAccountId, type: 'Mailbox' };
  return drain(ctx, cursor, key, {
    request: async (sinceState) => {
      const res = await ctx.port.mailboxChanges(sinceState, ctx.jmapAccountId);
      if (res === null) return null;
      return { page: res, updatedProperties: res.updatedProperties };
    },
    applyPage: async (txn, page, extra) => {
      const plan = planMailboxFetches(page, extra?.updatedProperties ?? null);
      const size = ctx.port.maxObjectsInGet();

      const full: Mailbox[] = [];
      for (const batch of chunk(plan.fullIds, size)) {
        full.push(...(await ctx.port.getMailboxesByIdsFull(batch, ctx.jmapAccountId)));
      }
      const counts: Mailbox[] = [];
      for (const batch of chunk(plan.countIds, size)) {
        counts.push(...(await ctx.port.getMailboxCounts(batch, ctx.jmapAccountId)));
      }

      const applied = applyMailboxPage({
        jmapAccountId: ctx.jmapAccountId,
        plan,
        full,
        counts,
      });

      if (applied.upsertMailboxes.length) await txn.upsertMailboxes(applied.upsertMailboxes);
      if (applied.patchCounts.length) await txn.patchMailboxCounts(applied.patchCounts);
      if (applied.deleteMailboxes.length) await txn.deleteMailboxes(applied.deleteMailboxes);

      return (
        applied.upsertMailboxes.length +
          applied.patchCounts.length +
          applied.deleteMailboxes.length >
        0
      );
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Job A2 — Email/changes
// ─────────────────────────────────────────────────────────────────────────────

export async function drainEmailChanges(
  ctx: DrainContext,
  cursor: SyncCursor,
): Promise<DrainResult> {
  const key: CursorKey = { jmapAccountId: ctx.jmapAccountId, type: 'Email' };
  return drain(ctx, cursor, key, {
    request: async (sinceState, rung) => {
      const maxChanges = rungValue(rung, ctx.port.maxObjectsInGet());
      const res = await ctx.port.emailChanges(sinceState, maxChanges, ctx.jmapAccountId);
      if (res === null) return null;
      return { page: res };
    },
    applyPage: async (txn, page) => {
      // §5.3: filter absent `updated` ids out BEFORE issuing the fetch. Cheaper,
      // and it avoids fabricating a `receivedAt` a 3-property response cannot
      // supply and the schema's NOT NULL would reject (F26).
      const updatedKeys: RowKey[] = page.updated.map((id) => ({
        jmapAccountId: ctx.jmapAccountId,
        id,
      }));
      const present = await ctx.store.whichEnvelopesExist(updatedKeys);
      const presentIds = new Set(present.map((k) => k.id));

      const plan = planEmailFetches(page, presentIds);
      const size = ctx.port.maxObjectsInGet();

      const created = await fetchAll<Email>(plan.createIds, Math.min(size, 200), (b) =>
        ctx.port.getEnvelopes(b, ctx.jmapAccountId),
      );
      const updated = await fetchAll<Email>(plan.updateIds, Math.min(size, 200), (b) =>
        ctx.port.getMutable(b, ctx.jmapAccountId),
      );

      const applied = applyEmailPage({
        jmapAccountId: ctx.jmapAccountId,
        plan,
        created: created.list,
        updated: updated.list,
        notFound: [...created.notFound, ...updated.notFound],
        bodyFrom: ctx.bodyFrom,
        pending: ctx.pending,
        now: ctx.now(),
      });

      if (applied.skippedNotFound.length) {
        // F11: an id in created/updated that `Email/get` omits was destroyed
        // between the two calls. Normal, not an error: skip it, no retry, do not
        // fail the page.
        log(
          ctx,
          'info',
          `Email/get omitted ${applied.skippedNotFound.length} id(s) destroyed mid-page; skipping (F11)`,
        );
      }

      if (applied.upsertEnvelopes.length) await txn.upsertEnvelopes(applied.upsertEnvelopes);
      if (applied.patchMutable.length) await txn.patchEnvelopeMutable(applied.patchMutable);
      if (applied.enqueueBodies.length) await txn.enqueueBodies(applied.enqueueBodies);
      // DESTROYS last (§5.4): ids are never reused (RFC 8620 §1.2), so a destroy
      // refers to the same record as any create/update of that id in the same page.
      if (applied.deleteEmails.length) await txn.deleteEmails(applied.deleteEmails);

      return (
        applied.upsertEnvelopes.length +
          applied.patchMutable.length +
          applied.deleteEmails.length +
          applied.enqueueBodies.length >
        0
      );
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The shared drain loop (§6.3)
// ─────────────────────────────────────────────────────────────────────────────

interface DrainSpec<Extra = unknown> {
  request(
    sinceState: string,
    rung: MaxChangesRung,
  ): Promise<{ page: ChangesPage; updatedProperties?: string[] | null } | null>;
  applyPage(txn: SyncTxn, page: ChangesPage, extra?: Extra): Promise<boolean>;
}

async function drain(
  ctx: DrainContext,
  initialCursor: SyncCursor,
  key: CursorKey,
  spec: DrainSpec<{ updatedProperties?: string[] | null }>,
): Promise<DrainResult> {
  let cursor = initialCursor;
  let budget = ctx.pageBudget;
  let pagesApplied = 0;
  let madeProgress = false;

  for (;;) {
    if (ctx.shouldAbort()) {
      await patchDrainPending(ctx, key, true);
      return { outcome: 'aborted', pagesApplied, madeProgress };
    }
    // I9: every loop has an explicit budget and terminates. Exceeding it is a
    // NORMAL outcome (`partial`), not an error — the cursor stands at the last
    // committed page, `drainPending` stays true, and T9 resumes. This is also the
    // answer to a server whose `hasMoreChanges` never goes false (F14).
    if (budget <= 0 || ctx.now() >= ctx.deadlineAt) {
      await patchDrainPending(ctx, key, true);
      return { outcome: 'partial', pagesApplied, madeProgress };
    }
    budget -= 1;

    // §8.3: verify the client still serves this account before EVERY network call.
    if (!ctx.port.servesAccount(ctx.jmapAccountId)) {
      await patchDrainPending(ctx, key, true);
      return { outcome: 'aborted', pagesApplied, madeProgress };
    }

    const sinceState = cursor.state;
    let response: { page: ChangesPage; updatedProperties?: string[] | null } | null;
    try {
      response = await spec.request(sinceState, cursor.maxChangesRung);
    } catch (err) {
      return handleFailure(ctx, key, cursor, sinceState, err, pagesApplied, madeProgress);
    }

    if (response === null) {
      // The ONE class that moves a cursor, and it moves it to "invalidated".
      // RFC 8620 §5.2: *"the server cannot calculate the changes from the state
      // string given by the client… The client MUST invalidate its Foo cache."*
      return {
        outcome: 'state-invalid',
        pagesApplied,
        madeProgress,
        invalidReason: 'cannotCalculateChanges',
      };
    }

    let page = response.page;
    let extra = { updatedProperties: response.updatedProperties };

    if (page.oldState !== sinceState) {
      const confirmation = await confirmOldStateMismatch(
        ctx,
        async () => {
          const again = await spec.request(sinceState, cursor.maxChangesRung);
          return again === null ? null : again.page;
        },
        sinceState,
      );
      if (confirmation.confirmed) {
        return {
          outcome: 'state-invalid',
          pagesApplied,
          madeProgress,
          invalidReason: 'oldStateMismatch',
        };
      }
      page = confirmation.page;
      extra = { updatedProperties: response.updatedProperties };
    }

    // One transaction per page. Records may be committed partially ACROSS pages
    // (§7.4) but never within one: if a batch fails, the cursor does not advance and
    // the whole page replays, which I5 makes a no-op for anything already written.
    try {
      const committedSomething = await ctx.store.transaction(async (txn) => {
        const wrote = await spec.applyPage(txn, page, extra);

        // advanceCursor LAST (I1). No cast: `page.newState` is already a
        // ChangesState from §12.1's wrapper, and §6.3's rule is that an
        // `as ChangesState` cast outside the api parsers is a bug.
        //
        // `page`, NOT `response.page`: after a transient oldState-mismatch anomaly
        // (§7.6.1) `page` is the RE-ISSUED page, and advancing to the original
        // response's newState would skip whatever the re-issue reported — the same
        // silent-gap shape as D4, reintroduced one level down.
        await txn.advanceCursor(key, page.newState);
        await txn.patchCursor(key, {
          drainPending: page.hasMoreChanges,
          ...resetOnAdvance(),
        });
        return wrote;
      });
      pagesApplied += 1;
      madeProgress = madeProgress || committedSomething;
    } catch (err) {
      // I4: a storage write failure is FATAL for the cycle. Cursor unchanged,
      // surfaced, never warn-and-continue (D2/F30).
      return handleFailure(ctx, key, cursor, sinceState, err, pagesApplied, madeProgress);
    }

    cursor = {
      ...cursor,
      state: page.newState,
      drainPending: page.hasMoreChanges,
      ...resetOnAdvance(),
    };

    if (!page.hasMoreChanges) return { outcome: 'ok', pagesApplied, madeProgress };
  }
}

async function patchDrainPending(
  ctx: DrainContext,
  key: CursorKey,
  drainPending: boolean,
): Promise<void> {
  try {
    await ctx.store.transaction((txn) => txn.patchCursor(key, { drainPending }));
  } catch {
    // `drainPending` is a SCHEDULING HINT, never a correctness input (§6.3), so
    // failing to record it must not turn a partial cycle into a failed one.
  }
}

async function handleFailure(
  ctx: DrainContext,
  key: CursorKey,
  cursor: SyncCursor,
  failedState: string,
  err: unknown,
  pagesApplied: number,
  madeProgress: boolean,
): Promise<DrainResult> {
  if (err instanceof AnchorNotFoundError) {
    // Only the coverage scan uses anchors; reaching here means a programming
    // error rather than a server condition.
    log(ctx, 'error', `unexpected anchorNotFound on a /changes drain: ${err.message}`);
  }
  const classified = classify(err);

  if (classified.class === 'StateInvalid') {
    return {
      outcome: 'state-invalid',
      pagesApplied,
      madeProgress,
      invalidReason:
        err instanceof StateInvalidError && err.reason === 'oldStateMismatch'
          ? 'oldStateMismatch'
          : 'cannotCalculateChanges',
      error: classified.message,
    };
  }

  // §7.1: everywhere except StateInvalid, FAILURE MEANS THE CURSOR STANDS STILL.
  // That is what makes "a failure never causes silent data loss" structural.
  const decision = escalateOnFailure(cursor, failedState);
  try {
    await ctx.store.transaction((txn) => txn.patchCursor(key, decision.patch));
  } catch (patchErr) {
    log(ctx, 'error', `failed to persist escalation counters: ${String(patchErr)}`);
  }

  if (decision.escalateToReconcile) {
    log(
      ctx,
      'error',
      `escalating ${key.type}/${key.jmapAccountId} to reconcile: ${decision.reason} (last error: ${classified.message})`,
    );
    return {
      outcome: 'state-invalid',
      pagesApplied,
      madeProgress,
      invalidReason: 'cannotCalculateChanges',
      error: classified.message,
    };
  }

  log(
    ctx,
    classified.class === 'Fatal' ? 'error' : 'warn',
    `${key.type}/${key.jmapAccountId} drain failed (${classified.class}): ${classified.message}`,
  );
  return { outcome: 'failed', pagesApplied, madeProgress, error: classified.message };
}

/** Which cursor types a cycle drains, in §5.1's order. */
export const DRAIN_ORDER: readonly CursorType[] = ['Mailbox', 'Email'];
