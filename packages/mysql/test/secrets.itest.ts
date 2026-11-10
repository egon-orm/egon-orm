// The security review of step 21: secrets on MySQL (tier 2: EGON_TEST_TIER2=1). As
// packages/postgres/test/secrets.itest.ts: a redacted field's value and the connection's
// password appear in no log line, error message, JSON, or inspect output of the repo, the
// adapter and a transaction. MySQL's own message of a duplicate key quotes the value; it
// stays on `error.cause`, which inspect output of the error leaves out (see SECURITY.md).
import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import {
  ConstraintError,
  cast,
  createRepo,
  type DatabaseAdapter,
  fragment,
  from,
  type RepoQueryEvent,
  Schema,
  t,
} from "egon-orm";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { createTestDatabase, type TestDatabaseHandle, tier2Enabled } from "../../core/test/support/index.js";
import { type MysqlOptions, mysql } from "../src/index.js";

const SECRET = `s3cr3t-${randomUUID()}`;
const PASSWORD = `pw-${randomUUID()}`;

class Account extends Schema("accounts", {
  id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(),
  email: t.string(),
  tokenHash: t.string().nullable().redact(),
}) {}

function shown(value: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(value) ?? "";
  } catch (error) {
    json = String(error);
  }
  return `${inspect(value, { depth: Number.POSITIVE_INFINITY, showHidden: true })}\n${json}`;
}

describe.runIf(tier2Enabled())("mysql secrets", () => {
  let handle: TestDatabaseHandle;
  const made: DatabaseAdapter[] = [];

  function server(): MysqlOptions {
    const { settings, name } = handle.db;
    return {
      host: settings.host,
      port: settings.port,
      user: settings.user,
      password: settings.password,
      database: name,
    };
  }

  function observed(options: MysqlOptions) {
    const lines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    const adapter = mysql(options);
    made.push(adapter);
    const repo = createRepo({ adapter, log: { params: true } });
    const events: RepoQueryEvent[] = [];
    repo.on("query", (event) => events.push(event));
    return { repo, adapter, lines, events };
  }

  beforeAll(async () => {
    handle = await createTestDatabase("mysql", { label: "secrets" });
    await handle.db.exec(
      "create table accounts (id bigint auto_increment primary key, email varchar(255) not null, token_hash varchar(255) unique)",
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const each of made.splice(0)) await each.close();
    await handle.db.exec("delete from accounts");
  });

  afterAll(async () => {
    await handle?.drop();
  });

  test("a redacted value: bound and redacted in logs; a duplicate keeps it on error.cause only", async () => {
    const { repo, lines, events } = observed(server());
    const account = await repo.insertOrThrow(
      cast(Account, { email: "a@b.c", tokenHash: SECRET }, ["email", "tokenHash"]),
    );
    expect(shown(account)).not.toContain(SECRET);
    await repo.all(from(Account, "a").where(({ a }) => a.tokenHash.eq(SECRET)));
    const error = await repo
      .insertOrThrow(cast(Account, { email: "b@b.c", tokenHash: SECRET }, ["email", "tokenHash"]))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConstraintError);
    expect((error as Error).message).not.toContain(SECRET);
    expect(JSON.stringify(error)).not.toContain(SECRET);
    expect(lines.join("")).toContain("**redacted**");
    expect(lines.join("")).not.toContain(SECRET);
    expect(JSON.stringify(events)).not.toContain(SECRET);
    // MySQL's message ("Duplicate entry '…' for key …") is the cause's: it is read, not inspected.
    expect(((error as Error).cause as Error).message).toContain(SECRET);
    expect(inspect(error)).not.toContain(SECRET);
    expect(shown(error)).not.toContain(SECRET);
    expect(inspect(error)).toContain("[cause]: Error ER_DUP_ENTRY (hidden: read error.cause)");
    expect(shown(events)).not.toContain(SECRET);
  });

  test("the password: not in the error of an unreachable server, nor in the repo or adapter", async () => {
    const { repo, adapter, lines } = observed({
      connectionString: `mysql://root:${PASSWORD}@127.0.0.1:1/egon`,
    });
    const error = await repo.raw(fragment`select 1`).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(`${(error as Error).message}\n${String((error as Error).stack)}`).not.toContain(PASSWORD);
    expect(JSON.stringify(error)).not.toContain(PASSWORD);
    // The whole error as inspect shows it, with its cause (the driver's error).
    expect(shown(error)).not.toContain(PASSWORD);
    expect(shown(repo)).not.toContain(PASSWORD);
    expect(shown(adapter)).not.toContain(PASSWORD);
    expect(lines.join("")).not.toContain(PASSWORD);
  });

  test("the password: a wrong one is not echoed; a connected repo and transaction do not show it", async () => {
    const wrong = observed({ ...server(), password: PASSWORD });
    const error = await wrong.repo.raw(fragment`select 1`).catch((caught: unknown) => caught);
    expect(shown(error)).not.toContain(PASSWORD);

    const { settings, name } = handle.db;
    const right = mysql({
      connectionString: `mysql://${settings.user}:${encodeURIComponent(settings.password)}@${settings.host}:${settings.port}/${name}`,
    });
    made.push(right);
    const repo = createRepo({ adapter: right });
    await repo.raw(fragment`select 1`);
    const quoted = [`:${settings.password}@`, `'${settings.password}'`, `"${settings.password}"`];
    await repo.transaction(async (tx) => {
      const inTx = shown(tx);
      for (const text of quoted) expect(inTx).not.toContain(text);
    });
    const outside = `${shown(repo)}${shown(right)}`;
    for (const text of quoted) expect(outside).not.toContain(text);
  });
});
