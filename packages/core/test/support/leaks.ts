// The connection-leak check of the integration run (step 11: "after the whole integration
// suite, pool reports zero checked out, asserted in a global teardown").
//
// Pools live in the test workers and the global teardown runs in the main process, so the
// two meet in a directory: after each test file, `leak-check.ts` (a setup file, in the
// worker) writes one record with the pool of every adapter the file used, and the teardown
// in `global-setup.ts` reads them all and fails the run if any pool still had a connection
// checked out, or a caller waiting for one.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** What one test file left behind in the pool of one adapter. */
export interface PoolRecord {
  readonly size: number;
  readonly idle: number;
  readonly waiting: number;
}

/** One test file's record: how many adapters it used and the state of each pool at its end. */
export interface FileRecord {
  readonly file: string;
  readonly pools: readonly PoolRecord[];
}

/** The directory where the workers of run `runId` leave their records. */
export function leakDirectory(runId: string): string {
  return join(tmpdir(), "egon-leaks", runId);
}

/** Connections of a pool that are checked out: open, and not idle. */
export function checkedOutOf(pool: PoolRecord): number {
  return pool.size - pool.idle;
}

/** Whether a pool has a connection checked out or a caller waiting for one. */
export function leaked(pool: PoolRecord): boolean {
  return checkedOutOf(pool) > 0 || pool.waiting > 0;
}

/** Creates the (empty) record directory of a run. */
export function prepareLeakDirectory(runId: string): void {
  const directory = leakDirectory(runId);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
}

/** Writes one test file's record (called in a worker). */
export function writeFileRecord(runId: string, record: FileRecord, unique: string): void {
  const directory = leakDirectory(runId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${unique}.json`), JSON.stringify(record));
}

/** Reads every record of a run; a missing directory reads as no records. */
export function readFileRecords(runId: string): FileRecord[] {
  let names: string[];
  try {
    names = readdirSync(leakDirectory(runId));
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(leakDirectory(runId), name), "utf8")) as FileRecord);
}

/** Removes a run's record directory. */
export function removeLeakDirectory(runId: string): void {
  rmSync(leakDirectory(runId), { recursive: true, force: true });
}

/**
 * One line per leaking pool, naming the test file; empty when nothing leaked.
 *
 * @example
 * ```ts
 * leakReport([{ file: "a.itest.ts", pools: [{ size: 2, idle: 1, waiting: 0 }] }]);
 * // => ["a.itest.ts: a pool still has 1 connection(s) checked out and 0 caller(s) waiting"]
 * ```
 */
export function leakReport(records: readonly FileRecord[]): string[] {
  const lines: string[] = [];
  for (const record of records) {
    for (const pool of record.pools) {
      if (!leaked(pool)) continue;
      lines.push(
        `${record.file}: a pool still has ${checkedOutOf(pool)} connection(s) checked out and ${pool.waiting} caller(s) waiting`,
      );
    }
  }
  return lines;
}

/**
 * Throws when any record shows a leak (called by the global teardown).
 *
 * @example
 * ```ts
 * assertNoLeaks(readFileRecords(runId));
 * ```
 */
export function assertNoLeaks(records: readonly FileRecord[]): void {
  const lines = leakReport(records);
  if (lines.length === 0) return;
  throw new Error(
    `Connection leak: ${lines.length} pool(s) ended the integration run with a connection checked out.\n${lines.join("\n")}`,
  );
}

/**
 * Waits until every connection `adapter` checked out is back in its pool, and no caller is
 * waiting for one; fails after `timeoutMs`, naming the pool's state. The per-test half of the
 * leak check, for a suite's `afterEach` (before it closes the adapter).
 *
 * @example
 * ```ts
 * afterEach(async () => {
 *   for (const each of adapters.splice(0)) {
 *     await expectAllReturned(each);
 *     await each.close();
 *   }
 * });
 * ```
 */
export async function expectAllReturned(
  adapter: { poolStats(): PoolRecord },
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let pool = adapter.poolStats();
  while (leaked(pool)) {
    if (Date.now() > deadline) {
      throw new Error(
        `Connection leak: the test ended with ${checkedOutOf(pool)} connection(s) checked out and ${pool.waiting} caller(s) waiting (pool size ${pool.size}, idle ${pool.idle}).`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    pool = adapter.poolStats();
  }
}
