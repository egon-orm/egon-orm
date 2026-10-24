// Setup file of the integration projects (vitest.config.ts): the worker half of the
// connection-leak check (see leaks.ts). It registers every adapter that a test file starts,
// and after the file writes the state of each one's pool for the global teardown to check.
//
// Every adapter of the three dialect packages is made by `createAdapter`, and an adapter
// starts its driver (its pool) in one place, the private `open`, on first use. This file
// wraps that method on the adapter class, in the worker only, so it sees every adapter a
// test makes: through a conformance profile, `postgres(...)` called directly, or a repo.
// Nothing of the library is changed; the wrapper only records `this` and calls through.
import { randomBytes } from "node:crypto";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect } from "vitest";
import { createAdapter, type DatabaseAdapter } from "../../src/adapter/adapter.js";
import { POSTGRES_CAPABILITIES } from "../../src/compiler/dialect.js";
import { RUN_ID_ENV } from "./db.js";
import { leaked, type PoolRecord, writeFileRecord } from "./leaks.js";

interface Opening {
  open(this: DatabaseAdapter, sql: string | undefined): unknown;
}

const started = new Set<DatabaseAdapter>();

// An adapter that never starts: only its prototype, the adapter class, is needed.
const probe = createAdapter({
  dialect: "postgres",
  capabilities: POSTGRES_CAPABILITIES,
  quoteIdentifier: (name) => `"${name.replaceAll('"', '""')}"`,
  driver: () => {
    throw new Error("leak-check: the probe adapter is never started");
  },
  driverCodecs: {},
  normalizeError: (error) => error,
});
const adapterClass = Object.getPrototypeOf(probe) as Opening;
const open = adapterClass.open;
if (typeof open !== "function") {
  // The method was renamed: fail loudly rather than check nothing.
  throw new Error("leak-check: the adapter class has no `open` method to wrap; update leak-check.ts");
}
adapterClass.open = function (this: DatabaseAdapter, sql: string | undefined): unknown {
  started.add(this);
  return open.call(this, sql);
};

const REPOSITORY = fileURLToPath(new URL("../../../../", import.meta.url));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** How long a connection may take to come back after the file's last test (a release in flight). */
const SETTLE_MS = 2_000;

afterAll(async () => {
  const runId = process.env[RUN_ID_ENV];
  if (runId === undefined) return;
  const adapters = [...started];
  started.clear();
  const deadline = Date.now() + SETTLE_MS;
  let pools: PoolRecord[] = adapters.map((adapter) => adapter.poolStats());
  while (pools.some(leaked) && Date.now() < deadline) {
    await sleep(20);
    pools = adapters.map((adapter) => adapter.poolStats());
  }
  const file = expect.getState().testPath ?? "(unknown test file)";
  writeFileRecord(
    runId,
    {
      file: relative(REPOSITORY, file),
      pools: pools.map(({ size, idle, waiting }) => ({ size, idle, waiting })),
    },
    `${process.pid}-${randomBytes(6).toString("hex")}`,
  );
});
