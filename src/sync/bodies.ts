// Jobs C1 (queue drain) and C2 (backfill), plus the MB-cap eviction of F25.
//
// C2 is revision 2's S9 fix and it is not optional: it backfills bodies for
// envelopes that are ALREADY COVERED but have no body — the case that arises when
// the BODY window widens after coverage has completed, and the self-heal for bodies
// dropped after repeated failure. Without C2, widening body retention silently does
// nothing for already-covered envelopes (F24), which is precisely the operation
// §2.1's retention decision makes user-reachable.

import type { Email } from '../api/types';
import { classify } from './errors';
import type { JmapPort } from './jmap-port';
import { hasPendingDestroy, type PendingIndex } from './overlay';
import { bytesToEvict, selectBodiesToEvict } from './retention';
import type { BodyQueueEntry, BodyRow, RowKey, SyncStore } from './store';
import type { JmapAccountId } from './states';

/** §7.4: after this many attempts the entry is DEQUEUED and the message stays envelope-only. */
export const MAX_BODY_ATTEMPTS = 5;

export interface BodiesResult {
  fetched: number;
  failed: number;
  dequeued: number;
  enqueued: number;
  evictedBodies: number;
  madeProgress: boolean;
  aborted: boolean;
  error?: string;
}

export interface BodiesContext {
  store: SyncStore;
  port: JmapPort;
  jmapAccountId: JmapAccountId;
  /** ISO floor of the BODY window. */
  bodyFrom: string;
  maxBodyBytes: number;
  /** Items per cycle across C1+C2 (§6.4). */
  itemBudget: number;
  deadlineAt: number;
  pending?: PendingIndex;
  now(): number;
  shouldAbort(): boolean;
  /** Backoff for a failed body, mirroring §7.2. */
  backoffMs(attempts: number): number;
  log?: (level: 'warn' | 'error' | 'info', message: string) => void;
}

function emptyResult(): BodiesResult {
  return {
    fetched: 0,
    failed: 0,
    dequeued: 0,
    enqueued: 0,
    evictedBodies: 0,
    madeProgress: false,
    aborted: false,
  };
}

/** The body tier's serialised payload (§2.1). */
function serialiseBody(email: Email): string {
  return JSON.stringify({
    bodyStructure: email.bodyStructure,
    textBody: email.textBody,
    htmlBody: email.htmlBody,
    bodyValues: email.bodyValues,
    attachments: email.attachments,
    blobId: email.blobId,
    bcc: email.bcc,
    replyTo: email.replyTo,
    sentAt: email.sentAt,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Job C1 — drain the durable body queue
// ─────────────────────────────────────────────────────────────────────────────

export async function drainBodyQueue(ctx: BodiesContext): Promise<BodiesResult> {
  const out = emptyResult();
  if (ctx.itemBudget <= 0) return out;

  const queued = await ctx.store.takeBodyQueue(ctx.itemBudget, ctx.now());
  if (queued.length === 0) return out;

  // F29 / §5.6: never spend a download on a message with a pending destroy.
  const actionable = queued.filter((e) => !hasPendingDestroy(ctx.pending?.get(e.emailId)));
  const skipped = queued.filter((e) => hasPendingDestroy(ctx.pending?.get(e.emailId)));
  if (skipped.length) {
    await ctx.store.transaction((txn) =>
      txn.dequeueBodies(
        skipped.map((e) => ({ jmapAccountId: e.jmapAccountId, id: e.emailId })),
      ),
    );
    out.dequeued += skipped.length;
  }
  if (actionable.length === 0) return out;

  if (ctx.shouldAbort() || ctx.now() >= ctx.deadlineAt) {
    out.aborted = true;
    return out;
  }
  if (!ctx.port.servesAccount(ctx.jmapAccountId)) {
    out.aborted = true;
    return out;
  }

  const ids = actionable.map((e) => e.emailId);
  let list: Email[];
  let notFound: string[];
  try {
    const res = await ctx.port.getBodies(ids, ctx.jmapAccountId);
    list = res.list;
    notFound = res.notFound;
  } catch (err) {
    // §7.4: BODY FAILURES NEVER AFFECT A CURSOR. C1/C2 are separate state, so the
    // delta path keeps its position and the queue simply retries later.
    const classified = classify(err);
    ctx.log?.('warn', `body fetch failed (${classified.class}): ${classified.message}`);
    await recordBodyFailures(ctx, actionable, classified.message, out);
    out.error = classified.message;
    return out;
  }

  const byId = new Map(list.map((e) => [e.id, e]));
  const notFoundSet = new Set(notFound);

  const writes: Array<{ key: RowKey; body: BodyRow }> = [];
  const dequeue: RowKey[] = [];
  const retry: BodyQueueEntry[] = [];

  for (const entry of actionable) {
    const key: RowKey = { jmapAccountId: entry.jmapAccountId, id: entry.emailId };
    if (notFoundSet.has(entry.emailId)) {
      // F40 / S12: DEQUEUE IMMEDIATELY. The message is gone; the entry can never
      // succeed and would otherwise burn five attempts and leave a row behind.
      dequeue.push(key);
      continue;
    }
    const email = byId.get(entry.emailId);
    if (!email) {
      // Present in neither `list` nor `notFound` — treat as a transient miss.
      retry.push({
        ...entry,
        attempts: entry.attempts + 1,
        lastError: 'Email/get returned neither the record nor notFound',
        nextAttemptAt: ctx.now() + ctx.backoffMs(entry.attempts + 1),
      });
      continue;
    }
    const json = serialiseBody(email);
    writes.push({
      key,
      body: {
        jmapAccountId: entry.jmapAccountId,
        emailId: entry.emailId,
        receivedAt: entry.receivedAt,
        json,
        bytes: json.length,
      },
    });
  }

  try {
    await ctx.store.transaction(async (txn) => {
      for (const { key, body } of writes) {
        // F48: conditional on the envelope still existing, so a body fetched just
        // before its envelope was destroyed cannot land as an orphan. This is also
        // why "run bodies in parallel, it's separate state" is forbidden (I11).
        const wrote = await txn.putBodyIfEnvelopeExists(key, body);
        if (!wrote) await txn.dequeueBodies([key]);
      }
      if (dequeue.length) await txn.dequeueBodies(dequeue);
      if (retry.length) await txn.updateBodyQueue(retry);
    });
  } catch (err) {
    const classified = classify(err);
    out.error = classified.message;
    return out;
  }

  out.fetched = writes.length;
  out.dequeued += dequeue.length;
  out.failed = retry.length;
  out.madeProgress = writes.length + dequeue.length > 0;
  return out;
}

async function recordBodyFailures(
  ctx: BodiesContext,
  entries: readonly BodyQueueEntry[],
  message: string,
  out: BodiesResult,
): Promise<void> {
  const retry: BodyQueueEntry[] = [];
  const giveUp: RowKey[] = [];
  for (const entry of entries) {
    const attempts = entry.attempts + 1;
    if (attempts >= MAX_BODY_ATTEMPTS) {
      // §7.4: after 5 attempts the entry is dequeued and the message stays
      // envelope-only — openable online, marked not-downloaded offline. Job C2 is
      // the self-heal that may re-enqueue it later, and F41 is why that cannot
      // reset the counter.
      giveUp.push({ jmapAccountId: entry.jmapAccountId, id: entry.emailId });
      continue;
    }
    retry.push({
      ...entry,
      attempts,
      lastError: message,
      nextAttemptAt: ctx.now() + ctx.backoffMs(attempts),
    });
  }
  try {
    await ctx.store.transaction(async (txn) => {
      if (retry.length) await txn.updateBodyQueue(retry);
      if (giveUp.length) await txn.dequeueBodies(giveUp);
    });
  } catch (err) {
    ctx.log?.('error', `failed to record body failures: ${String(err)}`);
  }
  out.failed += retry.length;
  out.dequeued += giveUp.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Job C2 — body backfill (S9)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Enqueue bodies for envelopes inside the body window that have no body yet — the
 * `queryEnvelopes({ hasBody: false, receivedAfter: bodyFrom })` driver, served by
 * the `envelope_nobody` index.
 *
 * `enqueueBodies` is insert-or-ignore and NEVER resets `attempts` (F41), so C2
 * cannot defeat the give-up-after-5 rule by re-enqueuing a permanently failing body.
 * That is what keeps this job a self-heal rather than an infinite retry loop.
 */
export async function backfillBodies(ctx: BodiesContext): Promise<BodiesResult> {
  const out = emptyResult();
  if (ctx.itemBudget <= 0) return out;

  const candidates = await ctx.store.queryEnvelopes({
    jmapAccountId: ctx.jmapAccountId,
    hasBody: false,
    receivedAfter: ctx.bodyFrom,
    limit: ctx.itemBudget,
  });
  if (candidates.length === 0) return out;

  const entries: BodyQueueEntry[] = candidates
    .filter((e) => !hasPendingDestroy(ctx.pending?.get(e.id)))
    .map((e) => ({
      jmapAccountId: e.jmapAccountId,
      emailId: e.id,
      receivedAt: e.receivedAt,
      attempts: 0,
    }));
  if (entries.length === 0) return out;

  await ctx.store.transaction((txn) => txn.enqueueBodies(entries));
  out.enqueued = entries.length;
  out.madeProgress = true;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Retention enforcement on the body tier
// ─────────────────────────────────────────────────────────────────────────────

/**
 * F24B + F25. Envelopes always survive both, so a message stays listed and
 * openable-online after its body is shed — that is the whole point of §2.1's
 * two-tier split and of the MB cap applying to bodies only.
 */
export async function enforceBodyRetention(ctx: BodiesContext): Promise<BodiesResult> {
  const out = emptyResult();

  // F24B: bodies below the body floor go, and their queue entries with them.
  for (;;) {
    const below = await ctx.store.queryEnvelopes({
      jmapAccountId: ctx.jmapAccountId,
      hasBody: true,
      receivedBefore: ctx.bodyFrom,
      limit: 500,
    });
    if (below.length === 0) break;
    const keys = below.map((e) => ({ jmapAccountId: e.jmapAccountId, id: e.id }));
    await ctx.store.transaction(async (txn) => {
      await txn.deleteBodies(keys);
      await txn.dequeueBodies(keys);
    });
    out.evictedBodies += keys.length;
    out.madeProgress = true;
    if (below.length < 500) break;
  }

  // F25: over the cap — evict oldest-body-first from the body table alone (S12), so
  // eviction cannot be blinded by a missing join to envelope.
  const total = await ctx.store.bodyBytesTotal();
  const overage = bytesToEvict(total, ctx.maxBodyBytes);
  if (overage > 0) {
    const oldest = await ctx.store.listBodiesForEviction(2000);
    const victims = selectBodiesToEvict(oldest, overage);
    if (victims.length) {
      const keys = victims.map((v) => v.key);
      await ctx.store.transaction(async (txn) => {
        await txn.deleteBodies(keys);
        await txn.dequeueBodies(keys);
      });
      out.evictedBodies += keys.length;
      out.madeProgress = true;
    }
  }

  // F45: orphan bodies consume the user's storage cap while being invisible to
  // eviction, which only walks the body table.
  const orphans = await ctx.store.listOrphanBodies(500);
  if (orphans.length) {
    await ctx.store.transaction((txn) => txn.deleteBodies(orphans));
    out.evictedBodies += orphans.length;
    out.madeProgress = true;
    ctx.log?.('warn', `swept ${orphans.length} orphan body row(s) (F45)`);
  }

  return out;
}
