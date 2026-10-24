/**
 * The built-in types that are made from other values: json, array, enum.
 *
 * @module
 */
import type { AnyFieldType, CastResult, DbType, FieldType } from "../contracts/type.js";
import { IDENTITY } from "../contracts/type.js";
import { CastError, SchemaDefinitionError } from "../errors.js";
import { deepEqual } from "../internal/deep-equal.js";
import { own } from "../internal/own.js";
import { isPlainObject } from "../internal/plain-object.js";
import { defineType, detached, parameterized } from "./define.js";
import { INVALID } from "./scalars.js";

// --- json --------------------------------------------------------------------

/** Deeper nesting than this is rejected, which also keeps the walk off the stack limit. */
const MAX_JSON_DEPTH = 500;

/** What {@link jsonHeight} returns for a value that is not JSON. */
const NOT_JSON = -1;
/** The mark in `seen` of a container whose walk has not finished: meeting it again is a cycle. */
const WALKING = 0;

/**
 * How many containers deep `value` nests (0 for a string, number or boolean, 1 for an
 * empty array), or `NOT_JSON` when it does not survive a round trip through JSON
 * unchanged. JSON values are `null`, booleans, finite numbers, strings, and arrays and
 * plain objects of those, nested at most `MAX_JSON_DEPTH` deep.
 *
 * `seen` holds every container met so far: `WALKING` while it is being walked, then its
 * height. A container referenced from many places is therefore walked once, and the
 * depth limit gives the same answer wherever and however often it appears.
 */
function jsonHeight(value: unknown, seen: Map<object, number>, depth: number): number {
  switch (typeof value) {
    case "string":
    case "boolean":
      return 0;
    case "number":
      return Number.isFinite(value) ? 0 : NOT_JSON;
    case "object":
      break;
    default:
      return NOT_JSON;
  }
  if (value === null) return 0;
  const container = value as object;
  const known = seen.get(container);
  if (known !== undefined) {
    return known === WALKING || depth + known > MAX_JSON_DEPTH ? NOT_JSON : known;
  }
  if (depth >= MAX_JSON_DEPTH) return NOT_JSON;
  seen.set(container, WALKING);
  let tallest = 0;
  if (Array.isArray(container)) {
    for (let i = 0; i < container.length; i++) {
      const height = jsonHeight(container[i], seen, depth + 1);
      if (height === NOT_JSON) return NOT_JSON;
      if (height > tallest) tallest = height;
    }
  } else {
    if (!isPlainObject(container)) return NOT_JSON;
    const record = container as Record<string, unknown>;
    const keys = Object.keys(record);
    for (let i = 0; i < keys.length; i++) {
      const height = jsonHeight(record[keys[i] as string], seen, depth + 1);
      if (height === NOT_JSON) return NOT_JSON;
      if (height > tallest) tallest = height;
    }
  }
  seen.set(container, tallest + 1);
  return tallest + 1;
}

const JSON_TYPE = /* @__PURE__ */ defineType<unknown>({
  name: "json",
  db: { kind: "jsonb" },
  cast: (input) => {
    try {
      return jsonHeight(input, new Map(), 0) === NOT_JSON ? INVALID : { success: true, data: input };
    } catch {
      // A getter or a proxy trap threw.
      return INVALID;
    }
  },
  equal: deepEqual,
});

/**
 * A JSON document. `T` is the type you say it has; nothing checks the shape, so validate
 * untrusted input with a validator.
 *
 * Accepts any value that JSON can represent exactly: `null` inside a document, booleans,
 * finite numbers, strings, arrays and plain objects of those. Rejects what JSON would
 * change or drop: `undefined` inside a document, `NaN`, `Date`, `Map`, class instances,
 * functions, `bigint`, and a value that contains itself.
 *
 * Two documents are equal when they have the same structure, whatever the key order.
 *
 * @example
 * ```ts
 * const settings = jsonType<{ theme: string }>();
 * settings.cast({ theme: "dark" }); // { success: true, data: { theme: "dark" } }
 * settings.equal({ theme: "dark" }, { theme: "dark" }); // true
 * ```
 */
export function jsonType<T = unknown>(): FieldType<T, T> {
  return JSON_TYPE as FieldType<T, T>;
}

// --- array -------------------------------------------------------------------

/** The element type of every array type, for `resolveCodec`. Not a property: every type has one shape. */
const arrayElements = /* @__PURE__ */ new WeakMap<AnyFieldType, AnyFieldType>();

/**
 * The element type of an array type made by {@link arrayType}, or `undefined` for any
 * other type.
 *
 * @example
 * ```ts
 * elementTypeOf(arrayType(integerType())) === integerType(); // true
 * elementTypeOf(integerType()); // undefined
 * ```
 */
export function elementTypeOf(type: AnyFieldType): AnyFieldType | undefined {
  return arrayElements.get(type);
}

/**
 * A conversion applied to each element of an array. A `null` element is passed through,
 * because `null` never reaches a type.
 *
 * @example
 * ```ts
 * const toBigints = mapElements((text) => BigInt(text as string));
 * toBigints(["1", null, "3"]); // [1n, null, 3n]
 * ```
 */
export function mapElements(convert: (value: unknown) => unknown): (values: unknown) => unknown {
  return (values) => {
    const input = values as readonly unknown[];
    const length = input.length;
    const output = new Array<unknown>(length);
    for (let i = 0; i < length; i++) {
      const value = input[i];
      output[i] = value === null || value === undefined ? null : convert(value);
    }
    return output;
  };
}

const arrayOf = /* @__PURE__ */ parameterized((element: AnyFieldType): AnyFieldType => {
  const elementCast = detached(element, "cast");
  const elementEqual = detached(element, "equal");
  const elementFromDb = detached(element, "fromDb");
  const elementToDb = detached(element, "toDb");
  const nested = arrayElements.has(element);

  /**
   * The failure of the element at `index`, with the element's own message and metadata.
   * `path` holds the indexes that lead to the value that failed: `[index]`, or for an
   * array of arrays `[1, 2]` for element 2 of element 1. Every array type writes `path`
   * itself, so an outer array only ever extends a path that an inner array wrote, never
   * a `path` that an element type happened to put in its own metadata.
   */
  const elementFailure = (
    result: CastResult<unknown> & { success: false },
    index: number,
  ): CastResult<never> => {
    // A failure such as the built-in INVALID has no message or meta of its own.
    const failureMeta = own(result, "meta");
    const message = own(result, "message");
    const inner = nested ? own(failureMeta, "path") : undefined;
    const path = Array.isArray(inner) ? [index, ...(inner as readonly unknown[])] : [index];
    const meta = { ...failureMeta, index, path };
    return message === undefined ? { success: false, meta } : { success: false, message, meta };
  };

  const castElements = (input: readonly unknown[]): CastResult<unknown[]> => {
    const length = input.length;
    const data = new Array<unknown>(length);
    for (let index = 0; index < length; index++) {
      const value = input[index];
      // `null` never reaches a type, and an element type has no way to say it is nullable.
      const result: CastResult<unknown> =
        value === null || value === undefined ? INVALID : elementCast(value);
      if (!result.success) return elementFailure(result, index);
      data[index] = result.data;
    }
    return { success: true, data };
  };

  const type = defineType<unknown[], unknown>({
    name: `array(${element.name})`,
    db: { kind: "array", of: element.db },
    cast: (input) => {
      try {
        return Array.isArray(input) ? castElements(input) : INVALID;
      } catch {
        // A proxy trap threw.
        return INVALID;
      }
    },
    fromDb: (elementFromDb === IDENTITY ? IDENTITY : mapElements(elementFromDb)) as (
      value: unknown,
    ) => unknown[],
    toDb: elementToDb === IDENTITY ? IDENTITY : mapElements(elementToDb),
    equal: (a, b) => {
      if (a === b) return true;
      const length = a.length;
      if (length !== b.length) return false;
      for (let i = 0; i < length; i++) {
        const left = a[i];
        const right = b[i];
        if (left === right) continue;
        // A stored array may hold NULLs, and `null` never reaches a type.
        if (left == null || right == null || !elementEqual(left, right)) return false;
      }
      return true;
    },
  });
  arrayElements.set(type, element);
  return type;
});

/**
 * An array of `element`. Accepts an array and casts each element with the element type;
 * if one fails, the cast fails with that element's message, `meta.index` and `meta.path`
 * (the indexes that lead to the value: `[1]`, or `[1, 2]` in an array of arrays). A `null`
 * element is rejected.
 *
 * `fromDb` and `toDb` convert each element, and are skipped entirely when the element
 * type needs no conversion. Two arrays are equal when they have the same length and
 * equal elements in the same order.
 *
 * Asking twice for an array of the same element type gives the same type object.
 *
 * @example
 * ```ts
 * const tags = arrayType(stringType());
 * tags.cast(["a", "b"]); // { success: true, data: ["a", "b"] }
 * tags.cast(["a", 2]); // { success: false, meta: { index: 1, path: [1] } }
 * ```
 */
export function arrayType<TApp, TDb>(element: FieldType<TApp, TDb>): FieldType<TApp[], TDb[]> {
  return arrayOf(element as AnyFieldType) as FieldType<TApp[], TDb[]>;
}

// --- enum --------------------------------------------------------------------

/**
 * The mapping of `t.enum({ ... })`: each key is a value in TypeScript, each value what is
 * stored. The stored values are all strings or all whole numbers.
 *
 * @example
 * ```ts
 * import { type EnumMapping, t } from "egon-orm";
 *
 * const levels = { low: 1, high: 2 } as const satisfies EnumMapping;
 * const level = t.enum(levels); // "low" | "high"
 * ```
 */
export type EnumMapping = Readonly<Record<string, string>> | Readonly<Record<string, number>>;

interface EnumOptions {
  readonly keys: readonly string[];
  /** `undefined` for a plain list, where the stored value is the key. */
  readonly stored: readonly (string | number)[] | undefined;
}

const enumWith = /* @__PURE__ */ parameterized((options: EnumOptions): AnyFieldType => {
  const { keys, stored } = options;
  if (stored === undefined) {
    const members = new Set<unknown>(keys);
    return defineType<string>({
      name: "enum",
      db: { kind: "text" },
      cast: (input) => (members.has(input) ? { success: true, data: input as string } : INVALID),
    }) as AnyFieldType;
  }

  const storedKind = typeof stored[0];
  const db: DbType = { kind: storedKind === "number" ? "integer" : "text" };
  // Results are prebuilt: casting an enum allocates nothing.
  const casts = new Map<unknown, CastResult<string>>();
  const keyOf = new Map<string | number, string>();
  const storedOf = new Map<string, string | number>();
  keys.forEach((key, i) => {
    const value = stored[i] as string | number;
    const result: CastResult<string> = Object.freeze({ success: true, data: key });
    // A key and a stored value never collide, except a key with its own value (enumType checks).
    casts.set(value, result);
    casts.set(key, result);
    keyOf.set(value, key);
    storedOf.set(key, value);
  });

  return defineType<string, string | number>({
    name: "enum",
    db,
    cast: (input) => casts.get(input) ?? INVALID,
    fromDb: (value) => {
      const key = keyOf.get(value);
      if (key === undefined) {
        // The value itself is left out: the field may be redacted.
        throw new CastError(
          "cast.enumStoredValue",
          `An enum column holds a ${typeof value} that is not one of the enum's stored values (${stored.map((v) => JSON.stringify(v)).join(", ")}).`,
        );
      }
      return key;
    },
    toDb: (key) => {
      const value = storedOf.get(key);
      if (value === undefined) {
        throw new CastError(
          "cast.enumWriteValue",
          `A value that is not a member of the enum (${keys.map((k) => JSON.stringify(k)).join(", ")}) cannot be written to an enum column.`,
        );
      }
      return value;
    },
  }) as AnyFieldType;
});

function describeMember(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? JSON.stringify(value) : typeof value;
}

/**
 * One value out of a fixed set, typed as a union of string literals.
 *
 * With a list, `enumType(["admin", "member"])`, the stored value is the string itself.
 * With a mapping, `enumType({ low: 1, high: 2 })`, the value in application code is the
 * key and the stored value is what it maps to (all strings or all whole numbers); input
 * may be the key or the stored value.
 *
 * Asking twice for the same members gives the same type object.
 *
 * @example
 * ```ts
 * const role = enumType(["admin", "member"]); // FieldType<"admin" | "member", string>
 * role.cast("admin"); // { success: true, data: "admin" }
 *
 * const level = enumType({ low: 1, high: 2 }); // FieldType<"low" | "high", number>
 * level.cast(2); // { success: true, data: "high" }
 * level.toDb("high"); // 2
 * ```
 *
 * @throws SchemaDefinitionError when the members are empty, repeated, or not all strings
 * (a list) or all strings or all whole numbers (a mapping), and when a key of a mapping is
 * also the stored value of another key.
 * @throws CastError from `fromDb` and `toDb` of a mapped enum, for a value that is not a member.
 */
export function enumType<const V extends readonly [string, ...string[]]>(
  values: V,
): FieldType<V[number], string>;
export function enumType<const M extends EnumMapping>(mapping: M): FieldType<keyof M & string, M[keyof M]>;
export function enumType(members: readonly string[] | EnumMapping): AnyFieldType {
  if (typeof members !== "object" || members === null) {
    throw new SchemaDefinitionError(
      "schema.enumMembers",
      `t.enum takes a list of strings or a mapping, but got ${members === null ? "null" : typeof members}.`,
    );
  }
  if (Array.isArray(members)) {
    const keys = members as readonly unknown[];
    if (keys.length === 0)
      throw new SchemaDefinitionError("schema.enumEmpty", "t.enum needs at least one value.");
    for (const key of keys) {
      if (typeof key !== "string") {
        throw new SchemaDefinitionError(
          "schema.enumMemberType",
          `t.enum values must be strings, but got ${describeMember(key)}.`,
        );
      }
    }
    if (new Set(keys).size !== keys.length) {
      throw new SchemaDefinitionError(
        "schema.enumDuplicate",
        `t.enum values must be distinct, but got ${JSON.stringify(keys)}.`,
      );
    }
    return enumWith({ keys: keys as readonly string[], stored: undefined });
  }

  const mapping = members as Readonly<Record<string, unknown>>;
  // Sorted, so that the same mapping written in another order is the same type.
  const keys = Object.keys(mapping).sort();
  if (keys.length === 0)
    throw new SchemaDefinitionError("schema.enumEmpty", "t.enum needs at least one value.");
  const stored = keys.map((key) => mapping[key]);
  const kind = typeof stored[0];
  for (const value of stored) {
    const valid =
      kind === "number" ? Number.isSafeInteger(value) : kind === "string" && typeof value === "string";
    if (!valid) {
      throw new SchemaDefinitionError(
        "schema.enumMappingValues",
        `t.enum mapping values must be all strings or all whole numbers, but got ${stored.map(describeMember).join(", ")}.`,
      );
    }
  }
  if (new Set(stored).size !== stored.length) {
    throw new SchemaDefinitionError(
      "schema.enumMappingDuplicate",
      `t.enum mapping values must be distinct, but got ${stored.map(describeMember).join(", ")}.`,
    );
  }
  for (const key of keys) {
    // Input may be a key or a stored value, so one spelling must not mean two members.
    const other = keys.find((k) => k !== key && mapping[k] === key);
    if (other !== undefined) {
      throw new SchemaDefinitionError(
        "schema.enumMappingAmbiguous",
        `t.enum mapping is ambiguous: ${JSON.stringify(key)} is a key and also the stored value of ${JSON.stringify(other)}, so input ${JSON.stringify(key)} could mean either.`,
      );
    }
  }
  return enumWith({ keys, stored: stored as readonly (string | number)[] });
}
