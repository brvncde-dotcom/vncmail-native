/**
 * The per-account mutex §9.1 requires, so a cycle's commit and a concurrent
 * `clearRecords()` / settings change cannot interleave (S1/F37).
 *
 * Under SQLite the `BEGIN…COMMIT` already provides atomicity; the mutex is what
 * makes the read-merge-write of a field-level state patch safe, and what lets
 * `store-memory.ts` offer the same guarantee without a database. Under §9.2's
 * AsyncStorage contingency it would be load-bearing rather than belt-and-braces.
 *
 * FIFO, so a waiter cannot be starved by a stream of later arrivals.
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    // Chain onto the tail regardless of how the previous holder settled, so one
    // rejected critical section cannot wedge the queue (I10 in miniature).
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

const registryMutexes = new Map<string, Mutex>();

/** Named mutexes, so the registry and each account's store serialise independently. */
export function mutexFor(name: string): Mutex {
  let m = registryMutexes.get(name);
  if (!m) {
    m = new Mutex();
    registryMutexes.set(name, m);
  }
  return m;
}
