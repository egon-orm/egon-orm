import { Post, User } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import type { AnySchema, Row } from "../contracts/schema.js";
import { QueryError } from "../errors.js";
import { meta, Schema, t } from "../schema/index.js";
import { defineType } from "../types/define.js";
import { cast, change } from "./changeset.js";

function loaded<S extends AnySchema>(schema: S, values: Readonly<Record<string, unknown>>): Row<S> {
  const info = meta(schema);
  return info.create(
    info.persisted.map((field) => (Object.hasOwn(values, field.name) ? values[field.name] : null)),
    info.rowMeta("loaded", undefined),
  ) as Row<S>;
}

const hedy = (): User =>
  loaded(User, { id: 2, email: "hedy@radio.example", name: "Hedy", age: 50, role: "member", lockVersion: 1 });

class Event extends Schema("events", {
  id: t.integer().primaryKey().dbGenerated(),
  title: t.string(),
  slug: t.string(),
  seats: t.integer().nullable(),
  score: t.float().nullable(),
  big: t.bigint().nullable(),
  startsOn: t.date({ as: "date" }).nullable(),
  labels: t.array(t.string()).nullable(),
  sizes: t.array(t.integer()).nullable(),
}) {}

describe("validateRequired", () => {
  test("adds can't be blank to missing fields, in the order given", () => {
    const cs = cast(User, { name: "" }, ["name"]).validateRequired(["email", "name"]);
    expect(cs.errors).toEqual({
      email: [{ message: "can't be blank", validation: "required", meta: {} }],
      name: [{ message: "can't be blank", validation: "required", meta: {} }],
    });
    expect(cs.valid).toBe(false);
  });

  test("a name listed twice is checked once: one error", () => {
    const cs = cast(User, { name: "" }, ["name"]).validateRequired(["email", "name", "email", "name"]);
    expect(cs.errors).toEqual({
      email: [{ message: "can't be blank", validation: "required", meta: {} }],
      name: [{ message: "can't be blank", validation: "required", meta: {} }],
    });
    expect(cs.validations).toEqual([
      ["email", { validation: "required" }],
      ["name", { validation: "required" }],
    ]);
    const passing = change(hedy()).validateRequired(["email", "email"]);
    expect(passing.validations).toEqual([["email", { validation: "required" }]]);
  });

  test("checks the data too: a loaded row's values count", () => {
    expect(change(hedy()).validateRequired(["email", "name"]).valid).toBe(true);
    expect(change(hedy(), { name: null }).validateRequired(["name"]).valid).toBe(false);
  });

  test("a new record's defaults count as values", () => {
    expect(change(User).validateRequired(["role", "lockVersion"]).valid).toBe(true);
  });

  test("whitespace-only strings are missing unless trim is false", () => {
    const cs = cast(User, { email: "  \n" }, ["email"]);
    expect(cs.validateRequired(["email"]).valid).toBe(false);
    expect(cs.validateRequired(["email"], { trim: false }).valid).toBe(true);
    expect(
      cast(hedy(), { name: "" }, ["name"], { emptyValues: [] }).validateRequired("name", { trim: false })
        .valid,
    ).toBe(false);
  });

  test("removes the change of a field found missing", () => {
    const cs = cast(hedy(), { name: " ", age: "51" }, ["name", "age"]).validateRequired(["name"]);
    expect(cs.changes).toEqual({ age: 51 });
  });

  test("skips a field that already has an error", () => {
    const cs = cast(User, { email: null }, ["email"]).validateRequired(["email"]);
    expect(cs.errors.email).toHaveLength(1);
  });

  test("with no list checks the non-nullable stored fields that nothing else fills", () => {
    const cs = change(User).validateRequired();
    expect(Object.keys(cs.errors)).toEqual(["email"]);
    expect(change(Post).validateRequired().errors).toEqual({
      authorId: [{ message: "can't be blank", validation: "required", meta: {} }],
      title: [{ message: "can't be blank", validation: "required", meta: {} }],
    });
    expect(cs.validations).toEqual([["email", { validation: "required" }]]);
  });

  test("takes a message, as text or a function", () => {
    expect(change(User).validateRequired("email", { message: "is needed" }).errors.email?.[0]?.message).toBe(
      "is needed",
    );
    expect(
      change(User).validateRequired(["email"], { message: () => "fill me in" }).errors.email?.[0]?.message,
    ).toBe("fill me in");
  });

  test("throws for an unknown field or a bad argument", () => {
    expect(() => change(User).validateRequired(["nope" as "email"])).toThrow(QueryError);
    expect(() => change(User).validateRequired(42 as never)).toThrow(QueryError);
    expect(() => change(User).validateRequired(["email"], { message: 1 as never })).toThrow(QueryError);
    expect(() => change(User).validateRequired(["email"], { message: () => 1 as never })).toThrow(QueryError);
  });
});

describe("validations run only when the field has a change", () => {
  test("no change, or a change to null, is not validated", () => {
    const row = hedy();
    const untouched = change(row)
      .validateFormat("email", /^never$/)
      .validateLength("name", { is: 100 })
      .validateNumber("age", { lessThan: 0 })
      .validateInclusion("role", ["admin"])
      .validateExclusion("name", ["Hedy"])
      .validateChange("name", () => "always fails");
    expect(untouched.valid).toBe(true);
    const nulled = change(row, { name: null })
      .validateLength("name", { min: 3 })
      .validateChange("name", () => "x");
    expect(nulled.valid).toBe(true);
    expect(cast(Event, {}, []).validateSubset("labels", ["a"]).valid).toBe(true);
  });
});

describe("a field that already has an error gets no more: the first failure stands", () => {
  test("each built-in validation leaves a field with an error alone", () => {
    const params = { title: "x", slug: "taken", seats: "0", labels: ["z"] };
    const cs = cast(Event, params, ["title", "slug", "seats", "labels"])
      .addError("title", "first")
      .addError("slug", "first")
      .addError("seats", "first")
      .addError("labels", "first")
      .validateLength("title", { min: 3 })
      .validateFormat("title", /^[A-Z]/)
      .validateInclusion("slug", ["free"])
      .validateExclusion("slug", ["taken"])
      .validateNumber("seats", { greaterThan: 0 })
      .validateSubset("labels", ["a"])
      .validateChange("title", () => "is dropped");
    expect(cs.errorMessages()).toEqual({
      title: ["first"],
      slug: ["first"],
      seats: ["first"],
      labels: ["first"],
    });
    // Each validation is still recorded.
    expect(cs.validations).toHaveLength(7);

    const keyed = cast(User, { password: "secret", passwordConfirmation: "other", terms: "no" }, ["password"])
      .addError("passwordConfirmation", "first")
      .addError("terms", "first")
      .validateConfirmation("password")
      .validateAcceptance("terms");
    expect(keyed.errorMessages()).toEqual({ passwordConfirmation: ["first"], terms: ["first"] });
  });

  test("two validations of one field: only the first failure is reported", () => {
    const cs = cast(Event, { title: "x" }, ["title"])
      .validateLength("title", { min: 3 })
      .validateFormat("title", /^[A-Z]/);
    expect(cs.errorMessages()).toEqual({ title: ["should be at least 3 character(s)"] });
    // Without the first failure, the second is reported.
    expect(
      cast(Event, { title: "xyz" }, ["title"])
        .validateLength("title", { min: 3 })
        .validateFormat("title", /^[A-Z]/)
        .errorMessages(),
    ).toEqual({ title: ["has invalid format"] });
  });

  test("validateChange does not call its function for a field with an error", () => {
    let calls = 0;
    const cs = cast(Event, { title: "x" }, ["title"])
      .validateLength("title", { min: 3 })
      .validateChange("title", () => {
        calls++;
        return "is dropped";
      });
    expect(calls).toBe(0);
    expect(cs.errorMessages()).toEqual({ title: ["should be at least 3 character(s)"] });
  });

  test("an error on one field does not stop validations of another", () => {
    const cs = cast(Event, { title: "x", slug: "a b" }, ["title", "slug"])
      .validateLength("title", { min: 3 })
      .validateFormat("slug", /^\S+$/);
    expect(cs.errorMessages()).toEqual({
      title: ["should be at least 3 character(s)"],
      slug: ["has invalid format"],
    });
  });
});

describe("validateFormat", () => {
  test("adds has invalid format when the change does not match", () => {
    const cs = cast(User, { email: "not an address" }, ["email"]).validateFormat(
      "email",
      /^[^@\s]+@[^@\s]+$/,
    );
    expect(cs.errors).toEqual({ email: [{ message: "has invalid format", validation: "format", meta: {} }] });
    expect(cast(User, { email: "a@b" }, ["email"]).validateFormat("email", /@/).valid).toBe(true);
  });

  test("a global or sticky pattern gives the same answer every time", () => {
    const global = /@/g;
    const cs = cast(User, { email: "a@b" }, ["email"]);
    for (let i = 0; i < 3; i++) expect(cs.validateFormat("email", global).valid).toBe(true);
    expect(global.lastIndex).toBe(0);
    expect(cs.validateFormat("email", /a/y).valid).toBe(true);
  });

  test("takes a message; throws without a regular expression", () => {
    const cs = cast(User, { email: "x" }, ["email"]);
    expect(
      cs.validateFormat("email", /@/, { message: "is not an email address" }).errors.email?.[0]?.message,
    ).toBe("is not an email address");
    expect(() => cs.validateFormat("email", "@" as never)).toThrow(QueryError);
    expect(() => cast(User, { age: 3 }, ["age"]).validateFormat("age" as never, /3/)).toThrow(/not a string/);
  });
});

describe("validateInclusion and validateExclusion", () => {
  test("inclusion adds is invalid with the allowed values in meta", () => {
    const cs = cast(hedy(), { role: "admin" }, ["role"]).validateInclusion("role", ["member"]);
    expect(cs.errors).toEqual({
      role: [{ message: "is invalid", validation: "inclusion", meta: { enum: ["member"] } }],
    });
    expect(
      cast(hedy(), { role: "admin" }, ["role"]).validateInclusion("role", ["admin", "member"]).valid,
    ).toBe(true);
  });

  test("exclusion adds is reserved", () => {
    const cs = cast(User, { name: "root" }, ["name"]).validateExclusion("name", ["root", "admin"]);
    expect(cs.errors).toEqual({
      name: [{ message: "is reserved", validation: "exclusion", meta: { enum: ["root", "admin"] } }],
    });
    expect(cast(User, { name: "Hedy" }, ["name"]).validateExclusion("name", ["root"]).valid).toBe(true);
  });

  test("values compare by the field's type, so dates compare by time", () => {
    const cs = cast(Event, { startsOn: "2026-12-24" }, ["startsOn"]);
    expect(cs.validateInclusion("startsOn", [new Date("2026-12-24T00:00:00Z")]).valid).toBe(true);
    expect(cs.validateExclusion("startsOn", [new Date("2026-12-24T00:00:00Z")]).valid).toBe(false);
  });

  test("message option; values must be an array", () => {
    const cs = cast(User, { name: "root" }, ["name"]);
    expect(
      cs.validateExclusion("name", ["root"], { message: (meta) => `is one of ${String(meta.enum)}` }).errors
        .name?.[0]?.message,
    ).toBe("is one of root");
    expect(() => cs.validateInclusion("name", "root" as never)).toThrow(QueryError);
    expect(() => cs.validateExclusion("name", null as never)).toThrow(QueryError);
  });
});

describe("validateSubset", () => {
  test("adds has an invalid entry when an element is not allowed", () => {
    const cs = cast(Event, { labels: ["talk", "party"] }, ["labels"]).validateSubset("labels", [
      "talk",
      "workshop",
    ]);
    expect(cs.errors).toEqual({
      labels: [
        { message: "has an invalid entry", validation: "subset", meta: { enum: ["talk", "workshop"] } },
      ],
    });
  });

  test("passes when every element is allowed, including an empty list", () => {
    expect(cast(Event, { sizes: [1, 2, 2] }, ["sizes"]).validateSubset("sizes", [1, 2, 3]).valid).toBe(true);
    expect(cast(Event, { labels: [] }, ["labels"]).validateSubset("labels", []).valid).toBe(true);
  });

  test("throws for values that are not an array, or a change that is not one", () => {
    const cs = cast(Event, { labels: ["a"] }, ["labels"]);
    expect(() => cs.validateSubset("labels", "a" as never)).toThrow(QueryError);
    expect(() => cast(User, { name: "x" }, ["name"]).validateSubset("name" as never, ["x"] as never)).toThrow(
      /not an array/,
    );
  });
});

describe("validateLength", () => {
  const titled = (title: string) => cast(Event, { title }, ["title"]);
  const first = (cs: ReturnType<typeof titled>) => cs.errors.title?.[0];

  test("strings: is, min and max, with their messages and meta", () => {
    expect(first(titled("abc").validateLength("title", { is: 4 }))).toEqual({
      message: "should be {count} character(s)",
      validation: "length",
      meta: { count: 4, kind: "is", type: "string" },
    });
    expect(first(titled("abc").validateLength("title", { min: 4 }))).toEqual({
      message: "should be at least {count} character(s)",
      validation: "length",
      meta: { count: 4, kind: "min", type: "string" },
    });
    expect(first(titled("abc").validateLength("title", { max: 2 }))).toEqual({
      message: "should be at most {count} character(s)",
      validation: "length",
      meta: { count: 2, kind: "max", type: "string" },
    });
    expect(titled("abc").validateLength("title", { min: 3, max: 3, is: 3 }).valid).toBe(true);
  });

  test("is is checked before min, and min before max; one error at most", () => {
    const cs = titled("abcdef").validateLength("title", { is: 2, min: 10, max: 4 });
    expect(cs.errors.title).toHaveLength(1);
    expect(cs.errors.title?.[0]?.meta.kind).toBe("is");
    expect(first(titled("abcdef").validateLength("title", { min: 10, max: 4 }))?.meta.kind).toBe("min");
  });

  test("counts grapheme clusters by default", () => {
    expect(titled("café").validateLength("title", { is: 4 }).valid).toBe(true);
    expect(titled("café").validateLength("title", { is: 4 }).valid).toBe(true);
    expect(titled("👩‍👩‍👧").validateLength("title", { is: 1 }).valid).toBe(true);
    expect(titled("a\r\nb").validateLength("title", { is: 3 }).valid).toBe(true);
    expect(titled("\t x").validateLength("title", { is: 3 }).valid).toBe(true);
  });

  test("count: codepoints counts code points", () => {
    expect(titled("café").validateLength("title", { is: 5, count: "codepoints" }).valid).toBe(true);
    expect(titled("😀x").validateLength("title", { is: 2, count: "codepoints" }).valid).toBe(true);
    expect(titled("\ud800x").validateLength("title", { is: 2, count: "codepoints" }).valid).toBe(true);
  });

  test("count: bytes counts UTF-8 bytes and says byte(s)", () => {
    expect(titled("é😀aŁ€").validateLength("title", { is: 2 + 4 + 1 + 2 + 3, count: "bytes" }).valid).toBe(
      true,
    );
    expect(titled("\ud800").validateLength("title", { is: 3, count: "bytes" }).valid).toBe(true);
    expect(titled("\ud800x").validateLength("title", { is: 4, count: "bytes" }).valid).toBe(true);
    expect(
      [
        first(titled("abc").validateLength("title", { is: 1, count: "bytes" })),
        first(titled("abc").validateLength("title", { min: 5, count: "bytes" })),
        first(titled("abc").validateLength("title", { max: 1, count: "bytes" })),
      ].map((error) => [error?.message, error?.meta.type]),
    ).toEqual([
      ["should be {count} byte(s)", "binary"],
      ["should be at least {count} byte(s)", "binary"],
      ["should be at most {count} byte(s)", "binary"],
    ]);
  });

  test("arrays count items and say item(s)", () => {
    const tagged = cast(Event, { labels: ["a", "b", "c"] }, ["labels"]);
    expect(
      [
        tagged.validateLength("labels", { is: 2 }),
        tagged.validateLength("labels", { min: 4 }),
        tagged.validateLength("labels", { max: 1 }),
      ].map((cs) => [cs.errors.labels?.[0]?.message, cs.errors.labels?.[0]?.meta.type]),
    ).toEqual([
      ["should have {count} item(s)", "list"],
      ["should have at least {count} item(s)", "list"],
      ["should have at most {count} item(s)", "list"],
    ]);
    expect(tagged.validateLength("labels", { min: 1, max: 3 }).valid).toBe(true);
  });

  test("message option overrides every variant", () => {
    expect(first(titled("a").validateLength("title", { min: 2, message: "too short" }))?.message).toBe(
      "too short",
    );
  });

  test("throws without a limit, with a bad limit or count, or on a value with no length", () => {
    const cs = titled("abc");
    expect(() => cs.validateLength("title", {})).toThrow(QueryError);
    expect(() => cs.validateLength("title", null as never)).toThrow(QueryError);
    expect(() => cs.validateLength("title", { min: -1 })).toThrow(QueryError);
    expect(() => cs.validateLength("title", { max: 1.5 })).toThrow(QueryError);
    expect(() => cs.validateLength("title", { min: 1, count: "words" as never })).toThrow(QueryError);
    expect(() => cast(Event, { seats: 3 }, ["seats"]).validateLength("seats" as never, { min: 1 })).toThrow(
      /not a string or an array/,
    );
  });
});

describe("validateNumber", () => {
  const seats = (value: number) => cast(Event, { seats: value }, ["seats"]);

  test("each comparison, with its message and meta", () => {
    const cases = [
      [{ lessThan: 10 }, 10, "must be less than {number}"],
      [{ greaterThan: 10 }, 10, "must be greater than {number}"],
      [{ lessThanOrEqualTo: 10 }, 11, "must be less than or equal to {number}"],
      [{ greaterThanOrEqualTo: 10 }, 9, "must be greater than or equal to {number}"],
      [{ equalTo: 10 }, 9, "must be equal to {number}"],
      [{ notEqualTo: 10 }, 10, "must be not equal to {number}"],
    ] as const;
    for (const [options, value, message] of cases) {
      const kind = Object.keys(options)[0];
      expect(seats(value).validateNumber("seats", options).errors).toEqual({
        seats: [{ message, validation: "number", meta: { kind, number: 10 } }],
      });
    }
    const passing = [
      [{ lessThan: 10 }, 9],
      [{ greaterThan: 10 }, 11],
      [{ lessThanOrEqualTo: 10 }, 10],
      [{ greaterThanOrEqualTo: 10 }, 10],
      [{ equalTo: 10 }, 10],
      [{ notEqualTo: 10 }, 9],
      [{ notEqualTo: 10 }, 11],
    ] as const;
    for (const [options, value] of passing)
      expect(seats(value).validateNumber("seats", options).valid).toBe(true);
  });

  test("checks options in the order given and reports the first failure only", () => {
    const cs = seats(50).validateNumber("seats", { lessThan: 20, greaterThan: 60 });
    expect(cs.errors.seats).toEqual([
      { message: "must be less than {number}", validation: "number", meta: { kind: "lessThan", number: 20 } },
    ]);
    expect(
      seats(50).validateNumber("seats", { greaterThan: 60, lessThan: 20 }).errors.seats?.[0]?.meta.kind,
    ).toBe("greaterThan");
  });

  test("floats and bigints compare with number and bigint limits", () => {
    expect(cast(Event, { score: 0.5 }, ["score"]).validateNumber("score", { greaterThan: 0 }).valid).toBe(
      true,
    );
    expect(
      cast(Event, { big: "9007199254740993" }, ["big"]).validateNumber("big", { greaterThan: 2 ** 53 }).valid,
    ).toBe(true);
    expect(cast(Event, { big: 5 }, ["big"]).validateNumber("big", { equalTo: 5 }).valid).toBe(true);
    expect(cast(Event, { big: 5 }, ["big"]).validateNumber("big", { lessThan: 5n }).valid).toBe(false);
  });

  test("a message option is not a limit: a value that passes every limit is valid, whatever the order", () => {
    expect(seats(5).validateNumber("seats", { greaterThan: 1, message: "too few" }).valid).toBe(true);
    expect(seats(5).validateNumber("seats", { message: "too few", greaterThan: 1 }).valid).toBe(true);
  });

  test("message option", () => {
    expect(
      seats(1).validateNumber("seats", {
        greaterThan: 1,
        message: (meta) => `more than ${String(meta.number)}`,
      }).errors.seats?.[0]?.message,
    ).toBe("more than 1");
  });

  test("throws for unknown options, limits that are not numbers, or a value that is not a number", () => {
    expect(() =>
      seats(1).validateNumber("seats", { atLeast: 1 } as never),
    ).toThrowErrorMatchingInlineSnapshot(
      `[QueryError: query.numberUnknownOption: validateNumber(): unknown option "atLeast". The options are lessThan, greaterThan, lessThanOrEqualTo, greaterThanOrEqualTo, equalTo, notEqualTo and message. Pass only the options validateNumber() takes, as in { greaterThan: 0 }. See https://egon-orm.github.io/egon-orm/reference/errors/query#query-numberunknownoption]`,
    );
    expect(() => seats(1).validateNumber("seats", { lessThan: "2" } as never)).toThrow(QueryError);
    expect(() => seats(1).validateNumber("seats", { lessThan: Number.NaN })).toThrow(QueryError);
    expect(() => seats(1).validateNumber("seats", null as never)).toThrow(QueryError);
    expect(() =>
      cast(Event, { title: "x" }, ["title"]).validateNumber("title" as never, { lessThan: 1 }),
    ).toThrow(/not a number/);
  });

  test("only the options object's own keys are read", () => {
    const options = Object.assign(Object.create({ lessThan: 0 }) as object, { greaterThan: 0 });
    expect(seats(5).validateNumber("seats", options).valid).toBe(true);
  });

  test("needs at least one limit", () => {
    expect(() => seats(1).validateNumber("seats", {})).toThrow(/at least one limit/);
    expect(() => seats(1).validateNumber("seats", { message: "x" })).toThrow(/at least one limit/);
  });

  test("NaN fails every comparison", () => {
    const cs = change({ data: {}, types: { ratio: t.float() } }).forceChange("ratio", Number.NaN);
    expect(cs.validateNumber("ratio", { notEqualTo: 1 }).valid).toBe(false);
  });
});

describe("validateConfirmation", () => {
  const signUp = (params: Record<string, unknown>) => cast(User, params, ["email", "password"]);

  test("passes when the confirmation equals the value", () => {
    expect(
      signUp({ password: "hunter22", passwordConfirmation: "hunter22" }).validateConfirmation("password")
        .valid,
    ).toBe(true);
  });

  test("puts does not match confirmation on the confirmation key", () => {
    const cs = signUp({ password: "hunter22", passwordConfirmation: "hunter23" }).validateConfirmation(
      "password",
    );
    expect(cs.errors).toEqual({
      passwordConfirmation: [
        { message: "does not match confirmation", validation: "confirmation", meta: {} },
      ],
    });
  });

  test("a missing confirmation is an error only when required", () => {
    expect(signUp({ password: "hunter22" }).validateConfirmation("password").valid).toBe(true);
    expect(
      signUp({ password: "hunter22" }).validateConfirmation("password", { required: true }).errors,
    ).toEqual({
      passwordConfirmation: [{ message: "can't be blank", validation: "required", meta: {} }],
    });
  });

  test("casts the confirmation with the field's type, so the same input typed twice matches", () => {
    expect(cast(User, { age: "36", ageConfirmation: "36" }, ["age"]).validateConfirmation("age").valid).toBe(
      true,
    );
    expect(cast(User, { age: "36", ageConfirmation: 36 }, ["age"]).validateConfirmation("age").valid).toBe(
      true,
    );
    const at = "2026-10-14T09:00:00.000Z";
    expect(
      cast(User, { createdAt: at, createdAtConfirmation: at }, ["createdAt"]).validateConfirmation(
        "createdAt",
      ).valid,
    ).toBe(true);
    const Lower = defineType<string>({
      name: "lower",
      db: { kind: "text" },
      cast: (input) =>
        typeof input === "string" ? { success: true, data: input.toLowerCase() } : { success: false },
    });
    const types = { login: t.type(Lower) };
    const login = (confirmation: unknown) =>
      cast({ data: {}, types }, { login: "Ann@X.io", loginConfirmation: confirmation }, [
        "login",
      ]).validateConfirmation("login");
    expect(login("Ann@X.io").valid).toBe(true);
    expect(login("ann@x.io").valid).toBe(true);
    expect(login("Ann@Y.io").valid).toBe(false);
  });

  test("a different value, a value the type rejects, or null is a mismatch", () => {
    const errors = {
      ageConfirmation: [{ message: "does not match confirmation", validation: "confirmation", meta: {} }],
    };
    expect(
      cast(User, { age: "36", ageConfirmation: "37" }, ["age"]).validateConfirmation("age").errors,
    ).toEqual(errors);
    expect(
      cast(User, { age: "36", ageConfirmation: "x" }, ["age"]).validateConfirmation("age").errors,
    ).toEqual(errors);
    expect(
      cast(User, { age: "36", ageConfirmation: null }, ["age"]).validateConfirmation("age").errors,
    ).toEqual(errors);
  });

  test("a confirmation key holding undefined counts as missing", () => {
    const params = { password: "abcdefgh", passwordConfirmation: undefined };
    expect(cast(User, params, ["password"]).validateConfirmation("password").errors).toEqual({});
    expect(
      cast(User, params, ["password"]).validateConfirmation("password", { required: true }).errors,
    ).toEqual({
      passwordConfirmation: [{ message: "can't be blank", validation: "required", meta: {} }],
    });
  });

  test("confirms a change made with putChange; the field need not be in the params", () => {
    const put = cast(User, { passwordConfirmation: "pw1" }, []).putChange("password", "pw1");
    expect(put.validateConfirmation("password").valid).toBe(true);
    expect(put.putChange("password", "pw2").validateConfirmation("password").valid).toBe(false);
  });

  test("a change to null is not confirmed", () => {
    const row = loaded(User, { id: 6, email: "n@example.com", name: "Nell", role: "member", lockVersion: 1 });
    const cs = cast(row, { name: "", nameConfirmation: "x" }, ["name"]);
    expect(cs.changes).toEqual({ name: null });
    expect(cs.validateConfirmation("name").valid).toBe(true);
    expect(cs.validateConfirmation("name", { required: true }).valid).toBe(true);
  });

  test("runs only when the field has a change", () => {
    // A profile form that leaves the password alone is not asked to confirm it.
    expect(cast(User, { passwordConfirmation: "x" }, ["name"]).validateConfirmation("password").valid).toBe(
      true,
    );
    expect(
      cast(User, { name: "Zora" }, ["name"]).validateConfirmation("password", { required: true }).valid,
    ).toBe(true);
    const row = loaded(User, { id: 5, email: "z@example.com", role: "member", lockVersion: 1 });
    expect(
      cast(row, { email: null, emailConfirmation: "x" }, ["email"]).validateConfirmation("email").errors
        .emailConfirmation,
    ).toBeUndefined();
  });

  test("does nothing on a changeset made by change, and takes a message", () => {
    expect(change(User).validateConfirmation("password", { required: true }).valid).toBe(true);
    expect(
      signUp({ password: "a", passwordConfirmation: "b" }).validateConfirmation("password", {
        message: "differs",
      }).errors.passwordConfirmation?.[0]?.message,
    ).toBe("differs");
  });
});

describe("validateAcceptance", () => {
  test("accepts true and its form spellings", () => {
    for (const value of [true, "true", "1", 1]) {
      expect(cast(User, { termsOfService: value }, []).validateAcceptance("termsOfService").valid).toBe(true);
    }
  });

  test("adds must be accepted otherwise, including when the key is missing", () => {
    for (const params of [
      {},
      { termsOfService: false },
      { termsOfService: "yes" },
      { termsOfService: null },
    ]) {
      expect(cast(User, params, []).validateAcceptance("termsOfService").errors).toEqual({
        termsOfService: [{ message: "must be accepted", validation: "acceptance", meta: {} }],
      });
    }
  });

  test("does nothing on a changeset made by change; rejects a bad key", () => {
    expect(change(User).validateAcceptance("termsOfService").valid).toBe(true);
    expect(() => change(User).validateAcceptance("")).toThrow(QueryError);
    expect(() => change(User).validateAcceptance("__proto__")).toThrow(QueryError);
  });
});

describe("validateChange", () => {
  const named = (name: string) => cast(User, { name }, ["name"]);

  test("a returned message becomes an error on the field", () => {
    const cs = named("Bob").validateChange("name", (name, field) =>
      name === "Bob" ? `${field} is taken` : undefined,
    );
    expect(cs.errors).toEqual({ name: [{ message: "name is taken", meta: {} }] });
  });

  test("an error object, a list, or nothing", () => {
    expect(
      named("x").validateChange("name", () => ({
        message: "is short",
        validation: "short",
        meta: { min: 2 },
      })).errors,
    ).toEqual({ name: [{ message: "is short", validation: "short", meta: { min: 2 } }] });
    expect(named("x").validateChange("name", () => ["one", { message: "two" }]).errors.name).toEqual([
      { message: "one", meta: {} },
      { message: "two", meta: {} },
    ]);
    expect(named("x").validateChange("name", () => []).valid).toBe(true);
    expect(named("x").validateChange("name", () => undefined).valid).toBe(true);
  });

  test("throws for a result of another kind, or when not given a function", () => {
    expect(() => named("x").validateChange("name", () => 1 as never)).toThrow(QueryError);
    expect(() => named("x").validateChange("name", () => [{}] as never)).toThrow(QueryError);
    expect(() => named("x").validateChange("name", "x" as never)).toThrow(QueryError);
  });
});

describe("validations on unknown fields", () => {
  test("each throws", () => {
    const cs = change(User);
    const nope = "nope" as never;
    for (const call of [
      () => cs.validateFormat(nope, /x/),
      () => cs.validateInclusion(nope, []),
      () => cs.validateExclusion(nope, []),
      () => cs.validateSubset(nope, []),
      () => cs.validateLength(nope, { min: 1 }),
      () => cs.validateNumber(nope, { lessThan: 1 }),
      () => cs.validateConfirmation(nope),
      () => cs.validateChange(nope, () => undefined),
    ]) {
      expect(call).toThrow(QueryError);
    }
  });
});

class Card extends Schema("cards", {
  id: t.integer().primaryKey(),
  code: t.string().nullable(),
  kind: t.string().nullable(),
  score: t.integer().nullable(),
  labels: t.array(t.string()).nullable(),
  notes: t.array(t.json()).nullable(),
  pin: t.string().nullable(),
}) {}
const card = () =>
  loaded(Card, { id: 1, code: "a", kind: "x", score: 1, labels: ["a"], notes: [], pin: "1" });

describe("validateRequired: lists and single names", () => {
  test("an empty list is a value, not blank", () => {
    expect(cast(card(), { labels: [] }, ["labels"]).validateRequired(["labels"]).valid).toBe(true);
  });

  test("one message per field: a second failing validation adds none", () => {
    const twice = cast(User, {}, []).validateRequired(["email"]).validateLength("email", { min: 3 });
    expect(twice.errors.email).toHaveLength(1);
  });

  test("a single field name reports one error, not one per character", () => {
    expect(cast(User, {}, []).validateRequired("email").errors.email).toHaveLength(1);
  });
});

describe("validations take null as no value", () => {
  test("format, inclusion, exclusion, subset, number and length skip a change to null", () => {
    const cleared = cast(card(), { code: null, kind: null, score: null, labels: null }, [
      "code",
      "kind",
      "score",
      "labels",
    ]);
    const checked = cleared
      .validateFormat("code", /^[a-z]+$/)
      .validateInclusion("kind", ["y"])
      .validateExclusion("kind", ["x"])
      .validateSubset("labels", ["b"])
      .validateNumber("score", { greaterThan: 5 })
      .validateLength("code", { min: 3 });
    expect(checked.errors).toEqual({});
    expect(checked.valid).toBe(true);
  });
});

describe("validateSubset: values and its entry", () => {
  test("elements are compared by value, so equal objects are in the set", () => {
    const cs = cast(card(), { notes: [{ a: 1 }] }, ["notes"]).validateSubset("notes", [{ a: 1 }] as never);
    expect(cs.valid).toBe(true);
  });

  test("its entry in validations() names it subset, with its values", () => {
    const cs = cast(card(), { labels: ["a"] }, ["labels"]).validateSubset("labels", ["a", "b"]);
    expect(cs.validations).toStrictEqual([["labels", { validation: "subset", values: ["a", "b"] }]]);
  });
});

describe("validateLength: is", () => {
  test("is is checked like min and max", () => {
    expect(() => cast(card(), {}, []).validateLength("code", { is: -1 })).toThrow(QueryError);
    expect(() => cast(card(), {}, []).validateLength("code", { is: 1.5 })).toThrow(QueryError);
  });
});

describe("validateNumber: equalTo", () => {
  test("a value above the limit is not equal to it", () => {
    expect(cast(card(), { score: 11 }, ["score"]).validateNumber("score", { equalTo: 10 }).valid).toBe(false);
  });
});

describe("validateConfirmation: no params, and a null confirmation", () => {
  test("a changeset made by change() has no params, and reports nothing", () => {
    const cs = change(card(), { pin: "2" }).validateConfirmation("pin");
    expect(cs.valid).toBe(true);
    expect(cs.errors).toEqual({});
  });

  test("a null confirmation does not match, even for a type whose cast turns null into the value", () => {
    const Lenient = defineType<string>({
      name: "lenient",
      db: { kind: "text" },
      cast: (input) => ({ success: true, data: input === null ? "same" : String(input) }),
    });
    const cs = cast({ data: {}, types: { pin: t.type(Lenient) } }, { pin: "same", pinConfirmation: null }, [
      "pin",
    ]).validateConfirmation("pin");
    expect(cs.errorMessages()).toEqual({ pinConfirmation: ["does not match confirmation"] });
  });
});

describe("validateChange: outcomes", () => {
  test("a failing check makes the changeset invalid; each outcome is recorded as change", () => {
    const failing = cast(card(), { code: "b" }, ["code"]).validateChange("code", () => ["is wrong"]);
    expect(failing.valid).toBe(false);
    expect(failing.validations).toStrictEqual([["code", { validation: "change" }]]);
    const passing = cast(card(), { code: "b" }, ["code"]).validateChange("code", () => []);
    expect(passing.valid).toBe(true);
    expect(passing.validations).toStrictEqual([["code", { validation: "change" }]]);
  });

  test("null and an empty list are no issues", () => {
    const cs = cast(card(), { code: "b" }, ["code"]);
    expect(cs.validateChange("code", () => null as never).valid).toBe(true);
    expect(cs.validateChange("code", () => []).valid).toBe(true);
  });

  test("an error returned without a validation has no validation key", () => {
    const cs = cast(card(), { code: "b" }, ["code"]).validateChange("code", () => ({ message: "is odd" }));
    expect(cs.errors.code).toStrictEqual([{ message: "is odd", meta: {} }]);
    expect(Object.keys(cs.errors.code?.[0] ?? {})).toEqual(["message", "meta"]);
  });
});

describe("validators given a value of the wrong type", () => {
  test("refuse it with a QueryError", () => {
    const scored = cast(card(), { score: 5 }, ["score"]);
    expect(() => scored.validateFormat("score" as never, /x/)).toThrow(QueryError);
    expect(() => scored.validateLength("score" as never, { min: 1 })).toThrow(QueryError);
  });
});
