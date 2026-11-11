// Type tests for the callback parameters of the query builder. The bindings of the
// filter, grouping and ordering callbacks and of a join's `on`, and the changeset given to
// a changeset's `pipe`, are declared `NoInfer<…>`, so that inferring a call's type
// arguments does not walk from them into every schema reachable through associations
// (test/editor/completions.test.ts measures that). These tests pin what must not change
// with it: what the callbacks receive, what the calls infer from their other arguments and
// from the callback's result, and which callback values are accepted. The preload and
// `pipe` callbacks of a query are here too, unchanged, as the neighbours they are.
import { type Comment, Post, Profile, User } from "@egon-orm/test-support";
import { describe, expectTypeOf, test } from "vitest";
import { type Changeset, cast } from "../changeset/changeset.js";
import type { LoadedAs } from "../contracts/schema.js";
import type { Repo } from "../repo/repo.js";
import { t } from "../schema/index.js";
import type { Binding } from "./bindings.js";
import { from, type PreloadQuery, type QueryParams, type QueryResult, type QueryWith } from "./builder.js";
import type { Expr } from "./expr.js";
import { count, param } from "./functions.js";

declare const repo: Repo;

describe("what a callback receives", () => {
  test("the filter, grouping and ordering callbacks receive the query's bindings", () => {
    from(User, "u")
      .where(({ u }) => {
        expectTypeOf(u).toEqualTypeOf<Binding<typeof User>>();
        return u.age.gte(18);
      })
      .orWhere(({ u }) => {
        expectTypeOf(u).toEqualTypeOf<Binding<typeof User>>();
        return u.role.eq("admin");
      })
      .distinct(({ u }) => {
        expectTypeOf(u).toEqualTypeOf<Binding<typeof User>>();
        return u.email;
      })
      .groupBy(({ u }) => {
        expectTypeOf(u).toEqualTypeOf<Binding<typeof User>>();
        return u.id;
      })
      .having(({ u }) => {
        expectTypeOf(u).toEqualTypeOf<Binding<typeof User>>();
        return count(u.id).gt(1);
      })
      .orderBy(({ u }) => {
        expectTypeOf(u).toEqualTypeOf<Binding<typeof User>>();
        return u.id;
      });
  });

  test("a join's on callback receives the bindings with the new one, nullable as the join makes it", () => {
    from(User, "u").join(Post, "p", (bindings) => {
      expectTypeOf(bindings.u).toEqualTypeOf<Binding<typeof User>>();
      expectTypeOf(bindings.p).toEqualTypeOf<Binding<typeof Post>>();
      return bindings.p.authorId.eq(bindings.u.id);
    });
    from(User, "u").leftJoin(Profile, "pr", ({ u, pr }) => {
      expectTypeOf(u).toEqualTypeOf<Binding<typeof User>>();
      expectTypeOf(pr).toEqualTypeOf<Binding<typeof Profile, true>>();
      return pr.userId.eq(u.id);
    });
    from(Post, "p").rightJoin(User, "u", ({ p, u }) => {
      expectTypeOf(p).toEqualTypeOf<Binding<typeof Post, true>>();
      expectTypeOf(u).toEqualTypeOf<Binding<typeof User>>();
      return p.authorId.eq(u.id);
    });
    from(User, "u").fullJoin(Profile, "pr", ({ u, pr }) => {
      expectTypeOf(u).toEqualTypeOf<Binding<typeof User, true>>();
      expectTypeOf(pr).toEqualTypeOf<Binding<typeof Profile, true>>();
      return pr.userId.eq(u.id);
    });
    from(User, "u").joinAssoc("u", "posts", "p", ({ u, p }) => {
      expectTypeOf(u).toEqualTypeOf<Binding<typeof User>>();
      expectTypeOf(p).toEqualTypeOf<Binding<typeof Post>>();
      return p.published;
    });
    from(Post, "p").leftJoinAssoc("p", "comments", "c", ({ c }) => {
      expectTypeOf(c).toEqualTypeOf<Binding<typeof Comment, true>>();
      return c.body.isNotNull();
    });
  });

  test("a preload callback receives the association's query, and pipe the query itself", () => {
    from(User, "u").preload("posts", (q) => {
      expectTypeOf(info(q)).toEqualTypeOf<PreloadQuery<typeof User, "posts">["~query"]>();
      return q;
    });
    const base = from(User, "u");
    base.pipe((q) => {
      expectTypeOf(info(q)).toEqualTypeOf(info(base));
      return q;
    });
  });

  test("a changeset's pipe receives the changeset", () => {
    const changeset = cast(User, {}, ["email"]);
    changeset.pipe((c) => {
      expectTypeOf(c).toEqualTypeOf(changeset);
      return c;
    });
  });
});

describe("what the calls still infer", () => {
  test("named parameters come from the callback's result", () => {
    const q = from(User, "u")
      .where(({ u }) => u.age.gte(param("minAge", t.integer())))
      .orderBy(({ u }) => u.email)
      .join(Post, "p", ({ u, p }) => p.authorId.eq(u.id).and(p.views.gt(param("minViews", t.integer()))));
    expectTypeOf<QueryParams<typeof q>>().toEqualTypeOf<{ minAge: number; minViews: number }>();
  });

  test("a join's alias and source come from its other arguments", () => {
    const q = from(User, "u").join(Post, "p", ({ u, p }) => p.authorId.eq(u.id));
    q.where((bindings) => {
      expectTypeOf(bindings).toEqualTypeOf<
        { readonly u: Binding<typeof User> } & { readonly p: Binding<typeof Post> }
      >();
      return bindings.p.published;
    });
  });

  test("pipe and a changeset's pipe return what the function returns", () => {
    expectTypeOf(from(User, "u").pipe(() => "done" as const)).toEqualTypeOf<"done">();
    expectTypeOf(cast(User, {}, ["email"]).pipe((c) => c.validateRequired(["email"]))).toEqualTypeOf<
      Changeset<typeof User, true, never>
    >();
  });

  test("preload results are unchanged, from the query and from the repo", async () => {
    const loaded = from(User, "u").preload("posts", (q) => q.where(({ posts }) => posts.published).limit(3));
    expectTypeOf<QueryResult<typeof loaded>["posts"]>().toEqualTypeOf<Post[]>();
    const shaped = from(User, "u").preload("posts", (q) =>
      q.select(({ posts }) => ({ authorId: posts.authorId, title: posts.title })),
    );
    expectTypeOf<QueryResult<typeof shaped>["posts"]>().toEqualTypeOf<
      { authorId: number; title: string }[]
    >();
    const users = await repo.all(from(User, "u"));
    const withPosts = await repo.preload(User, users, "posts", (q) =>
      q.where(({ posts }) => posts.published),
    );
    expectTypeOf(withPosts).toEqualTypeOf<LoadedAs<typeof User, "posts", Post>[]>();
  });
});

describe("which callback values are accepted", () => {
  test("a function declared beforehand, with its parameter typed", () => {
    const adults = ({ u }: { readonly u: Binding<typeof User> }): Expr<boolean> =>
      u.age.gte(18).and(u.email.isNotNull());
    expectTypeOf<QueryResult<ReturnType<typeof run>>>().toEqualTypeOf<User>();
    function run() {
      return from(User, "u").where(adults);
    }
    const onAuthor = ({ u, p }: { readonly u: Binding<typeof User>; readonly p: Binding<typeof Post> }) =>
      p.authorId.eq(u.id);
    from(User, "u").join(Post, "p", onAuthor);
  });

  test("a generic function, instantiated from the bindings", () => {
    const published = <B extends { readonly p: Binding<typeof Post> }>({ p }: B) => p.published;
    expectTypeOf(info(from(Post, "p").where(published))).toEqualTypeOf(info(from(Post, "p")));
  });

  test("a scope over any query with the binding", () => {
    const recent = <Q extends QueryWith<{ p: typeof Post }>>(q: Q) =>
      q.orderBy(({ p }) => p.createdAt.desc());
    const q = from(Post, "p")
      .select(({ p }) => ({ id: p.id }))
      .pipe(recent);
    expectTypeOf<QueryResult<typeof q>>().toEqualTypeOf<{ id: number }>();
  });

  test("a callback over a binding the query does not have does not compile", () => {
    // @ts-expect-error the query has no binding p
    from(User, "u").where(({ p }) => p.published);
    // @ts-expect-error a join's on gets the new binding as p, not q
    from(User, "u").join(Post, "p", ({ q }) => q.published);
  });
});

/** A query's type information; comparing these compares the query types. */
function info<Q extends { readonly "~query": unknown }>(query: Q): Q["~query"] {
  return query["~query"];
}
