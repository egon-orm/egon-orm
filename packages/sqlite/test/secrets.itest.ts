// Secrets on SQLite, as packages/postgres/test/secrets.itest.ts: a redacted field's value
// appears in no log line, error message, JSON or inspect output of the error a duplicate
// raises. SQLite's own message names the column, not the value; the driver's error stays
// on `error.cause`, and inspect output shows it by name and code only (SECURITY.md).
import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { ConstraintError, cast, createRepo, from, type RepoQueryEvent, Schema, t } from "egon-orm";
import { afterEach, describe, expect, test, vi } from "vitest";
import { sqlite } from "../src/index.js";

const SECRET = `s3cr3t-${randomUUID()}`;

class Account extends Schema("accounts", {
  id: t.integer().primaryKey().dbGenerated(),
  email: t.string(),
  tokenHash: t.string().nullable().redact(),
}) {}

function shown(value: unknown): string {
  return `${inspect(value, { depth: Number.POSITIVE_INFINITY, showHidden: true })}\n${JSON.stringify(value)}`;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sqlite secrets", () => {
  test("a duplicate of a redacted value: the error's message, JSON, log line and inspect output hold no value", async () => {
    const lines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    const adapter = sqlite({ filename: ":memory:" });
    try {
      const repo = createRepo({ adapter, log: { params: true } });
      const events: RepoQueryEvent[] = [];
      repo.on("query", (event) => events.push(event));
      await adapter.execute(
        "create table accounts (id integer primary key, email text not null, token_hash text unique)",
        [],
      );
      await repo.insertOrThrow(cast(Account, { email: "a@b.c", tokenHash: SECRET }, ["email", "tokenHash"]));
      await repo.all(from(Account, "a").where(({ a }) => a.tokenHash.eq(SECRET)));
      const error = await repo
        .insertOrThrow(cast(Account, { email: "b@b.c", tokenHash: SECRET }, ["email", "tokenHash"]))
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ConstraintError);
      expect((error as ConstraintError).cause).toBeInstanceOf(Error);
      expect(shown(error)).not.toContain(SECRET);
      expect(inspect(error)).toContain(
        "[cause]: SqliteError SQLITE_CONSTRAINT_UNIQUE (hidden: read error.cause)",
      );
      expect(lines.join("")).toContain("**redacted**");
      expect(lines.join("")).not.toContain(SECRET);
      expect(events.at(-1)?.error).toBeInstanceOf(ConstraintError);
      expect(shown(events)).not.toContain(SECRET);
    } finally {
      await adapter.close();
    }
  });
});
