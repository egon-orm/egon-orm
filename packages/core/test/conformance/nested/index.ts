// The nested-write conformance suite: what nested changesets and embeds must do against a
// real database, written once and run by each dialect package with a profile of its own.
// It covers each association kind inserted and updated through its parent, every
// replacement mode checked in the database, the order rows are written in, many-to-many
// join rows, rollback when a child fails (nothing left behind), three levels deep, nested
// writes inside a transaction, and embeds stored, read back and queried.
//
// One database per run of the suite, over the blog fixture plus the profile's tables;
// every table is emptied before each test.
import {
  type AnySchema,
  type AssocKeys,
  belongsTo,
  buildAssoc,
  CastError,
  type Changeset,
  ConstraintError,
  cast,
  change,
  createBatch,
  createRepo,
  type DatabaseAdapter,
  DatabaseError,
  EmbeddedSchema,
  from,
  hasMany,
  hasOne,
  isLoaded,
  isRow,
  type Loaded,
  manyToMany,
  QueryError,
  type Repo,
  type RepoQueryEvent,
  type Row,
  Schema,
  stateOf,
  success,
  t,
} from "egon-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  createTestDatabase,
  type TestDatabase,
  type TestDatabaseHandle,
  truncateAll,
} from "../../support/index.js";
import { expectAllReturned } from "../../support/leaks.js";
import type { NestedConformanceProfile } from "./profile.js";

export type { NestedConformanceProfile } from "./profile.js";

function fail(message: string): never {
  throw new Error(message);
}

/** The data of a successful result, failing the test otherwise. */
function ok<T>(result: { readonly success: true; readonly data: T } | { readonly success: false }): T {
  if (!result.success) fail("expected a successful result");
  return (result as { readonly data: T }).data;
}

/** Narrows a row to one with association `name` loaded, failing the test otherwise. */
function assertLoaded<S extends AnySchema, R extends Row<S>, const K extends AssocKeys<S>>(
  schema: S,
  row: R,
  name: K,
): asserts row is R & Loaded<S, K> {
  if (!isLoaded(schema, row, name)) fail(`expected ${name} to be loaded`);
}

/** The error of a failed result, failing the test otherwise. */
function failed<E>(result: { readonly success: false; readonly error: E } | { readonly success: true }): E {
  if (result.success) fail("expected a failure");
  return (result as { readonly error: E }).error;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

// --- the suite's own schemas, over the blog tables and the profile's -----------------

class Writer extends Schema("users", {
  id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(),
  email: t.string(),
  name: t.string().nullable(),
}) {
  static posts = hasMany(() => Article, { foreignKey: "authorId", onReplace: "delete", orderBy: ["id"] });
  static profile = hasOne(() => Bio, { foreignKey: "userId", onReplace: "delete" });
  static remarks = hasMany(() => Remark, { foreignKey: "authorId", onReplace: "setNull", orderBy: ["id"] });
  static teams = manyToMany(() => Team, {
    joinThrough: () => Seat,
    joinKeys: { owner: "userId", target: "orgId" },
    onReplace: "delete",
  });

  static changeset(writer: Writer | typeof Writer, params: unknown) {
    return cast(writer, params, ["email", "name"]).validateRequired(["email"]);
  }
}

class Bio extends Schema("profiles", {
  id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(),
  userId: t.bigint({ mode: "number" }),
  bio: t.string().nullable(),
}) {
  static changeset(bio: Bio | typeof Bio, params: unknown) {
    return cast(bio, params, ["bio"]);
  }
}

class Article extends Schema("posts", {
  id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(),
  authorId: t.bigint({ mode: "number" }),
  title: t.string(),
}) {
  static author = belongsTo(() => Writer, { foreignKey: "authorId", onReplace: "update" });
  static remarks = hasMany(() => Remark, { foreignKey: "postId", onReplace: "delete", orderBy: ["id"] });
  static labels = manyToMany(() => Label, {
    joinThrough: "posts_tags",
    joinKeys: { owner: "post_id", target: "tag_id" },
    onReplace: "delete",
    unique: true,
  });

  static changeset(article: Article | typeof Article, params: unknown) {
    return cast(article, params, ["title", "authorId"]).validateRequired(["title"]);
  }
}

class Remark extends Schema("comments", {
  id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(),
  postId: t.bigint({ mode: "number" }),
  authorId: t.bigint({ mode: "number" }).nullable(),
  body: t.string(),
}) {
  static post = belongsTo(() => Article, { foreignKey: "postId" });

  static changeset(remark: Remark | typeof Remark, params: unknown) {
    return cast(remark, params, ["body"]).validateRequired(["body"]).validateLength("body", { min: 2 });
  }
}

class Label extends Schema("tags", {
  id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(),
  name: t.string().nullable(),
}) {
  static changeset(label: Label | typeof Label, params: unknown) {
    return cast(label, params, ["name"]).uniqueConstraint("name", { name: "tags_name_key" });
  }
}

class Team extends Schema("orgs", {
  id: t.uuid().primaryKey().autogenerate(),
  name: t.string(),
}) {}

class Seat extends Schema("memberships", {
  orgId: t.uuid().primaryKey(),
  userId: t.bigint({ mode: "number" }).primaryKey(),
  role: t.enum(["owner", "admin", "member"]).default("member"),
}) {}

class Order extends Schema("orders", {
  id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(),
  customer: t.string(),
}) {
  static items = hasMany(() => LineItem, {
    foreignKey: "orderId",
    onReplace: "deleteIfExists",
    orderBy: ["id"],
  });
}

class LineItem extends Schema("line_items", {
  id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(),
  orderId: t.bigint({ mode: "number" }),
  sku: t.string(),
  qty: t.integer(),
}) {
  static changeset(item: LineItem | typeof LineItem, params: unknown) {
    return cast(item, params, ["sku", "qty"]).checkConstraint("qty", {
      name: "line_items_qty_check",
      message: "must be positive",
    });
  }
}

class Street extends EmbeddedSchema({
  line: t.string(),
  city: t.string(),
  postCode: t.string().nullable(),
}) {
  static changeset(street: Street | typeof Street, params: unknown) {
    return cast(street, params, ["line", "city", "postCode"]).validateRequired(["line", "city"]);
  }
}

class Phone extends EmbeddedSchema({
  id: t.uuid().primaryKey().autogenerate(),
  label: t.string(),
  digits: t.string(),
  verifiedAt: t.timestamp().nullable(),
}) {
  static changeset(phone: Phone | typeof Phone, params: unknown) {
    return cast(phone, params, ["label", "digits", "verifiedAt"]).validateRequired(["label", "digits"]);
  }
}

class Point extends EmbeddedSchema({ lat: t.float(), lng: t.float() }) {}

class Card extends EmbeddedSchema({
  holder: t.string(),
  issued: t.date(),
  point: t.embedOne(() => Point).nullable(),
}) {
  get shout(): string {
    return this.holder.toUpperCase();
  }
}

class Contact extends Schema("contacts", {
  id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(),
  name: t.string(),
  address: t.embedOne(() => Street, { onReplace: "update" }).nullable(),
  phones: t.embedMany(() => Phone, { onReplace: "delete" }),
  card: t.embedOne(() => Card).nullable(),
}) {}

export function runNestedConformance(profile: NestedConformanceProfile): void {
  describe(`nested conformance: ${profile.label}`, () => {
    let handle: TestDatabaseHandle;
    let db: TestDatabase;
    const adapters: DatabaseAdapter[] = [];

    function watched(): { repo: Repo; events: RepoQueryEvent[]; adapter: DatabaseAdapter } {
      const adapter = profile.makeAdapter(db, { poolMax: 4 });
      adapters.push(adapter);
      const repo = createRepo({ adapter });
      const events: RepoQueryEvent[] = [];
      repo.on("query", (event) => events.push(event));
      return { repo, events, adapter };
    }

    /** `operation source` of each statement, in order (`transaction` for BEGIN, COMMIT, …). */
    function trail(events: readonly RepoQueryEvent[]): string[] {
      return events.map((event) => `${event.operation} ${event.source ?? ""}`.trim());
    }

    beforeAll(async () => {
      handle = await createTestDatabase(profile.server, { label: "nested", fixtures: ["blog"] });
      db = handle.db;
      await db.exec(profile.schema);
    });

    beforeEach(async () => {
      await truncateAll(db);
    });

    afterEach(async () => {
      for (const each of adapters.splice(0)) {
        // Every connection a test checked out must be back by the time it ends.
        await expectAllReturned(each);
        await each.close();
      }
    });

    afterAll(async () => {
      for (const each of adapters.splice(0)) await each.close();
      await handle?.drop();
    });

    async function seedWriter(repo: Repo, email = "kari@example.com"): Promise<Writer> {
      return repo.insertOrThrow(change(Writer, { email }));
    }

    async function count(_repo: Repo, table: string): Promise<number> {
      const rows = await db.query<{ n: unknown }>(`select count(*) as n from ${table}`);
      return Number((rows[0] as { n: unknown }).n);
    }

    /** A JSON column as the helper's driver returns it: parsed, or (SQLite) the JSON text. */
    const json = (value: unknown): unknown => (typeof value === "string" ? JSON.parse(value) : value);

    // --- hasMany ----------------------------------------------------------------------

    describe("hasMany", () => {
      test("a new parent and its children are inserted together, the children keyed to it", async () => {
        const { repo, events } = watched();
        const writer = await seedWriter(repo);
        events.length = 0;
        const article = ok(
          await repo.insert(
            cast(
              Article,
              { title: "Fjords", authorId: writer.id, remarks: [{ body: "first!" }, { body: "lovely" }] },
              ["title", "authorId"],
            ).castAssoc("remarks"),
          ),
        );
        assertLoaded(Article, article, "remarks");
        expect(trail(events)).toEqual([
          "transaction",
          "insert posts",
          "insert comments",
          "insert comments",
          "transaction",
        ]);
        expect(article.remarks.map((remark) => remark.body)).toEqual(["first!", "lovely"]);
        expect(article.remarks.every((remark) => remark.postId === article.id && isRow(remark))).toBe(true);
        const stored = await repo.all(
          from(Remark, "r")
            .where(({ r }) => r.postId.eq(article.id))
            .orderBy(({ r }) => r.id),
        );
        expect(stored.map((remark) => remark.body)).toEqual(["first!", "lovely"]);
        expect(stored.map((remark) => remark.id)).toEqual(article.remarks.map((remark) => remark.id));
      });

      test("a form submit adds, edits and removes rows in one go", async () => {
        const { repo } = watched();
        const writer = await seedWriter(repo);
        const article = await repo.insertOrThrow(
          change(Article, { title: "Draft", authorId: writer.id }).putAssoc("remarks", [
            { body: "keep me" },
            { body: "drop me" },
          ]),
        );
        assertLoaded(Article, article, "remarks");
        const [kept, dropped] = article.remarks;
        const loaded = await repo.oneOrThrow(from(Article, "a").where({ id: article.id }).preload("remarks"));
        const submitted = {
          title: "Final",
          remarks: [{ id: String(kept?.id), body: "kept and edited" }, { body: "brand new" }],
        };
        const saved = await repo.updateOrThrow(Article.changeset(loaded, submitted).castAssoc("remarks"));
        assertLoaded(Article, saved, "remarks");
        expect(saved.title).toBe("Final");
        expect(saved.remarks.map((remark) => remark.body)).toEqual(["kept and edited", "brand new"]);
        expect(saved.remarks[0]?.id).toBe(kept?.id);
        const stored = await repo.all(from(Remark, "r").orderBy(({ r }) => r.id));
        expect(stored.map((remark) => [remark.id === kept?.id, remark.body])).toEqual([
          [true, "kept and edited"],
          [false, "brand new"],
        ]);
        expect(stored.some((remark) => remark.id === dropped?.id)).toBe(false);
      });

      test("setNull detaches left-out children and keeps their rows", async () => {
        const { repo } = watched();
        const writer = await seedWriter(repo);
        const article = await repo.insertOrThrow(change(Article, { title: "On rain", authorId: writer.id }));
        const first = await repo.insertOrThrow(
          change(Remark, { postId: article.id, authorId: writer.id, body: "one" }),
        );
        const second = await repo.insertOrThrow(
          change(Remark, { postId: article.id, authorId: writer.id, body: "two" }),
        );
        const loaded = await repo.oneOrThrow(from(Writer, "w").where({ id: writer.id }).preload("remarks"));
        const saved = await repo.updateOrThrow(change(loaded).putAssoc("remarks", [second]));
        expect(saved.remarks.map((remark) => remark.id)).toEqual([second.id]);
        const stored = await repo.all(from(Remark, "r").orderBy(({ r }) => r.id));
        expect(stored.map((remark) => [remark.id, remark.authorId])).toEqual([
          [first.id, null],
          [second.id, writer.id],
        ]);
      });

      test("deleteIfExists does not fail when a removed row is already gone", async () => {
        const { repo } = watched();
        const order = await repo.insertOrThrow(
          change(Order, { customer: "Nora" }).putAssoc("items", [
            { sku: "A-1", qty: 1 },
            { sku: "B-2", qty: 2 },
          ]),
        );
        const loaded = await repo.oneOrThrow(from(Order, "o").where({ id: order.id }).preload("items"));
        await db.exec("delete from line_items where sku = 'B-2'");
        const saved = await repo.updateOrThrow(
          cast(loaded, { items: [{ id: loaded.items[0]?.id, sku: "A-1", qty: 5 }] }, []).castAssoc("items"),
        );
        expect(saved.items.map((item) => [item.sku, item.qty])).toEqual([["A-1", 5]]);
        expect(await count(repo, "line_items")).toBe(1);
      });

      test("onReplace error throws before anything is sent, invalid sends nothing", async () => {
        const { repo, events } = watched();
        const writer = await seedWriter(repo);
        await repo.insertOrThrow(change(Article, { title: "Stays", authorId: writer.id }));
        const loaded = await repo.oneOrThrow(from(Article, "a").preload("remarks"));
        const withRemark = await repo.updateOrThrow(change(loaded).putAssoc("remarks", [{ body: "hello" }]));
        class Strict extends Schema("posts", {
          id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(),
          authorId: t.bigint({ mode: "number" }),
          title: t.string(),
        }) {
          static remarks = hasMany(() => Remark, { foreignKey: "postId" });
        }
        const strict = await repo.oneOrThrow(
          from(Strict, "s").where({ id: withRemark.id }).preload("remarks"),
        );
        events.length = 0;
        expect(() => change(strict).putAssoc("remarks", [])).toThrow(QueryError);
        expect(events).toEqual([]);
        expect(await count(repo, "comments")).toBe(1);
      });
    });

    // --- hasOne -----------------------------------------------------------------------

    describe("hasOne", () => {
      test("a replaced child is deleted before its successor is inserted (a unique foreign key)", async () => {
        const { repo, events } = watched();
        const writer = await repo.insertOrThrow(
          change(Writer, { email: "liv@example.com" }).putAssoc("profile", { bio: "old" }),
        );
        const loaded = await repo.oneOrThrow(from(Writer, "w").where({ id: writer.id }).preload("profile"));
        events.length = 0;
        const saved = await repo.updateOrThrow(
          change(loaded).putAssoc("profile", change(Bio, { bio: "new" })),
        );
        expect(trail(events)).toEqual(["transaction", "delete profiles", "insert profiles", "transaction"]);
        expect(saved.profile?.bio).toBe("new");
        const stored = await repo.all(from(Bio, "b"));
        expect(stored.map((bio) => bio.bio)).toEqual(["new"]);
      });

      test("an item with the child's key updates it in place", async () => {
        const { repo } = watched();
        const writer = await repo.insertOrThrow(
          change(Writer, { email: "ola@example.com" }).putAssoc("profile", { bio: "v1" }),
        );
        const loaded = await repo.oneOrThrow(from(Writer, "w").where({ id: writer.id }).preload("profile"));
        const saved = await repo.updateOrThrow(
          cast(loaded, { profile: { id: loaded.profile?.id, bio: "v2" } }, []).castAssoc("profile"),
        );
        expect(saved.profile?.id).toBe(loaded.profile?.id);
        expect((await repo.all(from(Bio, "b"))).map((bio) => bio.bio)).toEqual(["v2"]);
      });
    });

    // --- belongsTo --------------------------------------------------------------------

    describe("belongsTo", () => {
      test("a new parent row is written first and its key goes into the child's foreign key", async () => {
        const { repo, events } = watched();
        const writer = await seedWriter(repo);
        events.length = 0;
        const remark = ok(
          await repo.insert(
            change(Remark, { body: "under a new post" }).putAssoc(
              "post",
              change(Article, { title: "Born with a comment", authorId: writer.id }),
            ),
          ),
        );
        assertLoaded(Remark, remark, "post");
        expect(trail(events)).toEqual(["transaction", "insert posts", "insert comments", "transaction"]);
        expect(remark.post.title).toBe("Born with a comment");
        expect(remark.postId).toBe(remark.post.id);
        const stored = await repo.getOrThrow(Remark, remark.id);
        expect(stored.postId).toBe(remark.post.id);
      });

      test("a loaded parent row is not written again", async () => {
        const { repo, events } = watched();
        const writer = await seedWriter(repo);
        const article = await repo.insertOrThrow(change(Article, { title: "Existing", authorId: writer.id }));
        events.length = 0;
        const remark = await repo.insertOrThrow(
          change(Remark, { body: "attached" }).putAssoc("post", article),
        );
        // One statement, but the write of a changeset with associations is one transaction.
        expect(trail(events)).toEqual(["transaction", "insert comments", "transaction"]);
        expect(remark.postId).toBe(article.id);
      });

      test("onReplace update reuses the parent row whatever key the item has", async () => {
        const { repo } = watched();
        const writer = await seedWriter(repo);
        const article = await repo.insertOrThrow(change(Article, { title: "Mine", authorId: writer.id }));
        const loaded = await repo.oneOrThrow(from(Article, "a").where({ id: article.id }).preload("author"));
        const saved = await repo.updateOrThrow(
          cast(loaded, { author: { email: "renamed@example.com" } }, []).castAssoc("author"),
        );
        expect(saved.author.id).toBe(writer.id);
        expect((await repo.getOrThrow(Writer, writer.id)).email).toBe("renamed@example.com");
      });
    });

    // --- manyToMany -------------------------------------------------------------------

    describe("manyToMany", () => {
      test("a tag picker links existing tags and creates new ones; removing a tag deletes the join row only", async () => {
        const { repo, adapter: picking } = watched();
        // Without RETURNING the new tags are read back by name.
        const returning = picking.capabilities.returning;
        const writer = await seedWriter(repo);
        const news = await repo.insertOrThrow(change(Label, { name: "news" }));
        // Find or create the picked tags, then link them, in one transaction.
        const picked = ["news", "weather"];
        const batch = createBatch()
          .run("labels", async (tx) => {
            const found = await tx.all(from(Label, "l").where(({ l }) => l.name.in(picked)));
            const missing = picked.filter((name) => !found.some((label) => label.name === name));
            const rows = missing.map((name) => ({ name }));
            const made =
              missing.length === 0
                ? []
                : returning
                  ? (await tx.insertAll(Label, rows, { returning: true })).rows
                  : await tx
                      .insertAll(Label, rows)
                      .then(() => tx.all(from(Label, "l").where(({ l }) => l.name.in(missing))));
            return success([...found, ...(made ?? [])]);
          })
          .insert("article", ({ labels }) =>
            change(Article, { title: "Tagged", authorId: writer.id }).putAssoc("labels", labels),
          );
        const result = await repo.transaction(batch);
        const article = ok(result).article;
        assertLoaded(Article, article, "labels");
        expect(article.labels.map((label) => label.name).sort()).toEqual(["news", "weather"]);
        expect(await count(repo, "posts_tags")).toBe(2);

        const loaded = await repo.oneOrThrow(from(Article, "a").where({ id: article.id }).preload("labels"));
        const saved = await repo.updateOrThrow(change(loaded).putAssoc("labels", [news]));
        expect(saved.labels.map((label) => label.name)).toEqual(["news"]);
        expect(await count(repo, "posts_tags")).toBe(1);
        expect(await count(repo, "tags")).toBe(2);
      });

      test("putting the links that are already there changes nothing and sends nothing", async () => {
        const { repo, events } = watched();
        const writer = await seedWriter(repo);
        const article = await repo.insertOrThrow(
          change(Article, { title: "Same", authorId: writer.id }).putAssoc("labels", [
            { name: "one" },
            { name: "two" },
          ]),
        );
        const loaded = await repo.oneOrThrow(from(Article, "a").where({ id: article.id }).preload("labels"));
        const again = change(loaded).putAssoc("labels", [...loaded.labels]);
        expect(again.changes).toEqual({});
        events.length = 0;
        await repo.updateOrThrow(again);
        expect(events).toEqual([]);
      });

      test("through a join schema, the join row gets the schema's defaults", async () => {
        const { repo } = watched();
        const writer = await seedWriter(repo);
        const team = await repo.insertOrThrow(change(Team, { name: "Crew" }));
        const loaded = await repo.oneOrThrow(from(Writer, "w").where({ id: writer.id }).preload("teams"));
        const saved = await repo.updateOrThrow(
          change(loaded).putAssoc("teams", [team, { name: "New crew" }]),
        );
        expect(saved.teams.map((each) => each.name)).toEqual(["Crew", "New crew"]);
        const seats = await repo.all(from(Seat, "s"));
        expect(seats).toHaveLength(2);
        expect(seats.every((seat) => seat.role === "member" && seat.userId === writer.id)).toBe(true);
      });
    });

    // --- atomicity ----------------------------------------------------------------------

    describe("atomicity", () => {
      test("a child that fails a declared constraint rolls everything back and comes back in place", async () => {
        const { repo } = watched();
        const result = await repo.insert(
          cast(
            Order,
            {
              customer: "Pia",
              items: [
                { sku: "OK", qty: 1 },
                { sku: "BAD", qty: 0 },
              ],
            },
            ["customer"],
          ).castAssoc("items"),
        );
        const error = failed(result);
        expect(error.action).toBe("insert");
        const items = error.changes.items as readonly Changeset<typeof LineItem>[];
        expect(items[1]?.errorMessages()).toEqual({ qty: ["must be positive"] });
        expect(items[1]?.action).toBe("insert");
        expect(error.errorMessages()).toEqual({ items: [{}, { qty: ["must be positive"] }] });
        expect(await count(repo, "orders")).toBe(0);
        expect(await count(repo, "line_items")).toBe(0);
      });

      test("an undeclared violation is thrown and nothing is left behind", async () => {
        const { repo } = watched();
        const error = await rejection(
          repo.insert(change(Order, { customer: "Per" }).putAssoc("items", [{ sku: "X", qty: -1 }])),
        );
        expect(error).toBeInstanceOf(ConstraintError);
        expect(await count(repo, "orders")).toBe(0);
      });

      test("inside a transaction a failed nested write undoes only itself", async () => {
        const { repo } = watched();
        const outcome = await repo.transaction(async (tx) => {
          await tx.insertOrThrow(change(Order, { customer: "Before" }));
          const nested = await tx.insert(
            change(Order, { customer: "Nested" }).putAssoc("items", [
              change(LineItem, { sku: "Z", qty: 0 }).checkConstraint("qty", { name: "line_items_qty_check" }),
            ]),
          );
          await tx.insertOrThrow(change(Order, { customer: "After" }));
          return nested.success;
        });
        expect(ok(outcome)).toBe(false);
        const customers = (await repo.all(from(Order, "o").orderBy(({ o }) => o.id))).map(
          (order) => order.customer,
        );
        expect(customers).toEqual(["Before", "After"]);
      });

      test("an invalid child sends nothing", async () => {
        const { repo, events } = watched();
        const writer = await seedWriter(repo);
        events.length = 0;
        const result = await repo.insert(
          cast(Article, { title: "T", authorId: writer.id, remarks: [{ body: "x" }] }, [
            "title",
            "authorId",
          ]).castAssoc("remarks"),
        );
        expect(failed(result).errorMessages()).toEqual({
          remarks: [{ body: ["should be at least 2 character(s)"] }],
        });
        expect(events).toEqual([]);
      });
    });

    // --- depth ------------------------------------------------------------------------

    test("three levels are written in one call, each keyed to its parent", async () => {
      const { repo } = watched();
      const writer = ok(
        await repo.insert(
          cast(
            Writer,
            {
              email: "deep@example.com",
              posts: [
                { title: "A", remarks: [{ body: "a1" }, { body: "a2" }] },
                { title: "B", remarks: [{ body: "b1" }] },
              ],
            },
            ["email"],
          ).castAssoc("posts", {
            with: (article, params) => Article.changeset(article, params).castAssoc("remarks"),
          }),
        ),
      );
      assertLoaded(Writer, writer, "posts");
      expect(writer.posts.map((post) => post.title)).toEqual(["A", "B"]);
      const stored = await repo.all(
        from(Writer, "w")
          .where(({ w }) => w.id.eq(writer.id))
          .preload({ posts: "remarks" }),
      );
      expect(stored[0]?.posts.map((post) => post.remarks.map((remark) => remark.body))).toEqual([
        ["a1", "a2"],
        ["b1"],
      ]);
    });

    test("a written row reloads with the associations it was written with", async () => {
      const { repo } = watched();
      const writer = await seedWriter(repo);
      const article = await repo.insertOrThrow(
        change(Article, { title: "Reload", authorId: writer.id }).putAssoc("remarks", [{ body: "hi" }]),
      );
      assertLoaded(Article, article, "remarks");
      await repo.insertOrThrow(buildAssoc(Article, article, "remarks", { body: "later" }));
      const fresh = await repo.reload(article);
      expect(fresh?.remarks.map((remark) => remark.body)).toEqual(["hi", "later"]);
    });

    test("a row read with preloads reloads them after a nested write", async () => {
      const { repo } = watched();
      const writer = await seedWriter(repo);
      const article = await repo.insertOrThrow(
        change(Article, { title: "Both", authorId: writer.id }).putAssoc("labels", [{ name: "kept" }]),
      );
      const read = await repo.oneOrThrow(
        from(Article, "a").where({ id: article.id }).preload(["labels", "remarks"]),
      );
      const written = await repo.updateOrThrow(change(read).putAssoc("remarks", [{ body: "new" }]));
      assertLoaded(Article, written, "remarks");
      expect(written.labels.map((label) => label.name)).toEqual(["kept"]);
      await repo.insertOrThrow(buildAssoc(Article, written, "remarks", { body: "after" }));
      const fresh = await repo.reload(written);
      expect(fresh?.labels.map((label) => label.name)).toEqual(["kept"]);
      expect(fresh?.remarks.map((remark) => remark.body)).toEqual(["new", "after"]);
    });

    // --- review round 1 ---------------------------------------------------------------

    describe("review round 1", () => {
      test("a child failing two levels down rolls everything back and comes back in place", async () => {
        const { repo } = watched();
        await repo.insertOrThrow(change(Label, { name: "taken" }));
        const result = await repo.insert(
          cast(Writer, { email: "deep2@example.com", posts: [{ title: "ok" }, { title: "clash" }] }, [
            "email",
          ]).castAssoc("posts", {
            with: (article, params, index) =>
              Article.changeset(article, params).putAssoc(
                "labels",
                index === 1 ? [Label.changeset(Label, { name: "taken" })] : [],
              ),
          }),
        );
        expect(failed(result).errorMessages()).toEqual({
          posts: [{}, { labels: [{ name: ["has already been taken"] }] }],
        });
        expect(await count(repo, "users")).toBe(0);
        expect(await count(repo, "posts")).toBe(0);
        expect(await count(repo, "tags")).toBe(1);
      });

      test("timeoutMs is one budget for every statement of a nested write", async () => {
        // Each 'slow' item takes about 0.3 s (0.6 s where a running statement cannot be
        // cancelled, so that the budget is spent before the next statement starts).
        const { repo } = watched();
        const error = await rejection(
          repo.insert(
            change(Order, { customer: "Slow" }).putAssoc("items", [
              { sku: "slow", qty: 1 },
              { sku: "slow", qty: 1 },
            ]),
            { timeoutMs: 450 },
          ),
        );
        expect(error).toBeInstanceOf(DatabaseError);
        expect((error as DatabaseError).code).toBe("timeout");
        expect((error as Error).message).toContain("(450 ms)");
        expect(await count(repo, "orders")).toBe(0);
      });

      test("a stored embed value of the wrong kind, or null in a required field, is a CastError on read", async () => {
        const { repo } = watched();
        await db.exec(`insert into contacts (name, address) values ('Bad', '{"line": 5, "city": "C"}')`);
        expect(await rejection(repo.all(from(Contact, "c")))).toBeInstanceOf(CastError);
        await db.exec("delete from contacts");
        await db.exec(`insert into contacts (name, address) values ('Null', '{"line": null, "city": "C"}')`);
        expect(await rejection(repo.all(from(Contact, "c")))).toBeInstanceOf(CastError);
      });

      test("insertAll writes embeds that read back: generated keys filled in, unknown keys refused", async () => {
        const { repo } = watched();
        await repo.insertAll(Contact, [{ name: "Bulk", phones: [{ label: "home", digits: "9" } as never] }]);
        const [stored] = await repo.all(from(Contact, "c"));
        expect(stored?.phones[0]).toBeInstanceOf(Phone);
        expect(stored?.phones[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
        const refused = await rejection(
          repo.insertAll(Contact, [
            { name: "Odd", phones: [{ label: "x", digits: "1", extra: 1 } as never] },
          ]),
        );
        expect(refused).toBeInstanceOf(CastError);
        expect(await count(repo, "contacts")).toBe(1);
      });
    });

    // --- embeds -----------------------------------------------------------------------

    describe("embeds", () => {
      test("an embedded row and list are stored as JSON and read back as instances of their classes", async () => {
        const { repo } = watched();
        const verifiedAt = new Date("2026-03-29T01:30:00.000Z");
        const contact = await repo.insertOrThrow(
          cast(
            Contact,
            {
              name: "Ida",
              address: { line: "Storgata 1", city: "Oslo" },
              phones: [{ label: "home", digits: "1234", verifiedAt: verifiedAt.toISOString() }],
            },
            ["name"],
          )
            .castEmbed("address")
            .castEmbed("phones")
            .putEmbed("card", { holder: "Ida", issued: "2026-01-02", point: { lat: 59.9, lng: 10.7 } }),
        );
        expect(contact.address).toBeInstanceOf(Street);
        expect(contact.phones[0]).toBeInstanceOf(Phone);
        expect(typeof contact.phones[0]?.id).toBe("string");
        const [row] = await db.query<{ address: unknown; phones: unknown; card: unknown }>(
          "select address, phones, card from contacts",
        );
        if (row === undefined) fail("expected a stored contact");
        expect(json(row.address)).toEqual({ line: "Storgata 1", city: "Oslo", postCode: null });
        expect(json(row.phones)).toEqual([
          {
            id: contact.phones[0]?.id,
            label: "home",
            digits: "1234",
            verifiedAt: "2026-03-29T01:30:00.000Z",
          },
        ]);
        expect(json(row.card)).toEqual({
          holder: "Ida",
          issued: "2026-01-02",
          point: { lat: 59.9, lng: 10.7 },
        });

        const stored = await repo.getOrThrow(Contact, contact.id);
        expect(stored.address).toBeInstanceOf(Street);
        expect(stored.phones[0]?.verifiedAt).toEqual(verifiedAt);
        expect(stored.card?.point).toBeInstanceOf(Point);
        expect(stored.card?.shout).toBe("IDA");
        expect(stateOf(stored.address as Street)).toBe("loaded");
      });

      test("unknown keys are ignored and missing keys take their defaults", async () => {
        const { repo } = watched();
        await db.exec(
          `insert into contacts (name, address, phones) values ('Old', '{"line": "L", "city": "C", "floor": 3}', '[]')`,
        );
        const [stored] = await repo.all(from(Contact, "c"));
        expect(stored?.address).toMatchObject({ line: "L", city: "C", postCode: null });
        expect(Object.keys(stored?.address ?? {})).toEqual(["line", "city", "postCode"]);
      });

      test("items of a keyed list are matched by id and updated in place; left-out ones are dropped", async () => {
        const { repo } = watched();
        const contact = await repo.insertOrThrow(
          change(Contact, { name: "Jon" }).putEmbed("phones", [
            { label: "home", digits: "1" },
            { label: "work", digits: "2" },
          ]),
        );
        const [home] = contact.phones;
        const saved = await repo.updateOrThrow(
          cast(
            contact,
            {
              phones: [
                { id: home?.id, label: "home", digits: "11" },
                { label: "cell", digits: "3" },
              ],
            },
            [],
          ).castEmbed("phones"),
        );
        expect(saved.phones.map((phone) => [phone.label, phone.digits])).toEqual([
          ["home", "11"],
          ["cell", "3"],
        ]);
        expect(saved.phones[0]?.id).toBe(home?.id);
        const stored = await repo.getOrThrow(Contact, contact.id);
        expect(stored.phones.map((phone) => phone.digits)).toEqual(["11", "3"]);
      });

      test("onReplace update keeps the embedded row and applies the changes", async () => {
        const { repo } = watched();
        const contact = await repo.insertOrThrow(
          change(Contact, { name: "Kim" }).putEmbed("address", {
            line: "A 1",
            city: "Bergen",
            postCode: "5003",
          }),
        );
        const saved = await repo.updateOrThrow(
          cast(contact, { address: { city: "Tromsø" } }, []).castEmbed("address"),
        );
        expect(saved.address).toMatchObject({ line: "A 1", city: "Tromsø", postCode: "5003" });
      });

      test("a query reads inside an embed with field(), typed and cast", async () => {
        const { repo } = watched();
        await repo.insertOrThrow(
          change(Contact, { name: "A" }).putEmbed("address", { line: "1", city: "Oslo" }),
        );
        await repo.insertOrThrow(
          change(Contact, { name: "B" }).putEmbed("address", { line: "2", city: "Bergen" }),
        );
        await repo.insertOrThrow(
          change(Contact, { name: "C" }).putEmbed("card", {
            holder: "C",
            issued: "2025-12-31",
            point: { lat: 1.5, lng: 2 },
          }),
        );
        const inOslo = await repo.all(
          from(Contact, "c")
            .where(({ c }) => c.address.field("city").eq("Oslo"))
            .select(({ c }) => c.name),
        );
        expect(inOslo).toEqual(["A"]);
        const north = await repo.all(
          from(Contact, "c")
            .where(({ c }) => c.card.field("point").field("lat").gt(1))
            .select(({ c }) => ({ name: c.name, lat: c.card.field("point").field("lat") })),
        );
        expect(north).toEqual([{ name: "C", lat: 1.5 }]);
      });

      test("the blog's settings embed reads defaults for the keys a stored value lacks", async () => {
        const { repo } = watched();
        await db.exec(`insert into users (email, settings) values ('s@example.com', '{"theme": "dark"}')`);
        const { User, UserSettings } = await import("../../support/index.js");
        const [user] = await repo.all(from(User, "u"));
        expect(user?.settings).toBeInstanceOf(UserSettings);
        expect(user?.settings).toMatchObject({ theme: "dark", emailNotifications: true });
      });
    });
  });
}
