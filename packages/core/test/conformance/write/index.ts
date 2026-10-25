// The write conformance suite: what the repo's writes must do against a real database,
// written once and run by each dialect package with a profile of its own. It covers
// insert (defaults, nulls, every type, generated keys and timestamps, values the database
// fills), update (no change, some, forced), delete, stale rows and optimistic locks under a
// real concurrent update, every constraint type converted and not, every onConflict form,
// insertAll (one row, ragged rows, ten thousand rows in chunks, from a query), updateAll
// with set and returning, deleteAll with a join, and validateUniqueAsync.
//
// One database per run of the suite, over the blog fixture plus the profile's tables. Each
// repo a test makes runs in a sandbox (step 16): a transaction that is rolled back after the
// test, so nothing is committed and there is nothing to empty. The one test that needs two
// connections to see each other's commits runs outside a sandbox and empties the tables
// after itself.
import {
  type AnyFieldType,
  ConstraintError,
  caseWhen,
  cast,
  change,
  coalesce,
  createRepo,
  type DatabaseAdapter,
  DatabaseError,
  defineType,
  fragment,
  from,
  InvalidChangesetError,
  isRow,
  meta,
  now,
  param,
  QueryError,
  type Repo,
  type RepoOptions,
  type RepoQueryEvent,
  Schema,
  StaleEntryError,
  scalar,
  stateOf,
  t,
  val,
} from "egon-orm";
import { createSandbox, type Sandbox } from "egon-orm/testing";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { migrationDialectOf } from "../../../src/migration/dialect.js";
import {
  Comment,
  createTestDatabase,
  Org,
  Post,
  Tag,
  type TestDatabase,
  type TestDatabaseHandle,
  truncateAll,
  User,
} from "../../support/index.js";
import { expectAllReturned } from "../../support/leaks.js";
import { ROUND_TRIP_CASES } from "../adapter/values.js";
import type { MakeWriteAdapterOptions, WriteConformanceProfile } from "./profile.js";

/** An undeclared violation's message as thrown, with the full text: the first line, then the call to add. */
const undeclared = (first: string, add: string, alternative?: string): string =>
  `constraint.undeclared: ${first} ${add}${alternative === undefined ? "" : `\n${alternative}`} See https://egon-orm.github.io/egon-orm/reference/errors/constraint#constraint-undeclared`;

export type { MakeWriteAdapterOptions, WriteConformanceProfile } from "./profile.js";

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

function fail(message: string): never {
  throw new Error(message);
}

/** The data of a successful result, failing the test otherwise. */
function ok<T>(result: { readonly success: true; readonly data: T } | { readonly success: false }): T {
  if (!result.success) fail("expected a successful result");
  return (result as { readonly data: T }).data;
}

// --- the suite's own schemas --------------------------------------------------------

class Book extends Schema("books", {
  id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(),
  title: t.string(),
  pages: t.integer(),
}) {}

const intRange = defineType<string, string>({
  name: "intRange",
  db: { kind: "custom", sql: "int4range" },
  cast: (input) => (typeof input === "string" ? { success: true, data: input } : { success: false }),
  fromDb: (stored) => stored,
  toDb: (value) => value,
  equal: (a, b) => a === b,
});

class Booking extends Schema("bookings", {
  id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(),
  room: t.integer(),
  during: t.type(intRange),
}) {}

/** Values the database fills: a generated column, one it owns, and defaults the schema does not know. */
class Stamp extends Schema("stamps", {
  id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(),
  label: t.string(),
  code: t.string().writable("never"),
  note: t.string().nullable(),
  madeAt: t.timestamp().dbGenerated(),
}) {}

export function runWriteConformance(profile: WriteConformanceProfile): void {
  describe(`write conformance: ${profile.label}`, () => {
    let handle: TestDatabaseHandle;
    let db: TestDatabase;
    const adapters: DatabaseAdapter[] = [];

    function adapter(options: Partial<MakeWriteAdapterOptions> = {}): DatabaseAdapter {
      const made = profile.makeAdapter(db, { poolMax: options.poolMax ?? 4 });
      adapters.push(made);
      return made;
    }

    const sandboxes: Sandbox[] = [];

    /** A repo whose statements commit: for the tests that need other connections to see them. */
    function committing(options: Partial<RepoOptions> = {}): Repo {
      return createRepo({ adapter: options.adapter ?? adapter(), ...options });
    }

    /** A repo in a sandbox of its own, rolled back after the test. */
    async function repo(options: Partial<RepoOptions> = {}): Promise<Repo> {
      const made = committing(options);
      const sandbox = await createSandbox(made);
      await sandbox.begin();
      sandboxes.push(sandbox);
      return made;
    }

    /** A sandboxed repo and the events of every statement it runs. */
    async function watched(
      options: Partial<RepoOptions> = {},
    ): Promise<{ repo: Repo; events: RepoQueryEvent[] }> {
      const made = await repo(options);
      const events: RepoQueryEvent[] = [];
      made.on("query", (event) => events.push(event));
      return { repo: made, events };
    }

    // The every-type table: one nullable column per round-trip case.
    const typeFields: Record<string, ReturnType<ReturnType<typeof t.type>["nullable"]>> = {};
    const typeCases = ROUND_TRIP_CASES.filter((each) => profile.columnType(each.type) !== undefined);
    typeCases.forEach((each, i) => {
      typeFields[`v${i}`] = t.type(each.type as AnyFieldType).nullable();
    });
    class Everything extends Schema("everything", {
      id: t.integer().primaryKey(),
      ...typeFields,
    }) {}

    beforeAll(async () => {
      handle = await createTestDatabase(profile.server, { label: "write", fixtures: ["blog"] });
      db = handle.db;
      await db.exec(profile.schema);
      const columns = typeCases.map((each, i) => `v${i} ${profile.columnType(each.type)}`);
      await db.exec(`create table everything (id integer primary key, ${columns.join(", ")})`);
    });

    /** Rolls back the test's sandboxes; before DDL on the helper's connection, which their locks would block. */
    async function endSandboxes(): Promise<void> {
      for (const each of sandboxes.splice(0)) await each.rollback();
    }

    afterEach(async () => {
      await endSandboxes();
      for (const each of adapters.splice(0)) {
        // Every connection a test checked out must be back by the time it ends.
        await expectAllReturned(each);
        await each.close();
      }
    });

    afterAll(async () => {
      for (const each of adapters.splice(0)) await each.close();
      const drop = handle === undefined ? undefined : profile.dropCopies?.(handle.db);
      if (drop !== undefined) await handle?.db.exec(drop);
      await handle?.drop();
    });

    async function seedUser(r: Repo, email = "ada@example.com", extra: Record<string, unknown> = {}) {
      return r.insertOrThrow(change(User, { email, ...extra }));
    }

    async function seedPost(r: Repo, authorId: number, title = "Hello", extra: Record<string, unknown> = {}) {
      return r.insertOrThrow(change(Post, { authorId, title, ...extra }));
    }

    // --- insert ---------------------------------------------------------------------

    describe("insert", () => {
      test("writes the changes, the defaults and the timestamps, and returns the generated key", async () => {
        const { repo: r, events } = await watched();
        const result = await r.insert(
          cast(User, { email: "ada@example.com", name: null, password: "correct horse" }, [
            "email",
            "name",
            "password",
          ]),
        );
        const user = ok(result);
        expect(user).toBeInstanceOf(User);
        expect(stateOf(user)).toBe("loaded");
        expect(typeof user.id).toBe("number");
        expect(user.role).toBe("member");
        expect(user.lockVersion).toBe(1);
        expect(user.name).toBeNull();
        expect(user.password).toBe("correct horse");
        expect(user.createdAt).toBeInstanceOf(Date);
        expect(user.updatedAt.getTime()).toBe(user.createdAt.getTime());
        expect(events.map((event) => event.operation)).toEqual(["insert"]);
        expect(events[0]?.source).toBe("users");

        const stored = await r.getOrThrow(User, user.id);
        expect(stored.email).toBe("ada@example.com");
        expect(stored.role).toBe("member");
        expect(stored.name).toBeNull();
        expect(stored.createdAt.getTime()).toBe(user.createdAt.getTime());
        expect(stored.password).toBeUndefined();
      });

      test("an invalid changeset and a missing required field send nothing", async () => {
        const { repo: r, events } = await watched();
        const invalid = await r.insert(cast(User, { email: "" }, ["email"]).validateRequired(["email"]));
        expect(invalid.success).toBe(false);
        if (!invalid.success) expect(invalid.error.action).toBe("insert");
        const missing = await r.insert(cast(User, {}, ["email"]));
        expect(missing.success).toBe(false);
        if (!missing.success) expect(missing.error.errorMessages()).toEqual({ email: ["can't be blank"] });
        expect(events).toEqual([]);
        expect(await r.count(User)).toBe(0);
      });

      test("every type is written and read back", async () => {
        const r = await repo();
        const capabilities = adapter().capabilities;
        // A case that needs a capability the database lacks is written as NULL (its values are
        // refused before they are sent; the adapter suite checks that).
        const valueFor = (each: (typeof typeCases)[number], row: number): unknown =>
          each.requires !== undefined && !capabilities[each.requires]
            ? null
            : each.values[row % each.values.length];
        const longest = Math.max(...typeCases.map((each) => each.values.length));
        for (let row = 0; row < longest; row++) {
          const values: Record<string, unknown> = { id: row + 1 };
          typeCases.forEach((each, i) => {
            values[`v${i}`] = valueFor(each, row);
          });
          await r.insertOrThrow(change(Everything, values as never));
        }
        const stored = (await r.all(from(Everything, "e").orderBy(({ e }) => e.id))) as unknown as Record<
          string,
          unknown
        >[];
        expect(stored).toHaveLength(longest);
        stored.forEach((row, index) => {
          typeCases.forEach((each, i) => {
            const expected = valueFor(each, index);
            const actual = row[`v${i}`];
            if (expected === null) expect(actual, each.label).toBeNull();
            else expect(each.type.equal(actual, expected), `${each.label}: ${String(expected)}`).toBe(true);
          });
        });
      });

      test("a uuid key is generated, and so are the timestamps", async () => {
        const r = await repo();
        const org = await r.insertOrThrow(change(Org, { name: "Acme" }));
        expect(org.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect((await r.getOrThrow(Org, org.id)).name).toBe("Acme");
      });

      test("values the database fills are read back, with returning for the ones the schema cannot know", async () => {
        const r = await repo();
        const plain = await r.insertOrThrow(change(Stamp, { label: "a" }));
        expect(plain.code).toBe("db-code");
        expect(plain.madeAt).toBeInstanceOf(Date);
        // note has a database default the schema does not declare: not read back unless asked,
        // where rows come back from the write itself. Without RETURNING the repo reads the
        // whole row back, note included.
        expect(plain.note).toBe(adapter().capabilities.returning ? null : "db-note");
        expect((await r.getOrThrow(Stamp, plain.id)).note).toBe("db-note");
        const asked = await r.insertOrThrow(change(Stamp, { label: "b" }), { returning: ["note"] });
        expect(asked.note).toBe("db-note");
        const all = await r.insertOrThrow(change(Stamp, { label: "c" }), { returning: true });
        expect(all.note).toBe("db-note");
        // A change to a field the database owns is not written.
        const owned = await r.insertOrThrow(change(Stamp, { label: "d", code: "mine" }));
        expect(owned.code).toBe("db-code");
      });

      test("null is written as NULL, and an explicit null overrides a default", async () => {
        const r = await repo();
        const user = await seedUser(r);
        const post = await r.insertOrThrow(change(Post, { authorId: user.id, title: "t", views: null }));
        expect(post.views).toBeNull();
        expect((await r.getOrThrow(Post, post.id)).views).toBeNull();
      });

      test("prepareChanges functions run before the write, with the repo and action set", async () => {
        const r = await repo();
        let seen: unknown;
        const user = await r.insertOrThrow(
          cast(User, { email: "ada@example.com" }, ["email"]).prepareChanges((cs) => {
            seen = [cs.repo === r, cs.action];
            return cs.putChange("name", "Prepared");
          }),
        );
        expect(seen).toEqual([true, "insert"]);
        expect(user.name).toBe("Prepared");
        expect((await r.getOrThrow(User, user.id)).name).toBe("Prepared");
      });

      test("a per-call database schema decides where the row goes", async (context) => {
        if (profile.copyTableInto === undefined)
          return context.skip("the profile has no database schemas to copy a table into");
        await db.exec(profile.copyTableInto("tenant_w", "tags", db));
        const r = await repo();
        const tag = await r.insertOrThrow(change(Tag, { name: "elsewhere" }), { schema: "tenant_w" });
        expect(meta(Tag).rowMeta("loaded", "tenant_w")).toBe(
          (tag as unknown as Record<symbol, unknown>)[ROW_KEY],
        );
        expect(await r.count(Tag)).toBe(0);
        expect(await r.count(Tag, { schema: "tenant_w" })).toBe(1);
        const renamed = await r.updateOrThrow(change(tag, { name: "moved" }));
        expect((await r.getOrThrow(Tag, renamed.id, { schema: "tenant_w" })).name).toBe("moved");
        await endSandboxes();
      });
    });

    // --- update ---------------------------------------------------------------------

    describe("update", () => {
      test("with no change it sends nothing and returns the row", async () => {
        const { repo: r, events } = await watched();
        const user = await seedUser(r);
        events.splice(0);
        const result = await r.update(cast(user, { email: user.email }, ["email"]));
        expect(ok(result)).toBe(user);
        expect(events).toEqual([]);
      });

      test("writes only the changed columns, and moves updatedAt", async () => {
        const { repo: r, events } = await watched();
        const user = await seedUser(r, "ada@example.com", { name: "Ada", age: 36 });
        events.splice(0);
        const updated = ok(await r.update(cast(user, { name: "Ada L." }, ["name", "age"])));
        expect(events).toHaveLength(1);
        expect(events[0]?.operation).toBe("update");
        // Identifiers are quoted with " or `, by the database.
        expect(events[0]?.sql).toMatch(/["`]name["`]/);
        expect(events[0]?.sql).not.toMatch(/["`]age["`]/);
        expect(events[0]?.sql).not.toMatch(/["`]email["`]/);
        expect(updated.name).toBe("Ada L.");
        expect(updated.age).toBe(36);
        expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(user.updatedAt.getTime());
        expect(updated.createdAt.getTime()).toBe(user.createdAt.getTime());
        const stored = await r.getOrThrow(User, user.id);
        expect(stored.name).toBe("Ada L.");
        expect(stored.age).toBe(36);
      });

      test("force runs the update without changes", async () => {
        const { repo: r, events } = await watched();
        const user = await seedUser(r);
        events.splice(0);
        const forced = ok(await r.update(change(user), { force: true }));
        expect(events).toHaveLength(1);
        expect(forced.updatedAt.getTime()).toBeGreaterThanOrEqual(user.updatedAt.getTime());
      });

      test("a row deleted meanwhile is stale: thrown, allowed, or reported", async () => {
        const r = await repo();
        const user = await seedUser(r);
        await r.deleteAll(from(User, "u"));
        const thrown = await rejection(r.update(change(user, { name: "x" })));
        expect(thrown).toBeInstanceOf(StaleEntryError);
        const allowed = ok(await r.update(change(user, { name: "x" }), { allowStale: true }));
        expect(allowed.name).toBe("x");
        const reported = await r.update(change(user, { name: "x" }), { staleError: { field: "name" } });
        expect(reported.success).toBe(false);
        if (!reported.success) expect(reported.error.errorMessages()).toEqual({ name: ["is stale"] });
      });

      test("an optimistic lock detects a concurrent update", async () => {
        const r = await repo();
        const created = await seedUser(r);
        const mine = await r.getOrThrow(User, created.id);
        const theirs = await r.getOrThrow(User, created.id);
        const first = ok(
          await r.update(cast(theirs, { name: "Theirs" }, ["name"]).optimisticLock("lockVersion")),
        );
        expect(first.lockVersion).toBe(2);
        const late = await rejection(
          r.update(cast(mine, { name: "Mine" }, ["name"]).optimisticLock("lockVersion")),
        );
        expect(late).toBeInstanceOf(StaleEntryError);
        const reported = await r.update(
          cast(mine, { name: "Mine" }, ["name"]).optimisticLock("lockVersion"),
          {
            staleError: { field: "lockVersion", message: "was changed by someone else" },
          },
        );
        expect(reported.success).toBe(false);
        if (!reported.success) {
          expect(reported.error.errorMessages()).toEqual({ lockVersion: ["was changed by someone else"] });
        }
        const stored = await r.getOrThrow(User, created.id);
        expect(stored.name).toBe("Theirs");
        expect(stored.lockVersion).toBe(2);
      });

      test("an unchanged save with an optimistic lock sends nothing and keeps the version", async () => {
        const { repo: r, events } = await watched();
        const created = await seedUser(r, "ada@example.com", { name: "Ada" });
        const mine = await r.getOrThrow(User, created.id);
        const theirs = await r.getOrThrow(User, created.id);
        events.splice(0);
        const saved = ok(await r.update(cast(mine, { name: "Ada" }, ["name"]).optimisticLock("lockVersion")));
        expect(saved).toBe(mine);
        expect(events).toEqual([]);
        const stored = await r.getOrThrow(User, created.id);
        expect(stored.lockVersion).toBe(1);
        expect(stored.updatedAt.getTime()).toBe(mine.updatedAt.getTime());
        // The other open copy is still current: its edit goes through.
        const edited = ok(
          await r.update(cast(theirs, { name: "Ada L." }, ["name"]).optimisticLock("lockVersion")),
        );
        expect(edited.lockVersion).toBe(2);
      });

      test("force with an optimistic lock and no change runs the update and increments the version", async () => {
        const { repo: r, events } = await watched();
        const created = await seedUser(r);
        const mine = await r.getOrThrow(User, created.id);
        const theirs = await r.getOrThrow(User, created.id);
        events.splice(0);
        const forced = ok(await r.update(change(mine).optimisticLock("lockVersion"), { force: true }));
        expect(events).toHaveLength(1);
        expect(forced.lockVersion).toBe(2);
        expect((await r.getOrThrow(User, created.id)).lockVersion).toBe(2);
        const late = await rejection(r.update(change(theirs).optimisticLock("lockVersion"), { force: true }));
        expect(late).toBeInstanceOf(StaleEntryError);
      });

      test("a change a prepare function makes, with an optimistic lock, is written and increments the version", async () => {
        const r = await repo();
        const created = await seedUser(r);
        const mine = await r.getOrThrow(User, created.id);
        const theirs = await r.getOrThrow(User, created.id);
        const saved = ok(
          await r.update(
            change(mine)
              .optimisticLock("lockVersion")
              .prepareChanges((cs) => cs.putChange("name", "Prepared")),
          ),
        );
        expect(saved.name).toBe("Prepared");
        expect(saved.lockVersion).toBe(2);
        const late = await rejection(
          r.update(
            change(theirs)
              .optimisticLock("lockVersion")
              .prepareChanges((cs) => cs.putChange("name", "Late")),
          ),
        );
        expect(late).toBeInstanceOf(StaleEntryError);
        const stored = await r.getOrThrow(User, created.id);
        expect([stored.name, stored.lockVersion]).toEqual(["Prepared", 2]);
      });

      test("a parent with only association changes and an optimistic lock is guarded and incremented", async () => {
        const { repo: r, events } = await watched();
        const created = await seedUser(r);
        const load = () => r.oneOrThrow(from(User, "u").where({ id: created.id }).preload("posts"));
        const mine = await load();
        const theirs = await load();
        const addPost = (user: typeof mine, title: string) =>
          cast(user, { posts: [{ title }] }, ["name"])
            .castAssoc("posts", { with: (post, params) => cast(post, params, ["title"]) })
            .optimisticLock("lockVersion");
        events.splice(0);
        const saved = ok(await r.update(addPost(mine, "First")));
        expect(events.map((event) => event.operation).filter((op) => op !== "transaction")).toEqual([
          "update",
          "insert",
        ]);
        expect(saved.lockVersion).toBe(2);
        expect(saved.posts.map((post) => post.title)).toEqual(["First"]);
        const late = await rejection(r.update(addPost(theirs, "Late")));
        expect(late).toBeInstanceOf(StaleEntryError);
        const stored = await load();
        expect(stored.lockVersion).toBe(2);
        expect(stored.posts.map((post) => post.title)).toEqual(["First"]);
      });

      test("concurrent updates through two adapters: one lock wins", async ({ onTestFinished }) => {
        // Two connections that see each other's commits: no sandbox; the tables are
        // emptied afterwards instead.
        onTestFinished(() => truncateAll(db).then(() => undefined));
        const left = committing();
        const right = committing({ adapter: adapter() });
        const created = await seedUser(left);
        const a = await left.getOrThrow(User, created.id);
        const b = await right.getOrThrow(User, created.id);
        const outcomes = await Promise.allSettled([
          left.update(cast(a, { name: "A" }, ["name"]).optimisticLock("lockVersion")),
          right.update(cast(b, { name: "B" }, ["name"]).optimisticLock("lockVersion")),
        ]);
        const won = outcomes.filter((outcome) => outcome.status === "fulfilled");
        const lost = outcomes.filter((outcome) => outcome.status === "rejected");
        expect(won).toHaveLength(1);
        expect(lost).toHaveLength(1);
        expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(StaleEntryError);
        expect((await left.getOrThrow(User, created.id)).lockVersion).toBe(2);
      });

      test("updateOrThrow throws InvalidChangesetError for an invalid changeset", async () => {
        const r = await repo();
        const user = await seedUser(r);
        const error = await rejection(
          r.updateOrThrow(cast(user, { email: "" }, ["email"]).validateRequired(["email"])),
        );
        expect(error).toBeInstanceOf(InvalidChangesetError);
        expect((error as InvalidChangesetError).changeset.action).toBe("update");
      });
    });

    // --- delete ---------------------------------------------------------------------

    describe("delete", () => {
      test("deletes by key and returns the row in the deleted state", async () => {
        const { repo: r, events } = await watched();
        const user = await seedUser(r);
        events.splice(0);
        const deleted = ok(await r.delete(user));
        expect(stateOf(deleted)).toBe("deleted");
        expect(deleted.email).toBe(user.email);
        expect(events.map((event) => event.operation)).toEqual(["delete"]);
        expect(await r.get(User, user.id)).toBeNull();
        expect(await rejection(r.delete(user))).toBeInstanceOf(StaleEntryError);
        expect(ok(await r.delete(user, { allowStale: true })).email).toBe(user.email);
      });
    });

    describe("insertOrUpdate", () => {
      test("inserts a new record and updates a loaded row, without asking the database first", async () => {
        const { repo: r, events } = await watched();
        const created = ok(await r.insertOrUpdate(cast(User, { email: "ada@example.com" }, ["email"])));
        const renamed = await r.insertOrUpdateOrThrow(cast(created, { name: "Ada" }, ["name"]));
        expect(renamed.id).toBe(created.id);
        expect(renamed.name).toBe("Ada");
        expect(events.map((event) => event.operation)).toEqual(["insert", "update"]);
      });
    });

    describe("telemetry", () => {
      test("a redacted field's value is never in an event's parameters", async () => {
        const r = await repo({ log: { params: true } });
        const events: RepoQueryEvent[] = [];
        r.on("query", (event) => events.push(event));
        const user = await r.insertOrThrow(
          cast(User, { email: "ada@example.com", passwordHash: "s3cret-hash" }, ["email", "passwordHash"]),
        );
        await r.updateOrThrow(cast(user, { passwordHash: "other-hash" }, ["passwordHash"]));
        await r.insertAll(User, [{ email: "b@example.com", passwordHash: "bulk-hash" }]);
        const sent = JSON.stringify(events.map((event) => event.params));
        expect(sent).toContain("**redacted**");
        expect(sent).toContain("ada@example.com");
        expect(sent).not.toContain("s3cret-hash");
        expect(sent).not.toContain("other-hash");
        expect(sent).not.toContain("bulk-hash");
      });
    });

    // --- constraints ----------------------------------------------------------------

    describe("constraints", () => {
      test("a declared unique constraint is a failure on the field", async () => {
        const r = await repo();
        await seedUser(r);
        const result = await r.insert(
          cast(User, { email: "ada@example.com" }, ["email"]).uniqueConstraint("email"),
        );
        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.error.action).toBe("insert");
        expect(result.error.errorMessages()).toEqual({ email: ["has already been taken"] });
        expect(result.error.errors.email?.[0]).toEqual({
          message: "has already been taken",
          constraint: "unique",
          meta: { constraint: "unique", constraintName: "users_email_key" },
        });
      });

      test("an undeclared unique constraint throws with the call to add", async () => {
        const r = await repo();
        await seedUser(r);
        const error = await rejection(r.insert(cast(User, { email: "ada@example.com" }, ["email"])));
        expect(error).toBeInstanceOf(ConstraintError);
        expect((error as ConstraintError).message).toBe(
          undeclared(
            'unique constraint "users_email_key" violated on insert into "users".',
            'The changeset has not defined this constraint. Add: .uniqueConstraint("email")',
            '(or .uniqueConstraint("email", { name: "users_email_key" }))',
          ),
        );
        expect((error as ConstraintError).constraint).toBe("users_email_key");
        expect((error as ConstraintError).message).not.toContain("ada@example.com");
      });

      test("an undeclared unique constraint on update says so", async () => {
        const r = await repo();
        await seedUser(r, "ada@example.com");
        const grace = await seedUser(r, "grace@example.com");
        const error = await rejection(r.update(cast(grace, { email: "ada@example.com" }, ["email"])));
        expect((error as ConstraintError).message).toMatch(
          /^constraint\.undeclared: unique constraint "users_email_key" violated on update of "users"\. /,
        );
        const handled = await r.update(
          cast(grace, { email: "ada@example.com" }, ["email"]).uniqueConstraint("email"),
        );
        expect(handled.success).toBe(false);
      });

      test("a constraint matched by suffix or prefix, with its own message and key", async () => {
        const r = await repo();
        await seedUser(r);
        const suffix = await r.insert(
          cast(User, { email: "ada@example.com" }, ["email"]).uniqueConstraint("email", {
            name: "_email_key",
            match: "suffix",
            message: "is registered",
            errorKey: "login",
          }),
        );
        if (suffix.success) fail("expected a failure");
        expect(suffix.error.errorMessages()).toEqual({ login: ["is registered"] });
        const prefix = await r.insert(
          cast(User, { email: "ada@example.com" }, ["email"]).uniqueConstraint("email", {
            name: "users_",
            match: "prefix",
          }),
        );
        expect(prefix.success).toBe(false);
        const other = await rejection(
          r.insert(
            cast(User, { email: "ada@example.com" }, ["email"]).uniqueConstraint("email", {
              name: "uq_other",
            }),
          ),
        );
        expect(other).toBeInstanceOf(ConstraintError);
        expect((other as ConstraintError).message).toContain('.uniqueConstraint("email")');
      });

      /**
       * Where a foreign-key violation names no constraint, nothing declared can match it: the
       * write throws a ConstraintError of type foreignKey (checked), and the test ends there.
       */
      async function unnamedForeignKey(write: () => Promise<unknown>): Promise<boolean> {
        if (adapter().capabilities.foreignKeyNames) return false;
        const error = await rejection(write());
        expect(error).toBeInstanceOf(ConstraintError);
        expect(error).toMatchObject({ type: "foreignKey", constraint: undefined });
        return true;
      }

      test("a foreign key: declared on the field, on the association, and not at all", async (context) => {
        const r = await repo();
        const missing = cast(Post, { authorId: 999, title: "Orphan" }, ["authorId", "title"]);
        if (await unnamedForeignKey(() => r.insert(missing.foreignKeyConstraint("authorId")))) {
          return context.skip("capability foreignKeyNames is false");
        }
        const onField = await r.insert(missing.foreignKeyConstraint("authorId"));
        if (onField.success) fail("expected a failure");
        expect(onField.error.errorMessages()).toEqual({ authorId: ["does not exist"] });
        const onAssoc = await r.insert(missing.assocConstraint("author"));
        if (onAssoc.success) fail("expected a failure");
        expect(onAssoc.error.errorMessages()).toEqual({ author: ["does not exist"] });
        const thrown = await rejection(r.insert(missing));
        expect((thrown as ConstraintError).message).toBe(
          undeclared(
            'foreign-key constraint "posts_author_id_fkey" violated on insert into "posts".',
            'The changeset has not defined this constraint. Add: .foreignKeyConstraint("authorId")',
            '(or .foreignKeyConstraint("authorId", { name: "posts_author_id_fkey" }))',
          ),
        );
      });

      test("deleting a parent that still has children: noAssocConstraint, or the message", async (context) => {
        const r = await repo();
        const user = await seedUser(r);
        await seedPost(r, user.id);
        if (await unnamedForeignKey(() => r.delete(change(user).noAssocConstraint("posts")))) {
          return context.skip("capability foreignKeyNames is false");
        }
        const handled = await r.delete(change(user).noAssocConstraint("posts"));
        if (handled.success) fail("expected a failure");
        expect(handled.error.action).toBe("delete");
        expect(handled.error.errorMessages()).toEqual({ posts: ["is still associated with this entry"] });
        const thrown = await rejection(r.delete(user));
        expect((thrown as ConstraintError).message).toBe(
          undeclared(
            'foreign-key constraint "posts_author_id_fkey" violated on delete from "users".',
            'The changeset has not defined this constraint. Add: .noAssocConstraint("posts")',
            '(or .noAssocConstraint("posts", { name: "posts_author_id_fkey" }))',
          ),
        );
        expect(await r.get(User, user.id)).not.toBeNull();
      });

      test("a check constraint", async () => {
        const r = await repo();
        const thin = cast(Book, { title: "Empty", pages: 0 }, ["title", "pages"]);
        const handled = await r.insert(
          thin.checkConstraint("pages", { name: "books_pages_check", message: "must be positive" }),
        );
        if (handled.success) fail("expected a failure");
        expect(handled.error.errorMessages()).toEqual({ pages: ["must be positive"] });
        const thrown = await rejection(r.insert(thin));
        expect((thrown as ConstraintError).message).toBe(
          undeclared(
            'check constraint "books_pages_check" violated on insert into "books".',
            'The changeset has not defined this constraint. Add: .checkConstraint("pages", { name: "books_pages_check" })',
          ),
        );
      });

      test("an exclusion constraint", async (context) => {
        // A declared DDL feature: the migration table's `features.exclusionConstraints`.
        if (!migrationDialectOf(adapter().dialect).features.exclusionConstraints) {
          expect(profile.rangeType).toBeUndefined();
          return context.skip("feature exclusionConstraints of the migration table is false");
        }
        const r = await repo();
        await r.insertOrThrow(change(Booking, { room: 1, during: "[1,5)" }));
        const overlap = cast(Booking, { room: 1, during: "[3,8)" }, ["room", "during"]);
        const handled = await r.insert(overlap.exclusionConstraint("during"));
        if (handled.success) fail("expected a failure");
        expect(handled.error.errorMessages()).toEqual({ during: ["violates an exclusion constraint"] });
        const thrown = await rejection(r.insert(overlap));
        expect((thrown as ConstraintError).message).toBe(
          undeclared(
            'exclusion constraint "bookings_during_excl" violated on insert into "bookings".',
            'The changeset has not defined this constraint. Add: .exclusionConstraint("during")',
            '(or .exclusionConstraint("during", { name: "bookings_during_excl" }))',
          ),
        );
      });

      test("only one constraint error is reported per attempt", async (context) => {
        const r = await repo();
        await seedUser(r);
        const attempt = () =>
          r.insert(
            cast(Post, { authorId: 999, title: "x" }, ["authorId", "title"])
              .foreignKeyConstraint("authorId")
              .uniqueConstraint("title", { name: "posts_title_key" }),
          );
        if (await unnamedForeignKey(attempt)) return context.skip("capability foreignKeyNames is false");
        const result = await attempt();
        if (result.success) fail("expected a failure");
        expect(Object.keys(result.error.errors)).toEqual(["authorId"]);
      });
    });

    // --- onConflict -----------------------------------------------------------------

    describe("onConflict", () => {
      test('"nothing" inserts nothing on a conflict and returns null', async () => {
        const r = await repo();
        await seedUser(r, "ada@example.com", { name: "Ada" });
        const result = await r.insert(
          cast(User, { email: "ada@example.com", name: "Other" }, ["email", "name"]),
          {
            onConflict: "nothing",
          },
        );
        expect(result).toEqual({ success: true, data: null });
        expect(
          await r.insertOrThrow(change(User, { email: "ada@example.com" }), { onConflict: "nothing" }),
        ).toBeNull();
        const fresh = await r.insertOrThrow(change(User, { email: "new@example.com" }), {
          onConflict: "nothing",
        });
        expect(fresh?.email).toBe("new@example.com");
        expect((await r.getByOrThrow(User, { email: "ada@example.com" })).name).toBe("Ada");
      });

      test("update all, a list of fields, or all except some, on a field target", async () => {
        const r = await repo();
        // A database that takes no conflict target (MySQL) updates on any unique key.
        const target = adapter().capabilities.conflictTarget ? { target: ["email" as const] } : {};
        const ada = await seedUser(r, "ada@example.com", { name: "Ada", age: 36 });
        const all = await r.insertOrThrow(change(User, { email: "ada@example.com", name: "All", age: 1 }), {
          onConflict: { ...target, update: "all" },
        });
        expect(all.id).toBe(ada.id);
        expect([all.name, all.age]).toEqual(["All", 1]);
        const listed = await r.insertOrThrow(
          change(User, { email: "ada@example.com", name: "Listed", age: 2 }),
          {
            onConflict: { ...target, update: ["name"] },
          },
        );
        // The whole row is read back: age keeps the stored value.
        expect([listed.name, listed.age]).toEqual(["Listed", 1]);
        const except = await r.insertOrThrow(
          change(User, { email: "ada@example.com", name: "Except", age: 3 }),
          {
            onConflict: { ...target, update: { except: ["createdAt", "age"] } },
          },
        );
        expect([except.name, except.age]).toEqual(["Except", 1]);
        expect(except.createdAt.getTime()).toBe(listed.createdAt.getTime());
        expect(except.updatedAt.getTime()).toBeGreaterThanOrEqual(listed.updatedAt.getTime());
        expect(await r.count(User)).toBe(1);
      });

      test("a constraint target and a fragment target", async (context) => {
        const r = await repo();
        const capabilities = adapter().capabilities;
        await seedUser(r, "ada@example.com", { name: "Ada" });
        const byName = () =>
          r.insertOrThrow(change(User, { email: "ada@example.com", name: "Named" }), {
            onConflict: { target: { constraint: "users_email_key" }, update: ["name"] },
          });
        if (!capabilities.conflictTarget) {
          // Any target is refused when the insert is compiled (capability conflictTarget).
          await expect(byName()).rejects.toThrow(QueryError);
          return context.skip("capability conflictTarget is false");
        }
        if (capabilities.conflictConstraint) {
          expect((await byName()).name).toBe("Named");
        } else {
          // A constraint target is refused when the insert is compiled (capability conflictConstraint).
          await expect(byName()).rejects.toThrow(QueryError);
        }
        const fragmentTarget = await r.insertOrThrow(
          change(User, { email: "ada@example.com", name: "Fragment" }),
          {
            onConflict: { target: fragment`(email)`, update: ["name"] },
          },
        );
        expect(fragmentTarget.name).toBe("Fragment");
        expect(await r.count(User)).toBe(1);
      });

      test("an update without a target is refused before anything is sent", async (context) => {
        const { repo: r, events } = await watched();
        const write = () =>
          r.insert(change(User, { email: "ada@example.com" }), { onConflict: { update: "all" } });
        if (!adapter().capabilities.conflictTarget) {
          // Without targets, an update without one is the only form, and is accepted.
          expect((await write()).success).toBe(true);
          return context.skip("capability conflictTarget is false");
        }
        const error = await rejection(write());
        expect(error).toBeInstanceOf(QueryError);
        expect(events).toEqual([]);
      });
    });

    // --- insertAll ------------------------------------------------------------------

    describe("insertAll", () => {
      test("one row, with defaults and timestamps, and its rows back", async () => {
        const { repo: r, events } = await watched();
        let user: User | undefined;
        if (adapter().capabilities.returning) {
          const { count, rows } = await r.insertAll(User, [{ email: "ada@example.com" }], {
            returning: true,
          });
          expect(count).toBe(1);
          expect(events.map((event) => event.operation)).toEqual(["insertAll"]);
          [user] = rows;
        } else {
          // Rows come back only through RETURNING: asking for them is refused (capability
          // returning), and the row is read instead.
          await expect(
            r.insertAll(User, [{ email: "ada@example.com" }], { returning: true }),
          ).rejects.toThrow(QueryError);
          expect(await r.insertAll(User, [{ email: "ada@example.com" }])).toEqual({ count: 1, rows: null });
          expect(events.map((event) => event.operation)).toEqual(["insertAll"]);
          user = await r.getByOrThrow(User, { email: "ada@example.com" });
        }
        expect(user).toBeInstanceOf(User);
        expect(isRow(user)).toBe(true);
        expect(user?.role).toBe("member");
        expect(user?.lockVersion).toBe(1);
        expect(user?.createdAt).toBeInstanceOf(Date);
        expect(user?.updatedAt.getTime()).toBe(user?.createdAt.getTime());
      });

      test("without returning, rows is null; with a list, plain objects of those fields", async () => {
        const r = await repo();
        expect(await r.insertAll(Tag, [{ name: "a" }, { name: "b" }])).toEqual({ count: 2, rows: null });
        expect(await r.insertAll(Tag, [])).toEqual({ count: 0, rows: null });
        if (!adapter().capabilities.returning) {
          await expect(r.insertAll(Tag, [{ name: "c" }], { returning: ["name"] })).rejects.toThrow(
            QueryError,
          );
          return;
        }
        const listed = await r.insertAll(Tag, [{ name: "c" }], { returning: ["name"] });
        expect(listed).toEqual({ count: 1, rows: [{ name: "c" }] });
      });

      test("ragged rows share one column list; a field left out gets the database default", async (context) => {
        const r = await repo();
        const capabilities = adapter().capabilities;
        const user = await seedUser(r);
        const ragged = [
          { authorId: user.id, title: "with body", body: "text" },
          { authorId: user.id, title: "without body" },
        ];
        if (!capabilities.defaultInValues) {
          // Refused before anything is sent, naming the row and the field (capability defaultInValues).
          await expect(r.insertAll(Post, ragged)).rejects.toThrow(/row 1 has no value for Post\.body/);
          return context.skip("capability defaultInValues is false");
        }
        const rows = capabilities.returning
          ? (await r.insertAll(Post, ragged, { returning: true })).rows
          : await r.insertAll(Post, ragged).then(() => r.all(from(Post, "p").orderBy(({ p }) => p.id)));
        expect(rows.map((post) => post.body)).toEqual(["text", null]);
        expect(rows.map((post) => post.published)).toEqual([false, false]);
      });

      test("ten thousand rows go in chunks under the parameter limit, in one transaction", async () => {
        const { repo: r, events } = await watched();
        const people = Array.from({ length: 10_000 }, (_, i) => ({
          email: `user${i}@example.com`,
          age: i % 90,
        }));
        const { count } = await r.insertAll(User, people);
        expect(count).toBe(10_000);
        expect(events.length).toBeGreaterThan(1);
        expect(events.every((event) => event.paramCount <= 65_535)).toBe(true);
        expect(await r.count(User)).toBe(10_000);

        // A conflict in the last chunk rolls every chunk back.
        const again = Array.from({ length: 10_000 }, (_, i) => ({ email: `again${i}@example.com` }));
        again[9_999] = { email: "user0@example.com" };
        expect(await rejection(r.insertAll(User, again))).toBeInstanceOf(ConstraintError);
        expect(await r.count(User)).toBe(10_000);
      });

      test("values may be expressions, subqueries and placeholders", async () => {
        const r = await repo();
        const user = await seedUser(r);
        const when = new Date("2026-05-01T12:00:00.000Z");
        const values = [
          {
            authorId: scalar(
              from(User, "u")
                .where({ email: "ada@example.com" })
                .select(({ u }) => u.id),
            ).as<number>(),
            title: "by subquery",
            publishedAt: param("when", t.timestamp()),
          },
          { authorId: user.id, title: "by expression", publishedAt: now() },
        ];
        // Without RETURNING the rows are read back.
        const rows = adapter().capabilities.returning
          ? (
              await r.insertAll(Post, values, {
                returning: ["authorId", "publishedAt"],
                placeholders: { when },
              })
            ).rows
          : await r.insertAll(Post, values, { placeholders: { when } }).then(() =>
              r.all(
                from(Post, "p")
                  .orderBy(({ p }) => p.id)
                  .select(({ p }) => ({ authorId: p.authorId, publishedAt: p.publishedAt })),
              ),
            );
        expect(rows[0]).toEqual({ authorId: user.id, publishedAt: when });
        expect(rows[1]?.authorId).toBe(user.id);
        expect(rows[1]?.publishedAt).toBeInstanceOf(Date);
      });

      test("onConflict nothing counts only the rows inserted", async () => {
        const r = await repo();
        await r.insertAll(Tag, [{ name: "a" }]);
        const { count } = await r.insertAll(Tag, [{ name: "a" }, { name: "b" }], { onConflict: "nothing" });
        expect(count).toBe(1);
      });

      test("from a query: INSERT … SELECT", async () => {
        const r = await repo();
        await r.insertAll(Tag, [{ name: "one" }, { name: "two" }]);
        const user = await seedUser(r);
        const source = from(Tag, "g").select(({ g }) => ({
          title: g.name,
          authorId: val(user.id, t.bigint({ mode: "number" })),
        }));
        // Without RETURNING the rows are read back.
        const { count, rows } = adapter().capabilities.returning
          ? await r.insertAll(Post, source, { returning: ["title", "authorId"] })
          : await r.insertAll(Post, source).then(async ({ count: inserted }) => ({
              count: inserted,
              rows: await r.all(
                from(Post, "p").select(({ p }) => ({ title: p.title, authorId: p.authorId })),
              ),
            }));
        expect(count).toBe(2);
        expect(rows.map((row) => `${row.title} ${row.authorId}`).sort()).toEqual([
          `one ${user.id}`,
          `two ${user.id}`,
        ]);
        const plain = await rejection(
          r.insertAll(
            Post,
            from(Tag, "g").select(({ g }) => ({ title: g.name, authorId: user.id })),
          ),
        );
        expect(plain).toBeInstanceOf(QueryError);
      });
    });

    // --- updateAll and deleteAll ------------------------------------------------------

    describe("updateAll", () => {
      test("set literals, arithmetic and array changes, with returning", async () => {
        const r = await repo();
        const user = await seedUser(r);
        await seedPost(r, user.id, "a", { views: 1, tagList: ["x", "y"] });
        await seedPost(r, user.id, "b", { views: 5, tagList: ["y"] });
        const literal = await r.updateAll(from(Post, "p").where({ title: "a" }).set({ published: true }));
        expect(literal).toEqual({ count: 1, rows: null });
        const capabilities = adapter().capabilities;
        if (!capabilities.arrays) {
          // The array changes are refused when compiled (capability arrays); arithmetic is not.
          await expect(
            r.updateAll(from(Post, "p").set(({ p }) => ({ tagList: p.tagList.append("z") }))),
          ).rejects.toThrow(QueryError);
          await expect(
            r.updateAll(from(Post, "p").set(({ p }) => ({ tagList: p.tagList.remove("y") }))),
          ).rejects.toThrow(QueryError);
          const added = r.updateAll(
            from(Post, "p")
              .set(({ p }) => ({ views: p.views.add(10) }))
              .returning(({ p }) => ({ title: p.title, views: p.views })),
          );
          if (capabilities.returning) {
            const { count, rows } = await added;
            expect(count).toBe(2);
            expect(rows?.sort((x, y) => x.title.localeCompare(y.title))).toEqual([
              { title: "a", views: 11 },
              { title: "b", views: 15 },
            ]);
          } else {
            // RETURNING on a bulk write is refused when compiled (capability returning).
            await expect(added).rejects.toThrow(QueryError);
            expect(await r.updateAll(from(Post, "p").set(({ p }) => ({ views: p.views.add(10) })))).toEqual({
              count: 2,
              rows: null,
            });
          }
          const stored = await r.all(from(Post, "p").orderBy(({ p }) => p.title));
          expect(stored.map((post) => [post.published, post.views, post.tagList])).toEqual([
            [true, 11, ["x", "y"]],
            [false, 15, ["y"]],
          ]);
          return;
        }
        const { count, rows } = await r.updateAll(
          from(Post, "p")
            .set(({ p }) => ({ views: p.views.add(10), tagList: p.tagList.append("z") }))
            .returning(({ p }) => ({ title: p.title, views: p.views, tags: p.tagList })),
        );
        expect(count).toBe(2);
        expect(rows?.sort((x, y) => x.title.localeCompare(y.title))).toEqual([
          { title: "a", views: 11, tags: ["x", "y", "z"] },
          { title: "b", views: 15, tags: ["y", "z"] },
        ]);
        await r.updateAll(from(Post, "p").set(({ p }) => ({ tagList: p.tagList.remove("y") })));
        const stored = await r.all(from(Post, "p").orderBy(({ p }) => p.title));
        expect(stored.map((post) => [post.published, post.tagList])).toEqual([
          [true, ["x", "z"]],
          [false, ["z"]],
        ]);
      });

      test("a query without set is refused", async () => {
        const r = await repo();
        expect(await rejection(r.updateAll(from(Post, "p")))).toBeInstanceOf(QueryError);
      });
    });

    describe("deleteAll", () => {
      test("with a join, and unfiltered", async () => {
        const { repo: r, events } = await watched();
        const ada = await seedUser(r, "ada@example.com");
        const grace = await seedUser(r, "grace@example.com");
        const post = await seedPost(r, ada.id);
        await seedPost(r, grace.id);
        await r.insertAll(Comment, [
          { postId: post.id, body: "on ada's post" },
          { postId: post.id, body: "another" },
        ]);
        events.splice(0);
        const capabilities = adapter().capabilities;
        const graces = from(Post, "p")
          .join(User, "u", ({ p, u }) => p.authorId.eq(u.id))
          .where(({ u }) => u.email.eq("grace@example.com"));
        if (!capabilities.updateJoin) {
          // A join in deleteAll is refused when compiled (capability updateJoin); a subquery does it.
          await expect(r.deleteAll(graces)).rejects.toThrow(QueryError);
          const bySubquery = await r.deleteAll(
            from(Post, "p").where(({ p }) =>
              p.authorId.in(
                from(User, "u")
                  .where(({ u }) => u.email.eq("grace@example.com"))
                  .select(({ u }) => u.id),
              ),
            ),
          );
          expect(bySubquery.count).toBe(1);
        } else if (!capabilities.returning) {
          // RETURNING on a bulk write is refused when compiled (capability returning).
          await expect(r.deleteAll(graces.returning(({ p }) => ({ id: p.id })))).rejects.toThrow(QueryError);
          expect(await r.deleteAll(graces)).toEqual({ count: 1, rows: null });
        } else {
          const joined = await r.deleteAll(graces.returning(({ p }) => ({ id: p.id })));
          expect(joined.count).toBe(1);
          expect(joined.rows).toHaveLength(1);
        }
        expect(events.map((event) => event.operation)).toEqual(["deleteAll"]);
        expect(await r.deleteAll(Comment)).toEqual({ count: 2, rows: null });
        expect(await r.count(Post)).toBe(1);
      });
    });

    // --- validateUniqueAsync ----------------------------------------------------------

    describe("validateUniqueAsync", () => {
      test("adds has already been taken for another row with the value, not for the row itself", async () => {
        const r = await repo();
        const ada = await seedUser(r, "ada@example.com");
        const taken = await cast(User, { email: "ada@example.com" }, ["email"]).validateUniqueAsync(
          "email",
          r,
        );
        expect(taken.errors.email?.[0]).toMatchObject({
          message: "has already been taken",
          validation: "uniqueAsync",
        });
        const free = await cast(User, { email: "new@example.com" }, ["email"]).validateUniqueAsync(
          "email",
          r,
        );
        expect(free.valid).toBe(true);
        // The stored row now has name "x"; the loaded copy does not, so name is a change.
        // The query then matches ada's own row, which the key exclusion must leave out.
        await r.updateAll(from(User, "u").where({ id: ada.id }).set({ name: "x" }));
        const own = await change(ada, { name: "x" }).validateUniqueAsync(["email", "name"], r);
        expect(own.valid).toBe(true);
        // Another row with the same values is found.
        const other = await change(User, { email: "ada@example.com", name: "x" }).validateUniqueAsync(
          ["email", "name"],
          r,
        );
        expect(other.valid).toBe(false);
      });

      test("a row is looked for in the database schema it was read from", async (context) => {
        if (profile.copyTableInto === undefined)
          return context.skip("the profile has no database schemas to copy a table into");
        await db.exec(profile.copyTableInto("tenant_u", "tags", db));
        try {
          const r = await repo();
          await r.insertAll(Tag, [{ name: "dup" }, { name: "mine" }], { schema: "tenant_u" });
          const mine = await r.getByOrThrow(Tag, { name: "mine" }, { schema: "tenant_u" });
          const checked = await change(mine, { name: "dup" }).validateUniqueAsync("name", r);
          expect(checked.valid).toBe(false);
          expect(await r.count(Tag)).toBe(0);
        } finally {
          await endSandboxes();
        }
      });
    });

    // --- option A in insertAll ---------------------------------------------------------

    describe("insertAll values typed by their column", () => {
      const uuid = "0190d8a0-0000-7000-8000-0000000000ab";
      const other = "0190d8a0-0000-7000-8000-0000000000ac";
      test("a CASE or coalesce of bound values goes into a uuid column", async () => {
        const r = await repo();
        await r.insertAll(Org, [
          { id: caseWhen(val(true), uuid).else(null).as<string>(), name: "case" },
          { id: coalesce(val(null as string | null), val(other)).as<string>(), name: "coalesce" },
        ]);
        expect((await r.getOrThrow(Org, uuid)).name).toBe("case");
        expect((await r.getOrThrow(Org, other)).name).toBe("coalesce");
      });

      test("and so in the select of INSERT … SELECT", async () => {
        const r = await repo();
        await r.insertAll(Tag, [{ name: "from tag" }]);
        const { count } = await r.insertAll(
          Org,
          from(Tag, "g").select(({ g }) => ({
            id: coalesce(val(null as string | null), val(uuid)),
            name: g.name,
          })),
        );
        expect(count).toBe(1);
        expect((await r.getOrThrow(Org, uuid)).name).toBe("from tag");
      });
    });

    // --- shortened constraint names ------------------------------------------------------

    describe("a default constraint name the database shortened", () => {
      class Wide extends Schema("ver_table_with_a_very_long_name_for_tests", {
        id: t.integer().primaryKey(),
        someExtremelyLongColumnNameNumberOne: t.string(),
        anotherColumnNameThatIsLong: t.string(),
      }) {}

      test("still matches the declaration made with the default name", async (context) => {
        if (!adapter().capabilities.longIdentifiers)
          return context.skip("capability longIdentifiers is false");
        await db.exec(
          "create table if not exists ver_table_with_a_very_long_name_for_tests (id integer primary key, some_extremely_long_column_name_number_one text not null, another_column_name_that_is_long text not null, unique (some_extremely_long_column_name_number_one, another_column_name_that_is_long))",
        );
        const r = await repo();
        const values = { someExtremelyLongColumnNameNumberOne: "a", anotherColumnNameThatIsLong: "b" };
        await r.insertOrThrow(change(Wide, { id: 1, ...values }));
        const result = await r.insert(
          change(Wide, { id: 2, ...values }).uniqueConstraint([
            "someExtremelyLongColumnNameNumberOne",
            "anotherColumnNameThatIsLong",
          ]),
        );
        if (result.success) fail("expected a failure");
        expect(result.error.errorMessages()).toEqual({
          someExtremelyLongColumnNameNumberOne: ["has already been taken"],
        });
      });
    });

    // --- budgets ------------------------------------------------------------------------

    describe("timeoutMs and signal", () => {
      test("timeoutMs is one budget for every chunk of an insertAll", async () => {
        const r = await repo();
        const user = await seedUser(r);
        // A value of 400 bound parameters, so that 200 rows take two statements. Where a
        // running statement can be cancelled, the first and the last row sleep 0.6 s, so each
        // statement alone fits a 1 s budget and the second is stopped while it runs. Where it
        // cannot (capability cancel false), the first statement overruns the budget and the
        // second must be refused before it starts.
        const cancels = adapter().capabilities.cancel;
        const wide = (seconds: number) => {
          const one = () => val(1, t.integer());
          let sum = one();
          for (let i = 0; i < 399; i++) sum = sum.add(one());
          return seconds > 0 ? sum.add(profile.sleep(seconds)) : sum;
        };
        const rows = Array.from({ length: 200 }, (_, i) => ({
          authorId: user.id,
          title: `p${i}`,
          views: wide(i === 0 ? (cancels ? 0.6 : 1.2) : i === 199 && cancels ? 0.6 : 0),
        }));
        const started = Date.now();
        const error = await rejection(r.insertAll(Post, rows, { timeoutMs: 1_000 }));
        expect((error as Error).message, String((error as Error).message)).toContain("timeoutMs (1000 ms)");
        expect((error as DatabaseError).code).toBe("timeout");
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(await r.count(Post)).toBe(0);
      });

      test("an aborted signal stops a write", async () => {
        const r = await repo();
        const controller = new AbortController();
        controller.abort();
        const error = await rejection(
          r.insert(change(User, { email: "ada@example.com" }), { signal: controller.signal }),
        );
        expect(error).toBeInstanceOf(DatabaseError);
        expect((error as DatabaseError).code).toBe("aborted");
        const many = Array.from({ length: 10_000 }, (_, i) => ({ email: `u${i}@example.com`, age: 1 }));
        const bulk = await rejection(r.insertAll(User, many, { signal: controller.signal }));
        expect((bulk as DatabaseError).code).toBe("aborted");
        expect(await r.count(User)).toBe(0);
      });
    });
  });
}

const ROW_KEY = Symbol.for("egon.row");
