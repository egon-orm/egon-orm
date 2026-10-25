// Vitest globalSetup for every `<package>:integration` project (see vitest.config.ts).
//
// Before the run: gives the run an id (inherited by all workers, embedded in every test
// database name) and drops stale databases leaked by earlier runs that were killed.
// After the run: drops whatever this run still owns, for example after a crashed worker,
// then fails the run if a test file left a pool with a connection checked out (the records
// that leak-check.ts writes in the workers; see leaks.ts).
//
// Safe when two runs share one server: see sweepTestDatabases.
import { randomBytes } from "node:crypto";
import { RUN_ID_ENV } from "./db.js";
import { type Dialect, tier2Enabled } from "./env.js";
import { assertNoLeaks, prepareLeakDirectory, readFileRecords, removeLeakDirectory } from "./leaks.js";
import { sweepTestDatabases } from "./sweep.js";

/** A database older than this cannot belong to a live run. Override with EGON_TEST_STALE_MINUTES. */
const DEFAULT_STALE_MINUTES = 30;

// Several projects share this file in one process; set up on the first, tear down on the last.
const state = globalThis as typeof globalThis & { __egonIntegrationProjects?: number };

function dialects(): Dialect[] {
  return tier2Enabled() ? ["postgres", "mysql"] : ["postgres"];
}

function staleMs(): number {
  const raw = process.env.EGON_TEST_STALE_MINUTES;
  const minutes = raw === undefined || raw === "" ? DEFAULT_STALE_MINUTES : Number(raw);
  if (!Number.isFinite(minutes) || minutes < 0) {
    throw new Error(`EGON_TEST_STALE_MINUTES must be a non-negative number, got ${JSON.stringify(raw)}`);
  }
  return minutes * 60_000;
}

export async function setup(): Promise<void> {
  state.__egonIntegrationProjects = (state.__egonIntegrationProjects ?? 0) + 1;
  if (state.__egonIntegrationProjects > 1) return;

  // A nested run (parallel.itest.ts) keeps the id of the run that started it.
  const runId = process.env[RUN_ID_ENV] ?? `r${randomBytes(4).toString("hex")}`;
  process.env[RUN_ID_ENV] = runId;
  prepareLeakDirectory(runId);
  for (const dialect of dialects()) {
    await sweepTestDatabases(dialect, { olderThanMs: staleMs() });
  }
}

export async function teardown(): Promise<void> {
  state.__egonIntegrationProjects = (state.__egonIntegrationProjects ?? 1) - 1;
  if (state.__egonIntegrationProjects > 0) return;

  const runId = process.env[RUN_ID_ENV];
  if (runId === undefined) return;
  for (const dialect of dialects()) {
    await sweepTestDatabases(dialect, { runId });
  }
  const records = readFileRecords(runId);
  removeLeakDirectory(runId);
  assertNoLeaks(records);
}
