// The preload conformance suite: what preloading must do against a real database, written
// once and run by each dialect package with a profile of its own. It covers every
// association kind with no, one and many children, null foreign keys, composite and uuid
// keys, three levels of nesting, sibling associations, the callback form (filters, order,
// per-parent limit and offset, selected columns), join preloads with repeated parents,
// has-through with de-duplication, a many-to-many with a join-table condition, preloads
// inside a transaction, after-the-fact preloads, `reload`, `assoc()` queries, and many
// parents in several statements. Every case counts the statements it ran through the
// repo's `query` events: one for the query and one per association level.
//
// One database per run of the suite, over the blog fixture plus the profile's tables, with
// a small fixed data set (the chunking case adds its own rows and removes them).
import {
  assoc,
  belongsTo,
  change,
  createRepo,
  type DatabaseAdapter,
  DatabaseError,
  fragment,
  from,
  hasMany,
  isLoaded,
  isRow,
  manyToMany,
  param,
  QueryError,
  type Repo,
  type RepoOptions,
  type RepoQueryEvent,
  Schema,
  t,
} from "egon-orm";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { ROW } from "../../../src/contracts/schema.js";
import { preloadLimits } from "../../../src/repo/preload.js";
import { load, QueryHub, ReadCore } from "../../../src/repo/read.js";
import {
  Comment,
  createTestDatabase,
  Membership,
  Org,
  Post,
  Profile,
  Tag,
  type TestDatabase,
  type TestDatabaseHandle,
  User,
} from "../../support/index.js";
import { expectAllReturned } from "../../support/leaks.js";
import type { MakePreloadAdapterOptions, PreloadConformanceProfile } from "./profile.js";

export type { MakePreloadAdapterOptions, PreloadConformanceProfile } from "./profile.js";

// --- the suite's own schemas ---------------------------------------------------------

class Shelf extends Schema("shelves", {
  region: t.string().primaryKey(),
  code: t.integer().primaryKey(),
  label: t.string(),
}) {
  static volumes = hasMany(() => Volume, { foreignKey: ["shelfRegion", "shelfCode"], orderBy: ["id"] });
}

class Volume extends Schema("volumes", {
  id: t.integer().primaryKey(),
  shelfRegion: t.string().nullable(),
  shelfCode: t.integer().nullable(),
  title: t.string(),
}) {
  static shelf = belongsTo(() => Shelf, { foreignKey: ["shelfRegion", "shelfCode"] });
}

class Category extends Schema("categories", {
  id: t.integer().primaryKey(),
  parentId: t.integer().nullable(),
  name: t.string(),
}) {
  static parent = belongsTo(() => Category, { foreignKey: "parentId" });
  static children = hasMany(() => Category, { foreignKey: "parentId", orderBy: ["name"] });
}

/** Users with has-through associations that can reach one row along several paths. */
class Writer extends Schema("users", {
  id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(),
  email: t.string(),
}) {
  static posts = hasMany(() => Post, { foreignKey: "authorId" });
  static tags = hasMany(() => Tag, { through: ["posts", "tags"] });
  static commenters = hasMany(() => User, { through: ["posts", "comments", "author"] });
}

/** Posts with a many-to-many whose join table has a condition of its own. */
class LabeledPost extends Schema("posts", {
  id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(),
  authorId: t.bigint({ mode: "number" }),
  title: t.string(),
}) {
  static featured = manyToMany(() => Tag, {
    joinThrough: "post_labels",
    joinKeys: { owner: "post_id", target: "tag_id" },
    joinWhere: { featured: true },
    orderBy: ["name"],
  });
}

const ORG_A = "0b6b6c40-3c38-4f39-9e6b-3f3c6e8e2a01";
const ORG_B = "0b6b6c40-3c38-4f39-9e6b-3f3c6e8e2a02";

/** The data set: three users, four posts, four comments, three tags, two orgs. */
const SEED = `
  insert into users (id, email, name, created_at, updated_at) values
    (1, 'ada@example.com', 'Ada', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00'),
    (2, 'grace@example.com', 'Grace', '2026-01-02T00:00:00+00:00', '2026-01-02T00:00:00+00:00'),
    (3, 'linus@example.com', null, '2026-01-03T00:00:00+00:00', '2026-01-03T00:00:00+00:00');
  insert into profiles (id, user_id, bio) values (1, 1, 'Mathematician');
  insert into posts (id, author_id, title, published, views, created_at, updated_at) values
    (10, 1, 'Engines', true, 5, '2026-02-01T00:00:00+00:00', '2026-02-01T00:00:00+00:00'),
    (11, 1, 'Notes (draft)', false, 0, '2026-02-02T00:00:00+00:00', '2026-02-02T00:00:00+00:00'),
    (12, 1, 'Loops', true, 9, '2026-02-03T00:00:00+00:00', '2026-02-03T00:00:00+00:00'),
    (20, 2, 'Compilers', true, 7, '2026-02-01T12:00:00+00:00', '2026-02-01T12:00:00+00:00');
  insert into comments (id, post_id, author_id, body, created_at) values
    (100, 10, 2, 'Lovely', '2026-03-01T00:00:00+00:00'),
    (101, 10, 2, 'More please', '2026-03-02T00:00:00+00:00'),
    (102, 10, null, 'Anonymous', '2026-03-03T00:00:00+00:00'),
    (103, 20, 1, 'Agreed', '2026-03-01T00:00:00+00:00');
  insert into tags (id, name) values (1, 'sql'), (2, 'ts'), (3, 'orm');
  insert into posts_tags (post_id, tag_id) values (10, 1), (10, 2), (12, 1), (20, 3);
  insert into post_labels (post_id, tag_id, featured) values (10, 1, true), (10, 2, false), (12, 3, true);
  insert into orgs (id, name) values ('${ORG_A}', 'Analytical'), ('${ORG_B}', 'Babbage');
  insert into memberships (org_id, user_id, role) values
    ('${ORG_A}', 1, 'owner'), ('${ORG_B}', 1, 'member'), ('${ORG_A}', 2, 'admin');
  insert into shelves (region, code, label) values ('north', 1, 'N1'), ('north', 2, 'N2'), ('south', 1, 'S1');
  insert into volumes (id, shelf_region, shelf_code, title) values
    (1, 'north', 1, 'Atlas'), (2, 'north', 1, 'Bestiary'), (3, 'south', 1, 'Codex'), (4, null, null, 'Loose'),
    (5, 'north', 2, 'Diary');
  insert into categories (id, parent_id, name) values
    (1, null, 'root'), (2, 1, 'beta'), (3, 1, 'alpha'), (4, 3, 'leaf');
`;

export function runPreloadConformance(profile: PreloadConformanceProfile): void {
  describe(`preload conformance: ${profile.label}`, () => {
    let handle: TestDatabaseHandle;
    let db: TestDatabase;
    const adapters: DatabaseAdapter[] = [];

    function adapter(options: Partial<MakePreloadAdapterOptions> = {}): DatabaseAdapter {
      const made = profile.makeAdapter(db, { poolMax: options.poolMax ?? 4 });
      adapters.push(made);
      return made;
    }

    /** A repo and the events of every statement it runs: the N+1 guard of every case. */
    function watched(options: Partial<RepoOptions> = {}): { repo: Repo; events: RepoQueryEvent[] } {
      const made = createRepo({ adapter: options.adapter ?? adapter(), ...options });
      const events: RepoQueryEvent[] = [];
      made.on("query", (event) => events.push(event));
      return { repo: made, events };
    }

    const operations = (events: readonly RepoQueryEvent[]): string[] =>
      events.map((event) => `${event.operation} ${event.source ?? ""}`.trim());

    beforeAll(async () => {
      handle = await createTestDatabase(profile.server, { label: "preload", fixtures: ["blog"] });
      db = handle.db;
      await db.exec(profile.schema);
      await db.exec(SEED);
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
      const drop = handle === undefined ? undefined : profile.dropCopies?.(handle.db);
      if (drop !== undefined) await handle?.db.exec(drop);
      await handle?.drop();
    });

    // --- each association kind --------------------------------------------------------

    describe("hasMany", () => {
      test("loads no, one and many children in the association's order, in one statement", async () => {
        const { repo, events } = watched();
        const users = await repo.all(
          from(User, "u")
            .preload("posts")
            .orderBy(({ u }) => u.id),
        );
        expect(users.map((user) => user.posts.map((post) => post.id))).toEqual([[10, 11, 12], [20], []]);
        expect(users[0]?.posts[0]).toBeInstanceOf(Post);
        expect(operations(events)).toEqual(["all users", "preload posts"]);
      });

      test("children of different parents are different arrays", async () => {
        const { repo, events } = watched();
        const users = await repo.all(from(User, "u").preload("posts"));
        const [a, b] = users.filter((user) => user.posts.length === 0);
        expect(a).toBeDefined();
        if (b !== undefined) expect(a?.posts).not.toBe(b.posts);
        expect(events).toHaveLength(2);
      });

      test("a query with no rows runs no preload statement", async () => {
        const { repo, events } = watched();
        const users = await repo.all(
          from(User, "u")
            .where(({ u }) => u.id.eq(999))
            .preload("posts"),
        );
        expect(users).toEqual([]);
        expect(operations(events)).toEqual(["all users"]);
      });
    });

    describe("belongsTo", () => {
      test("a target shared by several parents is read once and given to each as its own object", async () => {
        const { repo, events } = watched();
        const posts = await repo.all(
          from(Post, "p")
            .preload("author")
            .orderBy(({ p }) => p.id),
        );
        expect(posts.map((post) => post.author.email)).toEqual([
          "ada@example.com",
          "ada@example.com",
          "ada@example.com",
          "grace@example.com",
        ]);
        const [first, second] = posts;
        expect(first?.author).not.toBe(second?.author);
        expect(first?.author).toEqual(second?.author);
        (first as { author: { name: string | null } }).author.name = "changed";
        expect(second?.author.name).toBe("Ada");
        expect(first?.author.createdAt).not.toBe(second?.author.createdAt);
        expect(operations(events)).toEqual(["all posts", "preload users"]);
        expect(events[1]?.rowCount).toBe(2);
      });

      test("a null foreign key loads null, and is not sent", async () => {
        const { repo, events } = watched({ log: { params: true } });
        const comments = await repo.all(
          from(Comment, "c")
            .preload("author")
            .orderBy(({ c }) => c.id),
        );
        expect(comments.map((comment) => comment.author?.id ?? null)).toEqual([2, 2, null, 1]);
        // One array parameter, or the keys one by one where lists are expanded (capability arrayParams).
        expect(events[1]?.params).toEqual(adapter().capabilities.arrayParams ? [[2, 1]] : [2, 1]);
        expect(events).toHaveLength(2);
      });

      test("a self-referencing association, nested in itself", async () => {
        const { repo, events } = watched();
        const leaf = await repo.oneOrThrow(
          from(Category, "c")
            .where(({ c }) => c.id.eq(4))
            .preload({ parent: { parent: "parent" } }),
        );
        expect(leaf.parent?.name).toBe("alpha");
        expect(leaf.parent?.parent?.name).toBe("root");
        expect(leaf.parent?.parent?.parent).toBeNull();
        // The root has no parent: the third level has no key to look up, and runs no statement.
        expect(events).toHaveLength(3);
      });
    });

    describe("hasOne", () => {
      test("loads the child or null", async () => {
        const { repo, events } = watched();
        const users = await repo.all(
          from(User, "u")
            .preload("profile")
            .orderBy(({ u }) => u.id),
        );
        expect(users.map((user) => user.profile?.bio ?? null)).toEqual(["Mathematician", null, null]);
        expect(users[0]?.profile).toBeInstanceOf(Profile);
        expect(operations(events)).toEqual(["all users", "preload profiles"]);
      });
    });

    describe("manyToMany", () => {
      test("through a table: one statement joining it, the owner key read beside each row", async () => {
        const { repo, events } = watched();
        const posts = await repo.all(
          from(Post, "p")
            .preload("tags")
            .orderBy(({ p }) => p.id),
        );
        expect(
          posts.map((post) =>
            post.tags
              .map((tag) => tag.name)
              .slice()
              .sort(),
          ),
        ).toEqual([["sql", "ts"], [], ["sql"], ["orm"]]);
        expect(posts[0]?.tags[0]).toBeInstanceOf(Tag);
        expect(Object.keys(posts[0]?.tags[0] as object)).toEqual(["id", "name"]);
        expect(operations(events)).toEqual(["all posts", "preload tags"]);
        // The tag "sql" of two posts is two objects.
        const sql = posts.flatMap((post) => post.tags).filter((tag) => tag.name === "sql");
        expect(sql).toHaveLength(2);
        expect(sql[0]).not.toBe(sql[1]);
      });

      test("through a join schema, with uuid keys on both sides", async () => {
        const { repo, events } = watched();
        const users = await repo.all(
          from(User, "u")
            .preload("orgs")
            .orderBy(({ u }) => u.id),
        );
        expect(
          users.map((user) =>
            user.orgs
              .map((org) => org.name)
              .slice()
              .sort(),
          ),
        ).toEqual([["Analytical", "Babbage"], ["Analytical"], []]);
        const orgs = await repo.all(
          from(Org, "o")
            .preload({ users: true, memberships: "user" })
            .orderBy(({ o }) => o.name),
        );
        expect(orgs.map((org) => org.users.map((user) => user.id).sort())).toEqual([[1, 2], [1]]);
        expect(orgs[0]?.memberships.map((membership) => membership.user.email).sort()).toEqual([
          "ada@example.com",
          "grace@example.com",
        ]);
        expect(operations(events)).toEqual([
          "all users",
          "preload orgs",
          "all orgs",
          "preload memberships",
          "preload users",
          "preload users",
        ]);
      });

      test("the join table's condition applies, and the association's order", async () => {
        const { repo, events } = watched();
        const posts = await repo.all(
          from(LabeledPost, "p")
            .where(({ p }) => p.id.in([10, 11, 12]))
            .preload("featured")
            .orderBy(({ p }) => p.id),
        );
        expect(posts.map((post) => post.featured.map((tag) => tag.name))).toEqual([["sql"], [], ["orm"]]);
        expect(events).toHaveLength(2);
      });

      test("a callback may select without the key: the preload reads it from the join table", async () => {
        const { repo, events } = watched();
        const posts = await repo.all(
          from(Post, "p")
            .where(({ p }) => p.id.eq(10))
            .preload("tags", (q) =>
              q.select(({ tags }) => ({ name: tags.name })).orderBy(({ tags }) => tags.name),
            ),
        );
        expect(posts[0]?.tags).toEqual([{ name: "sql" }, { name: "ts" }]);
        expect(isRow(posts[0]?.tags[0])).toBe(false);
        expect(events).toHaveLength(2);
      });
    });

    describe("has-through", () => {
      test("follows the chain in one statement", async () => {
        const { repo, events } = watched();
        const users = await repo.all(
          from(User, "u")
            .preload("comments")
            .orderBy(({ u }) => u.id),
        );
        expect(users.map((user) => user.comments.map((comment) => comment.id).sort())).toEqual([
          [100, 101, 102],
          [103],
          [],
        ]);
        expect(users[0]?.comments[0]).toBeInstanceOf(Comment);
        expect(Object.hasOwn(users[0] as object, "posts")).toBe(false);
        expect(operations(events)).toEqual(["all users", "preload comments"]);
      });

      test("a row reached along several paths is loaded once per parent", async () => {
        const { repo, events } = watched();
        const writers = await repo.all(
          from(Writer, "w")
            .where(({ w }) => w.id.in([1, 2]))
            .preload(["tags", "commenters"])
            .orderBy(({ w }) => w.id),
        );
        // Ada's posts 10 and 12 both carry "sql".
        expect(writers[0]?.tags.map((tag) => tag.name).sort()).toEqual(["sql", "ts"]);
        expect(writers[1]?.tags.map((tag) => tag.name)).toEqual(["orm"]);
        // Grace commented twice on post 10; the anonymous comment reaches no one.
        expect(writers[0]?.commenters.map((user) => user.id)).toEqual([2]);
        expect(writers[1]?.commenters.map((user) => user.id)).toEqual([1]);
        expect(events).toHaveLength(3);
      });

      test("a per-parent limit where a row can repeat is refused before anything runs", async () => {
        const { repo, events } = watched();
        await expect(
          repo.all(from(Writer, "w").preload("tags", (q) => q.orderBy(({ tags }) => tags.name).limit(1))),
        ).rejects.toThrow(QueryError);
        expect(events).toEqual([]);
      });

      test("a per-parent limit on a chain whose rows cannot repeat", async () => {
        const { repo, events } = watched();
        const users = await repo.all(
          from(User, "u")
            .where(({ u }) => u.id.eq(1))
            .preload("comments", (q) => q.orderBy(({ comments }) => comments.createdAt.desc()).limit(2)),
        );
        expect(users[0]?.comments.map((comment) => comment.id)).toEqual([102, 101]);
        expect(events).toHaveLength(2);
      });
    });

    describe("composite keys", () => {
      test("hasMany and belongsTo match on every part of the key", async () => {
        const { repo, events } = watched();
        const shelves = await repo.all(
          from(Shelf, "s")
            .preload("volumes")
            .orderBy(({ s }) => [s.region, s.code]),
        );
        expect(shelves.map((shelf) => shelf.volumes.map((volume) => volume.title))).toEqual([
          ["Atlas", "Bestiary"],
          ["Diary"],
          ["Codex"],
        ]);
        const volumes = await repo.all(
          from(Volume, "v")
            .preload("shelf")
            .orderBy(({ v }) => v.id),
        );
        expect(volumes.map((volume) => volume.shelf?.label ?? null)).toEqual(["N1", "N1", "S1", null, "N2"]);
        expect(volumes[0]?.shelf).not.toBe(volumes[1]?.shelf);
        expect(events).toHaveLength(4);
      });

      test("a per-parent limit over a composite key", async () => {
        const { repo, events } = watched();
        const shelves = await repo.all(
          from(Shelf, "s")
            .preload("volumes", (q) => q.orderBy(({ volumes }) => volumes.title.desc()).limit(1))
            .orderBy(({ s }) => [s.region, s.code]),
        );
        expect(shelves.map((shelf) => shelf.volumes.map((volume) => volume.title))).toEqual([
          ["Bestiary"],
          ["Diary"],
          ["Codex"],
        ]);
        expect(events).toHaveLength(2);
      });
    });

    // --- nesting and siblings ----------------------------------------------------------

    describe("nesting and siblings", () => {
      test("three levels deep is one statement per level", async () => {
        const { repo, events } = watched();
        const users = await repo.all(
          from(User, "u")
            .preload({ posts: { comments: "author" } })
            .orderBy(({ u }) => u.id),
        );
        const engines = users[0]?.posts[0];
        expect(engines?.comments.map((comment) => comment.author?.email ?? null)).toEqual([
          "grace@example.com",
          "grace@example.com",
          null,
        ]);
        expect(users[1]?.posts[0]?.comments[0]?.author?.email).toBe("ada@example.com");
        expect(operations(events)).toEqual([
          "all users",
          "preload posts",
          "preload comments",
          "preload users",
        ]);
      });

      test("siblings at each level, one at a time by default", async () => {
        const { repo, events } = watched();
        const users = await repo.all(
          from(User, "u")
            .preload(["profile", { posts: ["comments", "tags"] }])
            .orderBy(({ u }) => u.id),
        );
        expect(users[0]?.profile?.bio).toBe("Mathematician");
        expect(users[0]?.posts[0]?.tags.map((tag) => tag.name).sort()).toEqual(["sql", "ts"]);
        expect(users[0]?.posts[0]?.comments).toHaveLength(3);
        expect(operations(events)).toEqual([
          "all users",
          "preload profiles",
          "preload posts",
          "preload comments",
          "preload tags",
        ]);
      });

      test("maxConcurrency runs siblings at the same time and loads the same rows", async () => {
        const { repo, events } = watched();
        const spec = from(User, "u")
          .preload(["profile", "orgs", { posts: ["comments", "tags"] }])
          .orderBy(({ u }) => u.id);
        const together = await repo.all(spec, { maxConcurrency: 3 });
        const apart = await repo.all(spec);
        expect(together).toEqual(apart);
        expect(events).toHaveLength(12);
      });

      test("rows with one set of preloads share their property order, whatever order they were asked in", async () => {
        const { repo, events } = watched();
        const a = await repo.oneOrThrow(
          from(User, "u")
            .where(({ u }) => u.id.eq(1))
            .preload("posts")
            .preload("profile"),
        );
        const b = await repo.oneOrThrow(
          from(User, "u")
            .where(({ u }) => u.id.eq(1))
            .preload(["profile", "posts"]),
        );
        expect(Object.keys(a)).toEqual(Object.keys(b));
        expect(Object.keys(a).slice(-2)).toEqual(["profile", "posts"]);
        expect(events).toHaveLength(6);
      });
    });

    // --- the callback form -------------------------------------------------------------

    describe("callbacks", () => {
      test("a filter and an order of their own", async () => {
        const { repo, events } = watched();
        const users = await repo.all(
          from(User, "u")
            .preload("posts", (q) =>
              q.where(({ posts }) => posts.published).orderBy(({ posts }) => posts.views.desc()),
            )
            .orderBy(({ u }) => u.id),
        );
        expect(users.map((user) => user.posts.map((post) => post.id))).toEqual([[12, 10], [20], []]);
        expect(events).toHaveLength(2);
      });

      test("limit and offset apply per parent, in one statement", async () => {
        const { repo, events } = watched();
        const newest = await repo.all(
          from(User, "u")
            .preload("posts", (q) => q.orderBy(({ posts }) => posts.createdAt.desc()).limit(2))
            .orderBy(({ u }) => u.id),
        );
        expect(newest.map((user) => user.posts.map((post) => post.id))).toEqual([[12, 11], [20], []]);
        const second = await repo.all(
          from(User, "u")
            .preload("posts", (q) =>
              q
                .orderBy(({ posts }) => posts.createdAt.desc())
                .limit(1)
                .offset(1),
            )
            .orderBy(({ u }) => u.id),
        );
        expect(second.map((user) => user.posts.map((post) => post.id))).toEqual([[11], [], []]);
        const skipOnly = await repo.all(
          from(User, "u")
            .preload("posts", (q) => q.orderBy(({ posts }) => posts.createdAt).offset(1))
            .orderBy(({ u }) => u.id),
        );
        expect(skipOnly.map((user) => user.posts.map((post) => post.id))).toEqual([[11, 12], [], []]);
        expect(events).toHaveLength(6);
      });

      test("a limit uses the association's order when the callback has none", async () => {
        const { repo, events } = watched();
        const users = await repo.all(
          from(User, "u")
            .where(({ u }) => u.id.eq(1))
            .preload("posts", (q) => q.limit(1)),
        );
        expect(users[0]?.posts.map((post) => post.id)).toEqual([10]);
        expect(events).toHaveLength(2);
      });

      test("a limit with no order at all is refused when the query is built", () => {
        expect(() => from(Post, "p").preload("comments", (q) => q.limit(1))).not.toThrow();
        expect(() => from(Comment, "c").preload("post", (q) => q.limit(1))).toThrow(
          'limit in preload "post" needs an orderBy',
        );
      });

      test("a per-parent limit on a many-to-many, and nested callbacks", async () => {
        const { repo, events } = watched();
        const users = await repo.all(
          from(User, "u")
            .preload("posts", (q) =>
              q
                .orderBy(({ posts }) => posts.id)
                .preload("tags", (t2) => t2.orderBy(({ tags }) => tags.name.desc()).limit(1))
                .preload("comments", (c) =>
                  c
                    .orderBy(({ comments }) => comments.id.desc())
                    .limit(1)
                    .preload("author"),
                ),
            )
            .orderBy(({ u }) => u.id),
        );
        expect(users[0]?.posts.map((post) => post.tags.map((tag) => tag.name))).toEqual([
          ["ts"],
          [],
          ["sql"],
        ]);
        expect(users[0]?.posts[0]?.comments.map((comment) => comment.id)).toEqual([102]);
        expect(users[1]?.posts[0]?.comments[0]?.author?.id).toBe(1);
        expect(events).toHaveLength(5);
      });

      test("a select with the key loads plain objects of that shape", async () => {
        const { repo, events } = watched();
        const users = await repo.all(
          from(User, "u")
            .preload("posts", (q) =>
              q
                .select(({ posts }) => ({ authorId: posts.authorId, title: posts.title }))
                .orderBy(({ posts }) => posts.id),
            )
            .orderBy(({ u }) => u.id),
        );
        expect(users[0]?.posts).toEqual([
          { authorId: 1, title: "Engines" },
          { authorId: 1, title: "Notes (draft)" },
          { authorId: 1, title: "Loops" },
        ]);
        expect(Object.getPrototypeOf(users[0]?.posts[0])).toBe(Object.prototype);
        expect(events).toHaveLength(2);
      });

      test("a select with a per-parent limit", async () => {
        const { repo, events } = watched();
        const users = await repo.all(
          from(User, "u")
            .preload("posts", (q) =>
              q
                .select(({ posts }) => ({ authorId: posts.authorId, title: posts.title }))
                .orderBy(({ posts }) => posts.id.desc())
                .limit(1),
            )
            .orderBy(({ u }) => u.id),
        );
        expect(users.map((user) => user.posts.map((post) => post.title))).toEqual([
          ["Loops"],
          ["Compilers"],
          [],
        ]);
        expect(events).toHaveLength(2);
      });

      test("a select without the key is refused when the query is built", () => {
        expect(() =>
          from(User, "u").preload("posts", (q) => q.select(({ posts }) => ({ title: posts.title })) as never),
        ).toThrow('preload "posts" selects without its key');
        expect(() =>
          from(Post, "p").preload(
            "author",
            (q) => q.select(({ author }) => ({ email: author.email })) as never,
          ),
        ).toThrow('preload "author" selects without its key');
      });

      test("a callback's named parameters come with the query's", async () => {
        const { repo, events } = watched();
        const query = from(User, "u")
          .where(({ u }) => u.id.lte(param("maxId", t.bigint({ mode: "number" }))))
          .preload("posts", (q) => q.where(({ posts }) => posts.views.gte(param("minViews", t.integer()))))
          .orderBy(({ u }) => u.id);
        const users = await repo.all(query, { maxId: 2, minViews: 6 });
        expect(users.map((user) => user.posts.map((post) => post.id))).toEqual([[12], [20]]);
        await expect(repo.all(query, { maxId: 2 } as never)).rejects.toThrow(/minViews/);
        expect(events).toHaveLength(2);
      });
    });

    // --- join preloads -------------------------------------------------------------------

    describe("join preloads", () => {
      test("one statement; a parent repeated by its children is one row", async () => {
        const { repo, events } = watched();
        const users = await repo.all(
          from(User, "u")
            .joinAssoc("u", "posts", "p")
            .where(({ p }) => p.published)
            .orderBy(({ u, p }) => [u.id, p.id])
            .preload({ posts: "p" }),
        );
        expect(users.map((user) => [user.id, user.posts.map((post) => post.id)])).toEqual([
          [1, [10, 12]],
          [2, [20]],
        ]);
        expect(events).toHaveLength(1);
      });

      test("nested join preloads, and a separate preload below them", async () => {
        const { repo, events } = watched();
        const users = await repo.all(
          from(User, "u")
            .leftJoinAssoc("u", "posts", "p")
            .leftJoinAssoc("p", "comments", "c")
            .orderBy(({ u, p, c }) => [u.id, p.id, c.id])
            .preload({ posts: { $from: "p", comments: "c", tags: true } }),
        );
        expect(
          users.map((user) => user.posts.map((post) => [post.id, post.comments.map((c) => c.id)])),
        ).toEqual([
          [
            [10, [100, 101, 102]],
            [11, []],
            [12, []],
          ],
          [[20, [103]]],
          [],
        ]);
        expect(users[0]?.posts[0]?.tags.map((tag) => tag.name).sort()).toEqual(["sql", "ts"]);
        expect(operations(events)).toEqual(["all users", "preload tags"]);
      });

      test("a to-one join preload", async () => {
        const { repo, events } = watched();
        const comments = await repo.all(
          from(Comment, "c")
            .leftJoinAssoc("c", "author", "a")
            .orderBy(({ c }) => c.id)
            .preload({ author: "a", post: true }),
        );
        expect(comments.map((comment) => comment.author?.id ?? null)).toEqual([2, 2, null, 1]);
        expect(comments[0]?.post.title).toBe("Engines");
        expect(events).toHaveLength(2);
      });
    });

    // --- other reads -------------------------------------------------------------------

    describe("other reads", () => {
      test("one, first, getBy and count", async () => {
        const { repo, events } = watched();
        const query = from(User, "u").preload("posts");
        const ada = await repo.getByOrThrow(query, { email: "ada@example.com" });
        expect(ada.posts).toHaveLength(3);
        const first = await repo.first(query.orderBy(({ u }) => u.id.desc()));
        expect(first?.posts).toEqual([]);
        expect(await repo.count(query)).toBe(3);
        expect(operations(events)).toEqual([
          "getBy users",
          "preload posts",
          "first users",
          "preload posts",
          "aggregate users",
        ]);
      });

      test("a stream refuses preloads", async () => {
        const { repo } = watched();
        const rows = repo.stream(from(User, "u").preload("posts"));
        await expect(async () => {
          for await (const _ of rows) {
            // nothing
          }
        }).rejects.toThrow(QueryError);
      });

      test("a repo without generated code loads the same rows", async () => {
        const plain = watched({ codegen: false }).repo;
        const generated = watched().repo;
        const query = from(User, "u")
          .preload({ posts: { comments: "author" }, orgs: true })
          .orderBy(({ u }) => u.id);
        expect(await plain.all(query)).toEqual(await generated.all(query));
      });

      test("children read from another database schema come from that schema", async (context) => {
        if (profile.copyTableInto === undefined)
          return context.skip("the profile has no database schemas to copy a table into");
        await db.exec(profile.copyTableInto("history", "posts", db));
        await db.exec(profile.copyTableInto("history", "users", db));
        await db.exec(
          "insert into history.users (id, email) values (1, 'old@example.com'); insert into history.posts (id, author_id, title) values (90, 1, 'Archived')",
        );
        const { repo, events } = watched();
        const users = await repo.all(from(User, "u").preload("posts"), { schema: "history" });
        expect(users.map((user) => user.posts.map((post) => post.title))).toEqual([["Archived"]]);
        const archived = users[0]?.posts[0] as unknown as { readonly [ROW]: { readonly schema: string } };
        expect(archived[ROW].schema).toBe("history");
        expect(events).toHaveLength(2);
      });
    });

    // --- after the fact ------------------------------------------------------------------

    describe("repo.preload", () => {
      test("loads onto rows already read, as new rows", async () => {
        const { repo, events } = watched();
        const users = await repo.all(from(User, "u").orderBy(({ u }) => u.id));
        const loaded = await repo.preload(User, users, { posts: "comments" });
        expect(loaded.map((user) => user.posts.length)).toEqual([3, 1, 0]);
        expect(loaded[0]?.posts[0]?.comments).toHaveLength(3);
        expect(loaded[0]).not.toBe(users[0]);
        expect(Object.hasOwn(users[0] as object, "posts")).toBe(false);
        expect(loaded[0]).toBeInstanceOf(User);
        expect(operations(events)).toEqual(["all users", "preload posts", "preload comments"]);
      });

      test("one row, null and an empty array", async () => {
        const { repo, events } = watched();
        const ada = await repo.getOrThrow(User, 1);
        const one = await repo.preload(User, ada, "profile");
        expect(one.profile?.bio).toBe("Mathematician");
        expect(await repo.preload(User, null, "profile")).toBeNull();
        expect(await repo.preload(User, [], "profile")).toEqual([]);
        expect(events).toHaveLength(2);
      });

      test("skips what is loaded unless forced, and adds to it", async () => {
        const { repo, events } = watched();
        const users = await repo.all(
          from(User, "u")
            .preload("posts", (q) => q.where(({ posts }) => posts.published))
            .orderBy(({ u }) => u.id),
        );
        const more = await repo.preload(User, users, ["posts", "profile"]);
        expect(more[0]?.posts.map((post) => post.id)).toEqual([10, 12]);
        expect(more[0]?.profile?.bio).toBe("Mathematician");
        const forced = await repo.preload(User, users, "posts", { force: true });
        expect(forced[0]?.posts.map((post) => post.id)).toEqual([10, 11, 12]);
        const deeper = await repo.preload(User, users, { posts: "comments" });
        expect(deeper[0]?.posts.map((post) => post.comments.length)).toEqual([3, 0]);
        expect(users[0]?.posts[0]).not.toHaveProperty("comments");
        expect(operations(events)).toEqual([
          "all users",
          "preload posts",
          "preload profiles",
          "preload posts",
          "preload comments",
        ]);
      });

      test("the callback form", async () => {
        const { repo, events } = watched();
        const users = await repo.all(from(User, "u").orderBy(({ u }) => u.id));
        const top = await repo.preload(User, users, "posts", (q) =>
          q.orderBy(({ posts }) => posts.views.desc()).limit(1),
        );
        expect(top.map((user) => user.posts.map((post) => post.id))).toEqual([[12], [20], []]);
        expect(events).toHaveLength(2);
      });

      test("rows of another schema are refused", async () => {
        const { repo } = watched();
        const post = await repo.getOrThrow(Post, 10);
        await expect(repo.preload(User, [post] as never, "posts")).rejects.toThrow(QueryError);
        await expect(repo.preload(User, [{ id: 1 }] as never, "posts")).rejects.toThrow(TypeError);
      });
    });

    describe("reload", () => {
      test("loads again what the row had loaded, from the database", async () => {
        const { repo, events } = watched();
        const ada = await repo.oneOrThrow(
          from(User, "u")
            .where(({ u }) => u.id.eq(1))
            .preload({ posts: "comments", profile: true }),
        );
        await db.exec("update profiles set bio = 'Analyst' where id = 1");
        try {
          const fresh = await repo.reloadOrThrow(ada);
          expect(fresh.profile?.bio).toBe("Analyst");
          expect(fresh.posts.map((post) => post.comments.length)).toEqual([3, 0, 0]);
          expect(fresh).not.toBe(ada);
          expect(operations(events).slice(4)).toEqual([
            "reload users",
            "preload profiles",
            "preload posts",
            "preload comments",
          ]);
        } finally {
          await db.exec("update profiles set bio = 'Mathematician' where id = 1");
        }
      });

      test("a row that had nothing loaded is reloaded alone", async () => {
        const { repo, events } = watched();
        const ada = await repo.getOrThrow(User, 1);
        const fresh = await repo.reloadOrThrow(ada);
        expect(Object.hasOwn(fresh, "posts")).toBe(false);
        expect(events).toHaveLength(2);
      });
    });

    // --- assoc() and isLoaded() --------------------------------------------------------

    describe("assoc and isLoaded", () => {
      test("assoc() is a query for the associated rows of one parent or several", async () => {
        const { repo } = watched();
        const ada = await repo.getOrThrow(User, 1);
        const users = await repo.all(from(User, "u").orderBy(({ u }) => u.id));
        const drafts = await repo.all(
          assoc(User, ada, "posts").where(({ posts }) => posts.published.eq(false)),
        );
        expect(drafts.map((post) => post.id)).toEqual([11]);
        const all = await repo.all(assoc(User, users, "posts").orderBy(({ posts }) => posts.id));
        expect(all.map((post) => post.id)).toEqual([10, 11, 12, 20]);
        const post = await repo.getOrThrow(Post, 20);
        expect((await repo.oneOrThrow(assoc(Post, post, "author"))).email).toBe("grace@example.com");
        const tags = await repo.all(assoc(Post, post, "tags"));
        expect(tags.map((tag) => tag.name)).toEqual(["orm"]);
        const comments = await repo.all(assoc(User, ada, "comments").orderBy(({ comments }) => comments.id));
        expect(comments.map((comment) => comment.id)).toEqual([100, 101, 102]);
        const shelf = await repo.getOrThrow(Shelf, { region: "north", code: 1 });
        expect((await repo.all(assoc(Shelf, shelf, "volumes"))).map((v) => v.id).sort()).toEqual([1, 2]);
        expect(await repo.count(assoc(User, [], "posts"))).toBe(0);
        const featured = await repo.all(
          assoc(LabeledPost, await repo.getOrThrow(LabeledPost, 10), "featured"),
        );
        expect(featured.map((tag) => tag.name)).toEqual(["sql"]);
        const writer = await repo.getOrThrow(Writer, 1);
        expect((await repo.all(assoc(Writer, writer, "tags"))).map((tag) => tag.name).sort()).toEqual([
          "sql",
          "ts",
        ]);
      });

      test("isLoaded tells a loaded association from one that is not", async () => {
        const { repo } = watched();
        const bare = await repo.getOrThrow(User, 1);
        const loaded = await repo.preload(User, bare, "posts");
        expect(isLoaded(User, bare, "posts")).toBe(false);
        expect(isLoaded(User, loaded, "posts")).toBe(true);
        expect(isLoaded(User, loaded, "profile")).toBe(false);
      });
    });

    // --- transactions and many parents --------------------------------------------------

    test("inside a transaction, every statement runs on its connection and sees its writes", async () => {
      const shared = adapter({ poolMax: 2 });
      const connection = await shared.acquire();
      try {
        await connection.execute("begin", []);
        await connection.execute(
          "insert into posts (id, author_id, title) values (30, 3, 'Uncommitted'), (31, 3, 'Also')",
          [],
        );
        const hub = new QueryHub(shared, false);
        const events: RepoQueryEvent[] = [];
        hub.on((event) => events.push(event));
        const core = new ReadCore(shared, connection, undefined, true, hub);
        const query = from(User, "u")
          .where(({ u }) => u.id.eq(3))
          .preload(["profile", { posts: ["comments", "tags"] }]);
        const rows = (await load(core, "all", query.ast, undefined, { maxConcurrency: 4 })) as {
          posts: { title: string }[];
        }[];
        expect(rows[0]?.posts.map((post) => post.title)).toEqual(["Uncommitted", "Also"]);
        expect(events).toHaveLength(5);
        hub.close();
      } finally {
        await connection.execute("rollback", []);
        await connection.release();
      }
      const { repo } = watched();
      expect(await repo.count(from(Post, "p").where(({ p }) => p.id.gte(30)))).toBe(0);
    });

    test("through repo.transaction, preloads run on the transaction's connection and see its writes", async ({
      onTestFinished,
    }) => {
      // The transaction commits the posts: remove them again for the tests after this one,
      // whether this one passes or not (through the helper's connection, which outlives the
      // adapters the suite closes after each test).
      onTestFinished(() => db.exec("delete from posts where id >= 40"));
      const { repo, events } = watched();
      // With one shared handle there is no connection outside the transaction to ask
      // (capability multipleConnections): that part is left out.
      const outsideExists = adapter().capabilities.multipleConnections;
      const result = await repo.transaction(async (tx) => {
        await tx.raw(
          fragment`insert into posts (id, author_id, title) values (${40}, ${3}, ${"In the transaction"}), (${41}, ${3}, ${"Also in it"})`,
        );
        const rows = await tx.all(
          from(User, "u")
            .where(({ u }) => u.id.eq(3))
            .preload(["profile", { posts: ["comments", "tags"] }]),
          { maxConcurrency: 4 },
        );
        // A connection outside the transaction does not see the posts yet.
        const outside = outsideExists
          ? await repo.count(from(Post, "p").where(({ p }) => p.id.gte(40)))
          : undefined;
        return { titles: rows[0]?.posts.map((post) => post.title), outside };
      });
      expect(result).toEqual({
        success: true,
        data: { titles: ["In the transaction", "Also in it"], outside: outsideExists ? 0 : undefined },
      });
      expect(operations(events)).toEqual([
        "transaction",
        "raw",
        "all users",
        "preload profiles",
        "preload posts",
        "preload comments",
        "preload tags",
        ...(outsideExists ? ["aggregate posts"] : []),
        "transaction",
      ]);
      // Committed with the transaction.
      expect(await repo.count(from(Post, "p").where(({ p }) => p.id.gte(40)))).toBe(2);
    });

    test("many parents: the keys are sent in statements of at most chunkKeys", async () => {
      const count = 2_500;
      await db.exec(profile.insertUsers(count));
      const before = preloadLimits.chunkKeys;
      try {
        const { repo, events } = watched();
        const users = await repo.all(
          from(User, "u")
            .where(({ u }) => u.id.gt(1000))
            .preload("posts"),
        );
        expect(users).toHaveLength(count);
        expect(events).toHaveLength(2);
        preloadLimits.chunkKeys = 1_000;
        events.length = 0;
        const again = await repo.all(
          from(User, "u")
            .where(({ u }) => u.id.gt(1000).or(u.id.eq(1)))
            .preload({ posts: "comments" }),
        );
        expect(again).toHaveLength(count + 1);
        expect(again.find((user) => user.id === 1)?.posts).toHaveLength(3);
        expect(operations(events)).toEqual([
          "all users",
          "preload posts",
          "preload posts",
          "preload posts",
          "preload comments",
        ]);
      } finally {
        preloadLimits.chunkKeys = before;
        await db.exec("delete from users where id > 1000");
      }
    });

    test("timeoutMs is one budget for the query and its preloads", async () => {
      // Where a running statement can be cancelled, each statement alone fits the budget and
      // the preload is stopped while it runs. Where it cannot (capability cancel false), the
      // query overruns the budget, and the preload must be refused before it starts.
      const cancels = adapter().capabilities.cancel;
      const { repo, events } = watched();
      const error = await repo
        .all(
          from(Profile, "p")
            .where(() => profile.sleep(cancels ? 0.6 : 1.2))
            .preload("user", (q) => q.where(() => profile.sleep(0.6))),
          { timeoutMs: 1_000 },
        )
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(DatabaseError);
      expect((error as DatabaseError).code).toBe("timeout");
      expect((error as Error).message).toContain("timeoutMs (1000 ms)");
      // The preload is reported either way: stopped while it ran, or refused before it started.
      expect(operations(events)).toEqual(["all profiles", "preload users"]);
    });

    test("children of a parent whose class declares a database schema are read with the call's", async (context) => {
      if (profile.copyTableInto === undefined)
        return context.skip("the profile has no database schemas to copy a table into");
      await db.exec(profile.copyTableInto("auth", "users", db));
      await db.exec(profile.copyTableInto("auth", "posts", db));
      await db.exec(
        "insert into auth.users (id, email) values (1, 'auth@example.com'); insert into auth.posts (id, author_id, title) values (99, 1, 'Decoy')",
      );
      class AuthUser extends Schema(
        "users",
        { id: t.bigint({ mode: "number" }).primaryKey(), email: t.string() },
        { schema: "auth" },
      ) {
        static posts = hasMany(() => Post, { foreignKey: "authorId", orderBy: ["id"] });
      }
      const { repo, events } = watched();
      const users = await repo.all(from(AuthUser, "u").preload("posts"));
      expect(users.map((user) => [user.email, user.posts.map((post) => post.title)])).toEqual([
        ["auth@example.com", ["Engines", "Notes (draft)", "Loops"]],
      ]);
      const again = await repo.preload(AuthUser, await repo.all(AuthUser), "posts", { force: true });
      expect(again[0]?.posts.map((post) => post.id)).toEqual([10, 11, 12]);
      expect(events).toHaveLength(4);
      // With the query's own schema, the children come from it, and a reload reads there too.
      await db.exec(profile.copyTableInto("tenant", "posts", db));
      await db.exec("insert into tenant.posts (id, author_id, title) values (77, 1, 'Tenant post')");
      const [inTenant] = await repo.all(from(AuthUser, "u").schema("tenant").preload("posts"));
      expect(inTenant?.posts.map((post) => post.title)).toEqual(["Tenant post"]);
      const reloaded = await repo.reloadOrThrow(inTenant as AuthUser & { posts: Post[] });
      expect(reloaded.posts.map((post) => post.title)).toEqual(["Tenant post"]);
    });

    test("reload loads a level that was loaded empty with what is below it", async () => {
      const { repo } = watched();
      const linus = await repo.oneOrThrow(
        from(User, "u")
          .where(({ u }) => u.id.eq(3))
          .preload({ posts: "comments" }),
      );
      expect(linus.posts).toEqual([]);
      await db.exec("insert into posts (id, author_id, title) values (50, 3, 'Kernels')");
      try {
        const fresh = await repo.reloadOrThrow(linus);
        expect(fresh.posts.map((post) => [post.title, post.comments])).toEqual([["Kernels", []]]);
      } finally {
        await db.exec("delete from posts where id = 50");
      }
    });

    test("a row an update returned reloads with the preloads it was loaded with", async () => {
      const { repo } = watched();
      const linus = await repo.oneOrThrow(
        from(User, "u")
          .where(({ u }) => u.id.eq(3))
          .preload({ posts: "comments" }),
      );
      const updated = await repo.updateOrThrow(change(linus, { name: "Linus" }));
      await db.exec("insert into posts (id, author_id, title) values (51, 3, 'Drivers')");
      try {
        const fresh = await repo.reloadOrThrow(updated);
        expect(fresh.posts.map((post) => [post.title, post.comments])).toEqual([["Drivers", []]]);
      } finally {
        await db.exec("delete from posts where id = 51; update users set name = null where id = 3");
      }
    });

    test("a per-parent limit in a callback that join-preloads a to-many association is refused", async () => {
      const { repo, events } = watched();
      await expect(
        repo.all(
          from(User, "u").preload("posts", (q) =>
            q
              .leftJoinAssoc("posts", "comments", "c")
              .preload({ comments: "c" })
              .orderBy(({ posts }) => posts.id)
              .limit(2),
          ),
        ),
      ).rejects.toThrow('its callback preloads "comments" from a join');
      expect(events).toEqual([]);
    });

    test("repo.first and a limit refuse a to-many join preload, before anything runs", async () => {
      const { repo, events } = watched();
      const joined = from(User, "u").joinAssoc("u", "posts", "p").preload({ posts: "p" });
      await expect(repo.first(joined)).rejects.toThrow(QueryError);
      await expect(repo.all(joined.limit(2))).rejects.toThrow(
        'Preload "posts" with a separate query instead',
      );
      expect(events).toEqual([]);
    });

    test("Membership rows reach their org by a uuid key", async () => {
      const { repo, events } = watched();
      const memberships = await repo.all(
        from(Membership, "m")
          .preload({ org: "users" })
          .orderBy(({ m }) => [m.userId, m.role]),
      );
      expect(memberships.map((m) => m.org.name)).toEqual(["Babbage", "Analytical", "Analytical"]);
      expect(memberships[1]?.org.users.map((u) => u.id).sort()).toEqual([1, 2]);
      expect(events).toHaveLength(3);
    });
  });
}
