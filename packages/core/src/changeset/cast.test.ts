import { Membership, Post, User, UserSettings } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import type { AnySchema, Row } from "../contracts/schema.js";
import { ROW } from "../contracts/schema.js";
import { CastError, QueryError } from "../errors.js";
import { meta, Schema, t } from "../schema/index.js";
import { defineType } from "../types/define.js";
import { Changeset, cast } from "./changeset.js";

/** A row of `schema` as a query would return it. */
function loaded<S extends AnySchema>(schema: S, values: Readonly<Record<string, unknown>>): Row<S> {
  const info = meta(schema);
  return info.create(
    info.persisted.map((field) => (Object.hasOwn(values, field.name) ? values[field.name] : null)),
    info.rowMeta("loaded", undefined),
  ) as Row<S>;
}

const at = new Date("2026-03-01T09:30:00Z");
const grace = (): User =>
  loaded(User, {
    id: 7,
    email: "grace@navy.example",
    name: "Grace",
    age: 41,
    role: "admin",
    lockVersion: 3,
    createdAt: at,
    updatedAt: at,
  });

describe("cast: params", () => {
  test("keeps only permitted keys", () => {
    const cs = cast(User, { email: "linus@kernel.example", role: "admin", name: "Linus" }, ["email", "name"]);
    expect(cs.changes).toEqual({ email: "linus@kernel.example", name: "Linus" });
    expect(cs.valid).toBe(true);
  });

  test("ignores keys that are not fields, symbol keys and inherited keys", () => {
    const params = Object.assign(Object.create(null) as Record<string | symbol, unknown>, {
      email: "ken@unix.example",
      unknownKey: 1,
      [Symbol("name")]: "Ken",
    });
    const inherited = Object.create({ name: "from the prototype" }) as Record<string, unknown>;
    expect(cast(User, params, ["email", "name"]).changes).toEqual({ email: "ken@unix.example" });
    expect(() => cast(User, inherited, ["name"])).toThrow(CastError);
  });

  test("treats null and undefined params as no params", () => {
    for (const params of [null, undefined]) {
      const cs = cast(User, params, ["email"]);
      expect(cs.changes).toEqual({});
      expect(cs.valid).toBe(true);
      expect(cs.params).toEqual({});
    }
  });

  test("refuses params that are not a plain object", () => {
    for (const params of ["email=x", 42, true, ["email"], new Date(), new Map(), () => ({})]) {
      expect(() => cast(User, params, ["email"])).toThrow(CastError);
    }
    expect(() => cast(User, [], ["email"])).toThrowErrorMatchingInlineSnapshot(
      `[CastError: cast.paramsNotObject: cast() expects params to be a plain object (or null or undefined for none), but got an array. Pass the params as a plain object, such as a parsed request body; null and undefined count as no params. See https://egon-orm.github.io/egon-orm/reference/errors/cast#cast-paramsnotobject]`,
    );
  });

  test("keeps the params as given, including keys that are not permitted", () => {
    const params = { email: "barbara@lisp.example", passwordConfirmation: "x" };
    expect(cast(User, params, ["email"]).params).toBe(params);
  });

  test("treats a key whose value is undefined as missing", () => {
    const cs = cast(User, { name: undefined, email: undefined }, ["name", "email"]);
    expect(cs.changes).toEqual({});
    expect(cs.errors).toEqual({});
    expect(cs.valid).toBe(true);
  });

  test("reads only the params' own keys, never Object.prototype's", () => {
    const types = { valueOf: t.string().nullable(), toString: t.string().nullable() };
    const cs = cast({ data: {}, types }, {}, ["valueOf", "toString"]);
    expect(cs.changes).toEqual({});
    expect(cs.errors).toEqual({});
  });

  test("does not run a getter on the params twice or read the prototype", () => {
    let reads = 0;
    const params = {
      get name() {
        reads++;
        return "Ada";
      },
    };
    expect(cast(User, params, ["name"]).changes).toEqual({ name: "Ada" });
    expect(reads).toBe(1);
  });
});

describe("cast: permitted fields", () => {
  test("throws for a name that is not a field", () => {
    expect(() => cast(User, {}, ["nickname" as "name"])).toThrowErrorMatchingInlineSnapshot(
      `[QueryError: query.changesetFieldUnknown: cast(): User has no field "nickname". Its fields are: id, email, name, age, role, password, passwordHash, settings, lockVersion, createdAt, updatedAt. Name one of the schema's fields; a typo is the usual cause. See https://egon-orm.github.io/egon-orm/reference/errors/query#query-changesetfieldunknown]`,
    );
  });

  test("throws for an association, pointing at castAssoc", () => {
    expect(() => cast(Post, {}, ["comments" as "title"])).toThrowErrorMatchingInlineSnapshot(
      `[QueryError: query.fieldIsAssoc: cast(): "comments" is an association of Post, not a field. Associations are changed through castAssoc and putAssoc. See https://egon-orm.github.io/egon-orm/reference/errors/query#query-fieldisassoc]`,
    );
  });

  test("throws for an embed, pointing at castEmbed", () => {
    expect(() => cast(User, { settings: {} }, ["settings"])).toThrowErrorMatchingInlineSnapshot(
      `[QueryError: query.castEmbed: cast(): "settings" is an embed. Cast it with castEmbed("settings", …) instead. See https://egon-orm.github.io/egon-orm/reference/errors/query#query-castembed]`,
    );
  });

  test("a name permitted twice is cast once: one error, one change", () => {
    const bad = cast(User, { age: "x", email: null }, ["age", "email", "age", "email"]);
    expect(bad.errors).toEqual({
      age: [{ message: "is invalid", validation: "cast", meta: { type: "integer" } }],
      email: [{ message: "can't be blank", validation: "required", meta: {} }],
    });
    // The same as a cast over an earlier changeset, which never repeated an error.
    expect(cast(cast(User, { age: "x" }, ["age"]), { age: "x" }, ["age"]).errors).toEqual({
      age: [{ message: "is invalid", validation: "cast", meta: { type: "integer" } }],
    });
    expect(cast(User, { age: "36" }, ["age", "age"]).changes).toEqual({ age: 36 });
  });

  test("throws when permitted is not an array or names are not strings", () => {
    expect(() => cast(User, {}, "email" as unknown as ["email"])).toThrow(QueryError);
    expect(() => cast(User, {}, [1 as unknown as "email"])).toThrow(QueryError);
  });

  test("throws for a target that is not a class, row, changeset or { data, types }", () => {
    for (const target of [null, 1, "users", { email: "x" }, () => User, new Date()]) {
      expect(() => cast(target as unknown as typeof User, {}, [])).toThrow(QueryError);
    }
    // Objects that carry the row marker without being rows of a schema class.
    const marker = meta(User).rowMeta("loaded", undefined);
    const bare = Object.assign(Object.create(null) as object, { [ROW]: marker });
    const plain = { [ROW]: marker, email: "x" };
    for (const target of [bare, plain]) {
      expect(() => cast(target as unknown as typeof User, {}, [])).toThrow(QueryError);
    }
  });
});

describe("cast: conversion", () => {
  test("converts each value with the field's type", () => {
    const cs = cast(User, { age: "36", role: "member", id: "12" }, ["age", "role", "id"]);
    expect(cs.changes).toEqual({ age: 36, id: 12 });
  });

  test("a value the type rejects adds is invalid and records no change", () => {
    const cs = cast(User, { age: "thirty", email: 5 }, ["age", "email"]);
    expect(cs.changes).toEqual({});
    expect(cs.valid).toBe(false);
    expect(cs.errors).toEqual({
      age: [{ message: "is invalid", validation: "cast", meta: { type: "integer" } }],
      email: [{ message: "is invalid", validation: "cast", meta: { type: "string" } }],
    });
  });

  test("a custom type's message and metadata are kept", () => {
    const Even = defineType<number>({
      name: "even",
      db: { kind: "integer" },
      cast: (input) =>
        typeof input === "number" && input % 2 === 0
          ? { success: true, data: input }
          : { success: false, message: "must be even, got an odd {kind}", meta: { kind: "number" } },
    });
    class Pair extends Schema("pairs", { id: t.integer().primaryKey(), size: t.type(Even) }) {}
    expect(cast(Pair, { size: 3 }, ["size"]).errors).toEqual({
      size: [
        {
          message: "must be even, got an odd {kind}",
          validation: "cast",
          meta: { type: "even", kind: "number" },
        },
      ],
    });
  });

  test("an empty string becomes null", () => {
    expect(cast(User, { name: "", age: "" }, ["name", "age"], {}).changes).toEqual({});
    const existing = grace();
    expect(cast(existing, { name: "" }, ["name"]).changes).toEqual({ name: null });
  });

  test("emptyValues replaces the list of values that mean no value", () => {
    const existing = grace();
    expect(cast(existing, { name: "n/a" }, ["name"], { emptyValues: ["n/a"] }).changes).toEqual({
      name: null,
    });
    expect(cast(existing, { name: "" }, ["name"], { emptyValues: [] }).changes).toEqual({ name: "" });
    expect(() => cast(existing, {}, ["name"], { emptyValues: "" as unknown as [] })).toThrow(QueryError);
  });

  test("null on a nullable field is a change without calling the type", () => {
    const existing = grace();
    expect(cast(existing, { age: null }, ["age"]).changes).toEqual({ age: null });
  });

  test("null on a field that is not nullable adds can't be blank and records no change", () => {
    const cs = cast(grace(), { email: null, role: "" }, ["email", "role"]);
    expect(cs.changes).toEqual({});
    expect(cs.errors).toEqual({
      email: [{ message: "can't be blank", validation: "required", meta: {} }],
      role: [{ message: "can't be blank", validation: "required", meta: {} }],
    });
    expect(cs.valid).toBe(false);
  });

  test("a required field that is merely absent is not an error", () => {
    const cs = cast(User, { name: "Ada" }, ["email", "name"]);
    expect(cs.valid).toBe(true);
    expect(cs.errors).toEqual({});
  });
});

describe("cast: change detection", () => {
  test("a value equal to the row's value is not a change", () => {
    const cs = cast(grace(), { name: "Grace", age: "41", email: "grace@navy.example" }, [
      "name",
      "age",
      "email",
    ]);
    expect(cs.changes).toEqual({});
  });

  test("dates compare by time, not identity", () => {
    const cs = cast(grace(), { createdAt: "2026-03-01T09:30:00.000Z" }, ["createdAt"]);
    expect(cs.changes).toEqual({});
  });

  test("forceChanges records equal values too", () => {
    const cs = cast(grace(), { name: "Grace", age: 41 }, ["name", "age"], { forceChanges: true });
    expect(cs.changes).toEqual({ name: "Grace", age: 41 });
  });

  test("for a new record, a value equal to the field's default is not a change", () => {
    expect(
      cast(User, { role: "member", lockVersion: 1, name: null }, ["role", "lockVersion", "name"]).changes,
    ).toEqual({});
    expect(cast(User, { role: "admin" }, ["role"]).changes).toEqual({ role: "admin" });
  });

  test("a new record has no data and the class as its model", () => {
    const cs = cast(User, {}, []);
    expect(cs.data).toBeNull();
    expect(cs.model).toBe(User);
    expect(cs.action).toBeNull();
    expect(cs).toBeInstanceOf(Changeset);
  });

  test("a loaded row is the data, and its class the model", () => {
    const row = grace();
    const cs = cast(row, {}, []);
    expect(cs.data).toBe(row);
    expect(cs.model).toBe(User);
  });

  test("a row of a composite-key schema works like any other", () => {
    const row = loaded(Membership, {
      orgId: "0192d3e4-0000-7000-8000-000000000001",
      userId: 4,
      role: "member",
    });
    expect(cast(row, { role: "owner" }, ["role"]).changes).toEqual({ role: "owner" });
  });
});

describe("cast: a changeset again", () => {
  test("merges the new params and changes into the old ones", () => {
    const first = cast(grace(), { name: "Amazing Grace" }, ["name"]);
    const second = cast(first, { age: "42", source: "form" }, ["age"]);
    expect(second.changes).toEqual({ name: "Amazing Grace", age: 42 });
    expect(second.params).toEqual({ name: "Amazing Grace", age: "42", source: "form" });
  });

  test("compares new values with the existing changes", () => {
    const first = cast(grace(), { name: "Amazing Grace" }, ["name"]);
    expect(cast(first, { name: "Amazing Grace" }, ["name"]).changes).toBe(first.changes);
    expect(cast(first, { name: "Ada" }, ["name"]).changes).toEqual({ name: "Ada" });
  });

  test("a value back to the record's own value removes the earlier change", () => {
    const row = grace();
    const renamed = cast(row, { name: "Bob" }, ["name"]);
    const back = cast(renamed, { name: "Grace" }, ["name"]);
    expect(back.changes).toEqual({});
    expect(renamed.changes).toEqual({ name: "Bob" });
    expect(back.changes).not.toBe(renamed.changes);
    expect(back.isChanged("name")).toBe(false);
    expect(cast(renamed, { name: "Grace" }, ["name"], { forceChanges: true }).changes).toEqual({
      name: "Grace",
    });
    const fresh = cast(cast(User, { role: "admin" }, ["role"]), { role: "member", age: "3" }, [
      "role",
      "age",
    ]);
    expect(fresh.changes).toEqual({ age: 3 });
  });

  test("keeps the errors, without repeating an identical one", () => {
    const first = cast(User, { age: "old" }, ["age"]);
    const second = cast(first, { age: "older", name: "Ada" }, ["age", "name"]);
    expect(second.errors.age).toHaveLength(1);
    expect(second.valid).toBe(false);
    expect(second.changes).toEqual({ name: "Ada" });
    const third = cast(first, { email: null }, ["email"]);
    expect(Object.keys(third.errors)).toEqual(["age", "email"]);
  });

  test("keeps validations, constraints, action and repo hooks", () => {
    const first = cast(User, { email: "ada@example.com" }, ["email"])
      .validateRequired(["email"])
      .uniqueConstraint("email")
      .optimisticLock("lockVersion");
    const second = cast(first, { name: "Ada" }, ["name"]);
    expect(second.validations).toEqual(first.validations);
    expect(second.constraints).toBe(first.constraints);
    expect(second.filters).toBe(first.filters);
    expect(second.prepare).toBe(first.prepare);
  });

  test("a changeset made by change gets params", () => {
    const first = cast(cast(User, null, []), { name: "Ada" }, ["name"]);
    expect(first.params).toEqual({ name: "Ada" });
  });
});

describe("cast: without a schema class", () => {
  const types = { q: t.string(), page: t.integer().default(1), tags: t.array(t.string()).nullable() };

  test("casts into the given types", () => {
    const cs = cast({ data: {}, types }, { q: "orm", page: "3", other: 1 }, ["q", "page"]);
    expect(cs.changes).toEqual({ q: "orm", page: 3 });
    expect(cs.model).toBeNull();
    expect(cs.data).toEqual({});
  });

  test("compares with the data, then the declared default", () => {
    expect(cast({ data: { q: "orm" }, types }, { q: "orm", page: "1" }, ["q", "page"]).changes).toEqual({});
  });

  test("reports cast errors and null like a schema does", () => {
    const cs = cast({ data: {}, types }, { q: "", page: "x" }, ["q", "page"]);
    expect(cs.errors).toEqual({
      q: [{ message: "can't be blank", validation: "required", meta: {} }],
      page: [{ message: "is invalid", validation: "cast", meta: { type: "integer" } }],
    });
  });

  test("refuses types that are not field types, or data that is not an object", () => {
    expect(() =>
      cast({ data: {}, types: { q: "string" } } as never, {}, []),
    ).toThrowErrorMatchingInlineSnapshot(
      `[QueryError: query.schemalessFieldType: The type of the field "q" is not a field type. Give each field a type made with t, as in q: t.string(). See https://egon-orm.github.io/egon-orm/reference/errors/query#query-schemalessfieldtype]`,
    );
    expect(() => cast({ data: null, types } as never, {}, [])).toThrow(QueryError);
    expect(() => cast({ data: {}, types: null } as never, {}, [])).toThrow(QueryError);
    const sneaky = Object.defineProperty({}, "__proto__", { value: t.string(), enumerable: true });
    expect(() => cast({ data: {}, types: sneaky } as never, {}, [])).toThrow(/cannot be the name/);
    expect(() => cast({ data: {}, types: { constructor: t.string() } } as never, {}, [])).toThrow(
      /cannot be the name/,
    );
  });

  test("reuses what it derived from the same types object", () => {
    const a = cast({ data: {}, types }, { q: "a" }, ["q"]);
    const b = cast({ data: {}, types }, { q: "b" }, ["q"]);
    expect(a.changes).toEqual({ q: "a" });
    expect(b.changes).toEqual({ q: "b" });
  });

  test("refuses generated fields, which mean nothing without a table", () => {
    expect(() => cast({ data: {}, types: { at: t.timestamp().autogenerate() } }, {}, [])).toThrow(
      /autogenerated/,
    );
    expect(() => cast({ data: {}, types: { n: t.integer().dbGenerated() } }, {}, [])).toThrow(
      /database-generated/,
    );
  });

  test("an embed among the types is refused by cast", () => {
    const withEmbed = { settings: t.embedOne(() => UserSettings) };
    expect(() => cast({ data: {}, types: withEmbed }, {}, ["settings"])).toThrow(/castEmbed/);
  });
});

describe("cast: embedded schema rows", () => {
  test("a class of an embedded schema can be cast like a table's", () => {
    expect(cast(UserSettings, { theme: "dark" }, ["theme"]).changes).toEqual({ theme: "dark" });
  });
});

class Session extends Schema("sessions", {
  id: t.integer().primaryKey(),
  startsAt: t.timestamp(),
  endsAt: t.timestamp().nullable(),
  tags: t.array(t.string()),
  mode: t.string().virtual().default("plain"),
}) {}

const sessionStart = "2026-04-01T09:00:00.000Z";
const session = () => loaded(Session, { id: 1, startsAt: new Date(sessionStart), endsAt: null, tags: ["a"] });

describe("cast: a value compared with the current value", () => {
  test("a value over a null or missing current value is a change, whatever the type", () => {
    expect(cast(session(), { endsAt: sessionStart }, ["endsAt"]).changes).toEqual({
      endsAt: new Date(sessionStart),
    });
    expect(cast(Session, { startsAt: sessionStart }, ["startsAt"]).changes).toEqual({
      startsAt: new Date(sessionStart),
    });
    expect(cast(session(), { startsAt: null }, ["startsAt"]).changes).toEqual({});
  });

  test("null over a stored value is a change, whatever the type", () => {
    const ended = loaded(Session, {
      id: 1,
      startsAt: new Date(sessionStart),
      endsAt: new Date(sessionStart),
      tags: [],
    });
    expect(cast(ended, { endsAt: null }, ["endsAt"]).changes).toEqual({ endsAt: null });
  });

  test("a loaded row's virtual field is compared with the row's value, not with the default", () => {
    expect(cast(session(), { mode: "plain" }, ["mode"]).changes).toEqual({ mode: "plain" });
  });

  test("null for a required field, cast twice, is reported once", () => {
    const first = cast(User, { email: null }, ["email"]);
    expect(cast(first, { email: null }, ["email"]).errors.email).toHaveLength(1);
  });
});

describe("cast: a source that is not one", () => {
  test("undefined, types of undefined, or types without data are refused with a QueryError", () => {
    expect(() => cast(undefined as never, {}, [])).toThrow(/^query\.changesetSource: /);
    expect(() => cast({ data: {}, types: undefined } as never, {}, [])).toThrow(/^query\.schemalessShape: /);
    expect(() => cast({ types: { q: t.string() } } as never, {}, [])).toThrow(/^query\.schemalessData: /);
  });
});
