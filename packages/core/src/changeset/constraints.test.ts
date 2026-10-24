import { Comment, Membership, Post, Profile, Tag, User, UserSettings } from "@egon-orm/test-support";
import { afterEach, describe, expect, test } from "vitest";
import type { AnySchema, Row } from "../contracts/schema.js";
import { QueryError } from "../errors.js";
import { belongsTo, hasMany, meta, Schema, t } from "../schema/index.js";
import { cast, change, provideValidateUniqueAsync, withRepo } from "./changeset.js";

function loaded<S extends AnySchema>(schema: S, values: Readonly<Record<string, unknown>>): Row<S> {
  const info = meta(schema);
  return info.create(
    info.persisted.map((field) => (Object.hasOwn(values, field.name) ? values[field.name] : null)),
    info.rowMeta("loaded", undefined),
  ) as Row<S>;
}

class Project extends Schema("projects", {
  id: t.integer().primaryKey().dbGenerated(),
  orgId: t.uuid(),
  slug: t.string(),
  during: t.string().nullable(),
}) {}

describe("constraint declarations", () => {
  test("uniqueConstraint: default name from the table and columns, message and error key", () => {
    expect(change(User).uniqueConstraint("email").constraints).toEqual([
      {
        type: "unique",
        name: "users_email_key",
        match: "exact",
        field: "email",
        message: "has already been taken",
      },
    ]);
    expect(change(Project).uniqueConstraint(["orgId", "slug"]).constraints).toEqual([
      {
        type: "unique",
        name: "projects_org_id_slug_key",
        match: "exact",
        field: "orgId",
        message: "has already been taken",
      },
    ]);
  });

  test("uniqueConstraint uses a field's own column name", () => {
    expect(change(Post).uniqueConstraint("tagList").constraints[0]?.name).toBe("posts_tags_key");
  });

  test("every option is kept", () => {
    expect(
      change(User).uniqueConstraint("email", {
        name: "uq_users_email",
        match: "suffix",
        message: "is already registered",
        errorKey: "login",
      }).constraints,
    ).toEqual([
      {
        type: "unique",
        name: "uq_users_email",
        match: "suffix",
        field: "login",
        message: "is already registered",
      },
    ]);
  });

  test("foreignKeyConstraint: <table>_<column>_fkey, does not exist", () => {
    expect(change(Post).foreignKeyConstraint("authorId").constraints).toEqual([
      {
        type: "foreignKey",
        name: "posts_author_id_fkey",
        match: "exact",
        field: "authorId",
        message: "does not exist",
      },
    ]);
  });

  test("assocConstraint: the belongsTo's foreign key, reported on the association", () => {
    expect(change(Comment).assocConstraint("post").constraints).toEqual([
      {
        type: "foreignKey",
        name: "comments_post_id_fkey",
        match: "exact",
        field: "post",
        message: "does not exist",
      },
    ]);
    expect(change(Profile).assocConstraint("user", { message: "is gone" }).constraints[0]?.message).toBe(
      "is gone",
    );
  });

  test("assocConstraint refuses another kind of association, or an unknown one", () => {
    expect(() => change(User).assocConstraint("posts")).toThrowErrorMatchingInlineSnapshot(
      `[QueryError: query.assocConstraintKind: assocConstraint(): "posts" is a hasMany association. It applies to belongsTo associations; for the other side, use noAssocConstraint. See https://egon-orm.github.io/egon-orm/reference/errors/query#query-assocconstraintkind]`,
    );
    expect(() => change(User).assocConstraint("nope" as never)).toThrow(QueryError);
  });

  test("noAssocConstraint: the child table's foreign key, reported on the association", () => {
    expect(change(User).noAssocConstraint("posts").constraints).toEqual([
      {
        type: "noAssoc",
        name: "posts_author_id_fkey",
        match: "exact",
        field: "posts",
        message: "is still associated with this entry",
      },
    ]);
    expect(change(User).noAssocConstraint("profile").constraints[0]?.name).toBe("profiles_user_id_fkey");
  });

  test("noAssocConstraint refuses belongsTo, manyToMany and has-through associations", () => {
    expect(() => change(Post).noAssocConstraint("author")).toThrow(/belongsTo/);
    expect(() => change(Tag).noAssocConstraint("posts")).toThrow(/manyToMany/);
    expect(() => change(User).noAssocConstraint("comments")).toThrow(/has-through/);
  });

  test("checkConstraint needs a name and says is invalid", () => {
    expect(change(User).checkConstraint("age", { name: "users_age_check" }).constraints).toEqual([
      { type: "check", name: "users_age_check", match: "exact", field: "age", message: "is invalid" },
    ]);
    expect(() => change(User).checkConstraint("age", {} as never)).toThrow(QueryError);
    expect(() => change(User).checkConstraint("age", undefined as never)).toThrow(QueryError);
  });

  test("exclusionConstraint: <table>_<column>_excl", () => {
    expect(change(Project).exclusionConstraint("during").constraints).toEqual([
      {
        type: "exclusion",
        name: "projects_during_excl",
        match: "exact",
        field: "during",
        message: "violates an exclusion constraint",
      },
    ]);
  });

  test("declarations accumulate in order and leave the rest of the changeset alone", () => {
    const cs = cast(User, { email: "x@example.com" }, ["email"]);
    const declared = cs.uniqueConstraint("email").checkConstraint("age", { name: "c" });
    expect(declared.constraints.map((constraint) => constraint.type)).toEqual(["unique", "check"]);
    expect(declared.changes).toBe(cs.changes);
    expect(declared.errors).toBe(cs.errors);
    expect(cs.constraints).toEqual([]);
  });

  test("without a table there is no default name", () => {
    expect(() => change(UserSettings).uniqueConstraint("theme")).toThrow(/has no table/);
    expect(() =>
      change({ data: {}, types: { q: t.string() } }).uniqueConstraint("q"),
    ).toThrowErrorMatchingInlineSnapshot(
      `[QueryError: query.constraintNoTable: uniqueConstraint(): a changeset without a schema class has no table, so the constraint has no default name. Pass it: { name: "…" }. See https://egon-orm.github.io/egon-orm/reference/errors/query#query-constraintnotable]`,
    );
    expect(
      change({ data: {}, types: { q: t.string() } }).uniqueConstraint("q", { name: "q_key" }).constraints,
    ).toHaveLength(1);
  });

  test("bad options are refused", () => {
    const cs = change(User);
    expect(() => cs.uniqueConstraint([])).toThrow(QueryError);
    expect(() => cs.uniqueConstraint("nope" as never)).toThrow(QueryError);
    expect(() => cs.uniqueConstraint("email", { match: "contains" as never })).toThrow(QueryError);
    expect(() => cs.uniqueConstraint("email", { name: "" })).toThrow(QueryError);
    expect(() => cs.uniqueConstraint("email", { message: 1 as never })).toThrow(QueryError);
    expect(() => cs.uniqueConstraint("email", { errorKey: "__proto__" })).toThrow(QueryError);
    expect(() => cs.uniqueConstraint("email", "x" as never)).toThrow(QueryError);
    expect(() => cs.foreignKeyConstraint("nope" as never)).toThrow(QueryError);
    expect(() => cs.exclusionConstraint("nope" as never)).toThrow(QueryError);
  });

  test("options that are not an object, a name that is not a string, an empty check name are refused", () => {
    const cs = change(User);
    // A string's own `match` method would fail the match check; a number or null has none.
    expect(() => cs.uniqueConstraint("email", 5 as never)).toThrow("the options must be an object");
    expect(() => cs.uniqueConstraint("email", null as never)).toThrow("the options must be an object");
    expect(() => cs.uniqueConstraint("email", { name: 5 as never })).toThrow(
      "name must be a non-empty string",
    );
    expect(() => cs.checkConstraint("age", { name: "" })).toThrow(
      "checkConstraint() needs the constraint's name.",
    );
  });

  test("each match mode is accepted", () => {
    for (const match of ["exact", "suffix", "prefix"] as const) {
      expect(change(User).uniqueConstraint("email", { match }).constraints[0]?.match).toBe(match);
    }
  });

  test("a changeset without a schema class has no associations to constrain", () => {
    const schemaless = change({ data: {}, types: { q: t.string() } });
    expect(() => schemaless.assocConstraint("posts" as never)).toThrow(QueryError);
  });
});

describe("optimisticLock", () => {
  const row = (): User =>
    loaded(User, { id: 1, email: "joan@example.com", name: "Joan", role: "member", lockVersion: 4 });

  test("records the current value as a filter and an increment to run before the write", () => {
    const cs = change(row(), { name: "Joan C." }).optimisticLock("lockVersion");
    expect(cs.filters).toEqual({ lockVersion: 4 });
    expect(cs.changes).toEqual({ name: "Joan C." });
    expect(cs.prepare).toHaveLength(1);
    const prepared = cs.prepare.reduce((current, fn) => fn(current), cs);
    expect(prepared.changes).toEqual({ name: "Joan C.", lockVersion: 5 });
  });

  test("the default increment wraps after the largest 32-bit integer; bigints count on", () => {
    const max = loaded(User, { id: 1, email: "a@b.c", role: "member", lockVersion: 2147483647 });
    const cs = change(max).optimisticLock("lockVersion");
    expect(cs.prepare[0]?.(cs).changes).toEqual({ lockVersion: 1 });
    class Doc extends Schema("docs", { id: t.integer().primaryKey(), rev: t.bigint() }) {}
    const doc = loaded(Doc, { id: 1, rev: 9n });
    const locked = change(doc).optimisticLock("rev");
    expect(locked.prepare[0]?.(locked).changes).toEqual({ rev: 10n });
  });

  test("takes an incrementer, and works on a new record's default", () => {
    const cs = change(row()).optimisticLock("lockVersion", (n) => n + 10);
    expect(cs.prepare[0]?.(cs).changes).toEqual({ lockVersion: 14 });
    const fresh = change(User, { email: "a@b.c" }).optimisticLock("lockVersion");
    expect(fresh.filters).toEqual({ lockVersion: 1 });
  });

  test("throws without a value to compare, a bad incrementer, or a value that cannot be incremented", () => {
    expect(() => change(User).optimisticLock("age")).toThrow(/has no value/);
    expect(() => change(row()).optimisticLock("lockVersion", 1 as never)).toThrow(QueryError);
    expect(() => change(row()).optimisticLock("email" as never)).toThrow(/"email" is not a number/);
  });
});

describe("prepareChanges", () => {
  test("stores the functions in order for the repo to run", () => {
    const first = <C>(cs: C) => cs;
    const second = <C>(cs: C) => cs;
    const cs = change(User).prepareChanges(first).prepareChanges(second);
    expect(cs.prepare).toEqual([first, second]);
    expect(() => cs.prepareChanges("x" as never)).toThrow(QueryError);
  });
});

describe("validateUniqueAsync", () => {
  afterEach(() => provideValidateUniqueAsync(undefined));

  test("rejects until the repo provides it", async () => {
    await expect(change(User).validateUniqueAsync("email", {})).rejects.toThrow(QueryError);
    await expect(change(User).validateUniqueAsync(["nope" as never], {})).rejects.toThrow(/no field/);
  });

  test("delegates to the repo's implementation", async () => {
    const repo = { name: "repo" };
    const seen: unknown[] = [];
    provideValidateUniqueAsync(async (cs, fields, given, options) => {
      seen.push(fields, given, options);
      return cs.addError("email", "has already been taken");
    });
    const result = await change(User, { email: "a@b.c" }).validateUniqueAsync("email", repo, {
      message: "taken",
    });
    expect(result.errors.email?.[0]?.message).toBe("has already been taken");
    expect(seen).toEqual([["email"], repo, { message: "taken" }]);
  });

  test("a field listed twice is checked once", async () => {
    const seen: unknown[] = [];
    provideValidateUniqueAsync(async (cs, fields) => {
      seen.push(fields);
      return cs;
    });
    await change(User, { email: "a@b.c", name: "A" }).validateUniqueAsync(["email", "name", "email"], {});
    expect(seen).toEqual([["email", "name"]]);
  });
});

describe("uniqueConstraint: a field listed twice", () => {
  test("is one column of the default name", () => {
    const [constraint] = change(User).uniqueConstraint(["email", "name", "email"]).constraints;
    expect(constraint?.name).toBe("users_email_name_key");
    expect(change(User).uniqueConstraint(["email", "email"]).constraints[0]?.name).toBe("users_email_key");
  });
});

describe("repo", () => {
  test("is null until the repo sets it", () => {
    const cs = change(Membership);
    expect(cs.repo).toBeNull();
    const repo = {};
    expect(withRepo(cs, repo).repo).toBe(repo);
  });
});

describe("constraint default names: a key of two columns", () => {
  class Pair extends Schema("pairs", {
    orgId: t.uuid().primaryKey(),
    userId: t.integer().primaryKey(),
  }) {
    static grants = hasMany(() => Grant, { foreignKey: ["orgId", "userId"] });
  }
  class Grant extends Schema("grants", {
    id: t.integer().primaryKey(),
    orgId: t.uuid(),
    userId: t.integer(),
  }) {
    static pair = belongsTo(() => Pair, { foreignKey: ["orgId", "userId"] });
  }

  test("the columns are joined with underscores", () => {
    expect(change(Grant).assocConstraint("pair").constraints[0]?.name).toBe("grants_org_id_user_id_fkey");
    expect(change(Pair).noAssocConstraint("grants").constraints[0]?.name).toBe("grants_org_id_user_id_fkey");
  });
});

describe("optimisticLock: no current value, and a custom incrementer", () => {
  class Ticket extends Schema("tickets", { id: t.integer().primaryKey(), code: t.string().nullable() }) {}

  test("a field with no current value is refused; a custom incrementer works on any type", () => {
    expect(() => change(Ticket).optimisticLock("id")).toThrow(/has no value to compare/);
    const locked = change(loaded(Ticket, { id: 1, code: "a" })).optimisticLock(
      "code",
      (value) => `${String(value)}x`,
    );
    expect(locked.filters).toEqual({ code: "a" });
  });
});
