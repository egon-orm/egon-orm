// The security review of step 21: secrets on Postgres. The value of a redacted field, and
// the password of a connection, must not appear in what an application logs or shows: log
// lines (`log: { params: true }`), query events (with and without parameters), inspect
// output of rows, changesets, errors, repos and transactions, `toJSON` of rows,
// changesets and errors, and the messages of every error the library throws.
//
// What is outside that promise, and checked here so that a change to it is noticed:
// `ConstraintError.detail` and `error.cause` are the database's own text, which may quote
// the conflicting value. Inspecting such an error (or a query event that holds it) leaves
// that text out (F4 of docs/plan/status/21-security.md); reading the properties gives it
// (see SECURITY.md). `changeset.params` are the params as given.
import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { createTestDatabase, type TestDatabase, type TestDatabaseHandle } from "@egon-orm/test-support";
import {
  ConstraintError,
  cast,
  createRepo,
  type DatabaseAdapter,
  fragment,
  from,
  InvalidChangesetError,
  type RepoQueryEvent,
  Schema,
  t,
} from "egon-orm";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { type PostgresOptions, postgres } from "../src/index.js";

const SECRET = `s3cr3t-${randomUUID()}`;

class Account extends Schema("accounts", {
  id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(),
  email: t.string(),
  tokenHash: t.string().nullable().redact(),
  recovery: t.string().nullable().redact(),
  age: t.integer().nullable(),
}) {}

let handle: TestDatabaseHandle;
let db: TestDatabase;
const made: DatabaseAdapter[] = [];

function server(): PostgresOptions {
  return {
    host: db.settings.host,
    port: db.settings.port,
    user: db.settings.user,
    password: db.settings.password,
    database: db.name,
  };
}

function adapter(options: PostgresOptions = server()): DatabaseAdapter {
  const created = postgres(options);
  made.push(created);
  return created;
}

beforeAll(async () => {
  handle = await createTestDatabase("postgres", { label: "secrets" });
  db = handle.db;
  await db.exec(
    "create table accounts (id bigserial primary key, email text not null, token_hash text unique, recovery text, age integer)",
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const each of made.splice(0)) await each.close();
  await db.exec("truncate accounts");
});

afterAll(async () => {
  await handle?.drop();
});

/** Everything an application could print about `value`: inspect at any depth, and JSON. */
function shown(value: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(value) ?? "";
  } catch (error) {
    json = String(error);
  }
  return `${inspect(value, { depth: Number.POSITIVE_INFINITY, showHidden: true })}\n${json}`;
}

/** A repo whose log lines, query events and adapter events (with parameters) are kept. */
function observed(options: PostgresOptions = server()) {
  const lines: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  const a = adapter(options);
  const repo = createRepo({ adapter: a, log: { params: true } });
  const events: RepoQueryEvent[] = [];
  repo.on("query", (event) => events.push(event));
  const adapterEvents: unknown[] = [];
  a.on("query", (event) => adapterEvents.push(event), { params: true });
  // An event of a failed statement holds the error, and the error its cause: see below.
  const withoutErrors = (list: readonly unknown[]) =>
    list.map((event) => ({
      ...(event as object),
      error: (event as { error?: unknown }).error === undefined ? undefined : "an error",
    }));
  const everything = () =>
    [
      ...lines,
      shown(withoutErrors(events)),
      shown(withoutErrors(adapterEvents)),
      JSON.stringify(events),
      JSON.stringify(adapterEvents),
    ].join("\n");
  return { repo, adapter: a, lines, events, everything };
}

describe("a redacted field's value", () => {
  test("is bound in every statement and appears in no log line, event, row or changeset", async () => {
    const { repo, lines, events, everything } = observed();
    const changeset = cast(Account, { email: "a@b.c", tokenHash: SECRET, recovery: SECRET }, [
      "email",
      "tokenHash",
      "recovery",
    ]);
    expect(shown(changeset)).not.toContain(SECRET);
    const account = await repo.insertOrThrow(changeset);
    expect(account.tokenHash).toBe(SECRET);
    expect(shown(account)).not.toContain(SECRET);
    expect(JSON.stringify(account)).not.toContain(SECRET);

    // The value in every position a query takes one.
    await repo.all(from(Account, "a").where(({ a }) => a.tokenHash.eq(SECRET)));
    await repo.all(from(Account, "a").where(({ a }) => a.tokenHash.in([SECRET, `${SECRET}2`])));
    await repo.all(from(Account, "a").where(({ a }) => a.tokenHash.like(`${SECRET}%`)));
    await repo.all(from(Account, "a").where(({ a }) => a.recovery.neq(SECRET).or(a.tokenHash.isNull())));
    await repo.updateAll(
      from(Account, "a")
        .where(({ a }) => a.tokenHash.eq(SECRET))
        .set({ recovery: SECRET }),
    );
    const updated = await repo.updateOrThrow(cast(account, { recovery: `${SECRET}!` }, ["recovery"]));
    expect(shown(updated)).not.toContain(SECRET);
    await repo.insertAll(Account, [{ email: "b@b.c", tokenHash: `${SECRET}-b` }]);
    await repo.insertOrThrow(
      cast(Account, { email: "c@b.c", tokenHash: `${SECRET}-c` }, ["email", "tokenHash"]),
      {
        onConflict: { target: ["tokenHash"], update: ["recovery"] },
      },
    );
    await repo.transaction(async (tx) => {
      await tx.insertOrThrow(
        cast(Account, { email: "d@b.c", tokenHash: `${SECRET}-d` }, ["email", "tokenHash"]),
      );
      await tx.transaction(async (inner) => {
        await inner.all(from(Account, "a").where(({ a }) => a.tokenHash.eq(SECRET)));
        expect(shown(inner)).not.toContain(SECRET);
      });
    });

    expect(lines.length).toBeGreaterThan(8);
    expect(lines.join("")).toContain("**redacted**");
    expect(events.every((event) => event.params !== undefined)).toBe(true);
    expect(everything()).not.toContain(SECRET);
  });

  test("an invalid changeset's error shows no value: message, inspect, JSON", async () => {
    const { repo, everything } = observed();
    const changeset = cast(Account, { email: "", tokenHash: SECRET }, ["email", "tokenHash"])
      .validateRequired(["email"])
      .validateLength("tokenHash", { max: 3 });
    const error = await repo.insertOrThrow(changeset).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InvalidChangesetError);
    expect((error as Error).message).not.toContain(SECRET);
    expect(shown(error)).not.toContain(SECRET);
    expect(everything()).not.toContain(SECRET);
  });

  test("a constraint the changeset declares becomes a changeset error without the value", async () => {
    const { repo, everything } = observed();
    await repo.insertOrThrow(cast(Account, { email: "a@b.c", tokenHash: SECRET }, ["email", "tokenHash"]));
    const result = await repo.insert(
      cast(Account, { email: "b@b.c", tokenHash: SECRET }, ["email", "tokenHash"]).uniqueConstraint(
        "tokenHash",
      ),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errorMessages()).toEqual({ tokenHash: ["has already been taken"] });
      expect(shown(result.error)).not.toContain(SECRET);
    }
    expect(everything()).not.toContain(SECRET);
  });

  test("an undeclared violation: the error's message, JSON, log line and inspect output hold no value; its detail and cause do", async () => {
    const { repo, lines, events, everything } = observed();
    await repo.insertOrThrow(cast(Account, { email: "a@b.c", tokenHash: SECRET }, ["email", "tokenHash"]));
    const error = await repo
      .insertOrThrow(cast(Account, { email: "b@b.c", tokenHash: SECRET }, ["email", "tokenHash"]))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConstraintError);
    const violation = error as ConstraintError;
    expect(violation.message).not.toContain(SECRET);
    expect(JSON.stringify(violation)).not.toContain(SECRET);
    expect(lines.some((line) => line.includes("-- error: ConstraintError"))).toBe(true);
    expect(everything()).not.toContain(SECRET);
    // The database's own text is on the properties (SECURITY.md), not in inspect output.
    expect(violation.detail).toContain(SECRET);
    expect(String((violation.cause as { detail?: unknown }).detail)).toContain(SECRET);
    expect(inspect(violation)).not.toContain(SECRET);
    expect(shown(violation)).not.toContain(SECRET);
    expect(inspect(violation)).toContain("[cause]: error 23505 (hidden: read error.cause)");
    expect(events.at(-1)?.error).toBeInstanceOf(ConstraintError);
    expect(inspect(events.at(-1)?.error)).not.toContain(SECRET);
    expect(shown(events)).not.toContain(SECRET);
  });

  test("a value the database cannot convert: the error's message and inspect output leave the database's text out", async () => {
    const { repo, everything } = observed();
    await repo.insertOrThrow(cast(Account, { email: "a@b.c", recovery: SECRET }, ["email", "recovery"]));
    // The stored value, read as an integer: Postgres's message quotes it.
    const error = await repo
      .all(from(Account, "a").select(({ a }) => ({ n: fragment`${a.recovery}::integer`.as<number>() })))
      .catch((caught: unknown) => caught);
    expect((error as Error).message).not.toContain(SECRET);
    expect(JSON.stringify(error)).not.toContain(SECRET);
    expect(everything()).not.toContain(SECRET);
    // The cause is Postgres's error, whose message quotes the value: it is read, not inspected.
    expect(((error as Error).cause as Error).message).toContain(SECRET);
    expect(shown(error)).not.toContain(SECRET);
    expect(inspect(error)).toContain("[cause]: error 22P02 (hidden: read error.cause)");
  });
});

describe("the connection's password", () => {
  const PASSWORD = `pw-${randomUUID()}`;

  test.each([
    ["an unreachable server", `postgres://egon:${PASSWORD}@127.0.0.1:1/egon`],
    ["a port that is not a number", `postgres://egon:${PASSWORD}@127.0.0.1:notaport/egon`],
    ["an address that does not parse", `postgres://egon:${PASSWORD}@[::1/egon`],
    ["an unknown sslmode", `postgres://egon:${PASSWORD}@127.0.0.1:1/egon?sslmode=bogus`],
    ["a host that does not resolve", `postgres://egon:${PASSWORD}@no-such-host.invalid:1/egon`],
  ])("is in no error, log line or inspect output: %s", async (_, connectionString) => {
    const { repo, adapter: a, everything } = observed({ connectionString });
    const error = await repo.raw(fragment`select 1`).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(`${String((error as Error).message)}\n${String((error as Error).stack)}`).not.toContain(PASSWORD);
    expect(JSON.stringify(error)).not.toContain(PASSWORD);
    // The whole error as inspect shows it, with its cause (the driver's error).
    expect(shown(error)).not.toContain(PASSWORD);
    // The driver is started now: its pool holds the connection string.
    expect(shown(repo)).not.toContain(PASSWORD);
    expect(shown(a)).not.toContain(PASSWORD);
    expect(everything()).not.toContain(PASSWORD);
  });

  test("a wrong password: the server's refusal names the user, not the password", async () => {
    const { repo, everything } = observed({ ...server(), password: PASSWORD });
    const error = await repo.raw(fragment`select 1`).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(shown(error)).not.toContain(PASSWORD);
    expect(everything()).not.toContain(PASSWORD);
  });

  test("a connected repo, adapter and transaction do not show it, by connection string or by option", async () => {
    const { host, port, user, password } = db.settings;
    for (const options of [
      { connectionString: `postgres://${user}:${password}@${host}:${port}/${db.name}` },
      server(),
    ]) {
      const repo = createRepo({ adapter: adapter(options) });
      await repo.raw(fragment`select 1`);
      // The test server's password is short and could appear by chance: look for it quoted.
      const quoted = [`:${password}@`, `'${password}'`, `"${password}"`];
      await repo.transaction(async (tx) => {
        const inTx = shown(tx);
        for (const text of quoted) expect(inTx).not.toContain(text);
      });
      const outside = `${shown(repo)}${shown(made[made.length - 1])}`;
      for (const text of quoted) expect(outside).not.toContain(text);
    }
  });
});
