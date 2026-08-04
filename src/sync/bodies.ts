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
  /** Rows that reached a durable terminal state this pass. */
  gaveUp: number;
  /** Rows ACTUALLY inserted — not entries attempted. */
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
    gaveUp: 0,
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
  const giveUp: Array<{ key: RowKey; reason: 'attempts' | 'notFound'; lastError?: string }> = [];
  const retry: BodyQueueEntry[] = [];

  for (const entry of actionable) {
    const key: RowKey = { jmapAccountId: entry.jmapAccountId, id: entry.emailId };
    if (notFoundSet.has(entry.emailId)) {
      // F40 / S12: stop immediately — the message is gone, so the entry can never
      // succeed and must not burn five attempts.
      //
      // Recorded as a DURABLE give-up rather than a delete. Deleting the row let job
      // C2 re-insert it on the very next cycle (its driver only knows "envelope
      // without a body"), producing one wasted fetch per cycle forever.
      giveUp.push({ key, reason: 'notFound' });
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
      if (giveUp.length) await txn.markBodyGaveUp(giveUp);
      if (retry.length) await txn.updateBodyQueue(retry);
    });
  } catch (err) {
    const classified = classify(err);
    out.error = classified.message;
    return out;
  }

  out.fetched = writes.length;
  out.dequeued += dequeue.length + giveUp.length;
  out.gaveUp += giveUp.length;
  out.failed = retry.length;
  out.madeProgress = writes.length + dequeue.length + giveUp.length > 0;
  return out;
}

async function recordBodyFailures(
  ctx: BodiesContext,
  entries: readonly BodyQueueEntry[],
  message: string,
  out: BodiesResult,
): Promise<void> {
  const retry: BodyQueueEntry[] = [];
  const giveUp: Array<{ key: RowKey; reason: 'attempts' | 'notFound'; lastError?: string }> = [];
  for (const entry of entries) {
    const attempts = entry.attempts + 1;
    if (attempts >= MAX_BODY_ATTEMPTS) {
      // §7.4: after 5 attempts we stop and the message stays envelope-only — openable
      // online, marked not-downloaded offline.
      //
      // Recorded as a DURABLE give-up. Deleting the row made the give-up rule hold
      // only while the row existed: C2 re-inserted a fresh `attempts: 0` row on the
      // next cycle, so a permanently-failing body retried five times per cycle
      // forever. A completed reconcile is what clears this (§7.6 step 5).
      giveUp.push({
        key: { jmapAccountId: entry.jmapAccountId, id: entry.emailId },
        reason: 'attempts',
        lastError: message,
      });
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
      if (giveUp.length) await txn.markBodyGaveUp(giveUp);
    });
  } catch (err) {
    ctx.log?.('error', `failed to record body failures: ${String(err)}`);
  }
  out.failed += retry.length;
  out.gaveUp += giveUp.length;
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

  // CAP-AWARE. Without this, C2 fights the evictor: bodies over the cap are shed,
  // C2 notices the envelopes are inside the body WINDOW and re-enqueues them, they
  // download again, the cap sheds them again — unbounded data and battery use, and
  // the loop never terminates because there is always an envelope without a body.
  //
  // The window says WHICH bodies are wanted; the cap says HOW MANY fit. C2 must
  // respect both, so it only enqueues while there is projected headroom. `size` is
  // the RFC822 message size from the envelope tier — an estimate, but the right
  // order of magnitude, and erring high just means enqueuing fewer per pass.
  const used = await ctx.store.bodyBytesTotal();
  let headroom = ctx.maxBodyBytes - used;
  if (headroom <= 0) return out;

  // THE FRONTIER. Headroom alone is not enough: the evictor sheds oldest-first, so
  // anything older than the oldest body we currently keep is guaranteed to be the next
  // thing evicted — enqueuing it is guaranteed waste, and C2 and the evictor would
  // trade the same bytes back and forth forever.
  //
  // So when the cap is the binding constraint, the cap defines an EFFECTIVE body window
  // narrower than the setting, and C2 works only inside it. That makes C2 monotone:
  // it fills newest-first down to the frontier and then has nothing left to do.
  let effectiveFrom = ctx.bodyFrom;
  if (used > 0 && used >= ctx.maxBodyBytes * 0.9) {
    const [oldestKept] = await ctx.store.listBodiesForEviction(1);
    if (oldestKept && oldestKept.receivedAt > effectiveFrom) {
      effectiveFrom = oldestKept.receivedAt;
    }
  }

  const candidates = await ctx.store.queryEnvelopes({
    jmapAccountId: ctx.jmapAccountId,
    hasBody: false,
    receivedAfter: effectiveFrom,
    limit: ctx.itemBudget,
  });
  if (candidates.length === 0) return out;

  // Rows with a durable terminal state are excluded here as well as by
  // `enqueueBodies`'s insert-or-ignore — belt and braces, and it keeps the projected
  // headroom honest.
  const gaveUp = new Set(
    (await ctx.store.listBodyGiveUps(ctx.jmapAccountId, 2000)).map((k) => k.id),
  );

  const entries: BodyQueueEntry[] = [];
  for (const e of candidates) {
    if (gaveUp.has(e.id)) continue;
    if (hasPendingDestroy(ctx.pending?.get(e.id))) continue;
    const estimate = e.size ?? 0;
    if (entries.length > 0 && estimate > headroom) break;
    headroom -= estimate;
    entries.push({
      jmapAccountId: e.jmapAccountId,
      emailId: e.id,
      receivedAt: e.receivedAt,
      attempts: 0,
    });
    if (headroom <= 0) break;
  }
  if (entries.length === 0) return out;

  // The INSERTED count, not the attempted count. Reporting the latter made the engine
  // treat every cycle as having unfinished work for as long as any envelope lacked a
  // body, chaining a new cycle every 5 s indefinitely.
  const inserted = await ctx.store.transaction((txn) => txn.enqueueBodies(entries));
  out.enqueued = inserted;
  out.madeProgress = inserted > 0;
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
