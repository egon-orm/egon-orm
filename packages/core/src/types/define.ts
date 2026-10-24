/**
 * `defineType` and `parameterized`: how every type is made, the built-in ones included.
 *
 * @module
 */
import type { AnyFieldType, CastResult, DbType, FieldType } from "../contracts/type.js";
import { CUSTOM_SQL_TYPE, IDENTITY } from "../contracts/type.js";
import { SchemaDefinitionError } from "../errors.js";
import { own } from "../internal/own.js";

/**
 * The conversions of a {@link TypeDefinition}. They may be left out only when the
 * application value and the driver value are the same type.
 */
type Conversions<TApp, TDb> = [TApp] extends [TDb]
  ? [TDb] extends [TApp]
    ? { readonly fromDb?: (value: TDb) => TApp; readonly toDb?: (value: TApp) => TDb }
    : { readonly fromDb: (value: TDb) => TApp; readonly toDb: (value: TApp) => TDb }
  : { readonly fromDb: (value: TDb) => TApp; readonly toDb: (value: TApp) => TDb };

/**
 * What {@link defineType} takes: a type's name, its column type and its conversions.
 * `TApp` is the value in application code; `TDb` is what the driver sends and receives.
 *
 * `fromDb` and `toDb` are optional when `TApp` and `TDb` are the same type, and required
 * otherwise. `equal` is always optional.
 *
 * @example
 * ```ts
 * const definition: TypeDefinition<string, string> = {
 *   name: "slug",
 *   db: { kind: "text" },
 *   cast: (input) =>
 *     typeof input === "string" ? { success: true, data: input.toLowerCase() } : { success: false },
 * };
 * ```
 */
export type TypeDefinition<TApp, TDb = TApp> = {
  /** Shown in error messages. */
  readonly name: string;
  /** The logical column type. A `custom` type's `sql` must be a constant you wrote, never user data. */
  readonly db: DbType;
  /** Untrusted input to an application value. It must never throw. */
  readonly cast: (input: unknown) => CastResult<TApp>;
  /** Whether two values are the same. Defaults to `Object.is`. */
  readonly equal?: (a: TApp, b: TApp) => boolean;
} & Conversions<TApp, TDb>;

function describe(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "an array" : typeof value;
}

const SIMPLE_KINDS: ReadonlySet<string> = /* @__PURE__ */ new Set([
  "integer",
  "bigint",
  "float",
  "decimal",
  "boolean",
  "text",
  "uuid",
  "binary",
  "date",
  "time",
  "timestamp",
  "timestamptz",
  "json",
  "jsonb",
]);

/**
 * Checks a column type and returns a frozen copy of it, so that what was checked is what
 * the type keeps: the caller's object can be changed afterwards without changing the type.
 */
function checkedDbType(typeName: string, db: unknown, path: string): DbType {
  // Each property is read once: what is checked is what is kept, even if the caller's
  // object answers differently the next time it is asked.
  const kind: unknown = typeof db === "object" ? own(db as { kind?: unknown } | null, "kind") : undefined;
  if (typeof kind !== "string") {
    throw new SchemaDefinitionError(
      "schema.typeDbKind",
      `Type "${typeName}": ${path} must be a column type such as { kind: "text" }, but it is ${describe(db)}.`,
    );
  }
  if (kind === "array") {
    const of = checkedDbType(typeName, own(db as { of?: unknown }, "of"), `${path}.of`);
    return Object.freeze({ kind, of });
  }
  if (kind === "custom") {
    // Trusted developer input (decision D9). The compiler checks it again before emitting it.
    const sql: unknown = own(db as { sql?: unknown }, "sql");
    if (typeof sql !== "string" || !CUSTOM_SQL_TYPE.test(sql)) {
      throw new SchemaDefinitionError(
        "schema.typeCustomSql",
        `Type "${typeName}": ${path}.sql must be a plain SQL type name such as "citext", "numeric(10, 2)" or "public.mood[]".`,
      );
    }
    return Object.freeze({ kind, sql });
  }
  if (!SIMPLE_KINDS.has(kind)) {
    throw new SchemaDefinitionError(
      "schema.typeUnknownKind",
      `Type "${typeName}": ${path}.kind is ${JSON.stringify(kind)}, which is not a column kind. The kinds are ${[...SIMPLE_KINDS].join(", ")}, "array" and "custom".`,
    );
  }
  return Object.freeze({ kind }) as DbType;
}

/**
 * Creates a type: how one kind of value is accepted from untrusted input, read from the
 * database, written to it and compared.
 *
 * Leave `fromDb` and `toDb` out when the driver's value is already the value you want;
 * the library then skips the call entirely when it reads rows. `equal` defaults to
 * `Object.is`. The functions are called on their own, never as methods, so they must not
 * use `this`. The `db` object is copied, so changing yours afterwards changes nothing.
 *
 * @example
 * ```ts
 * const Cents = defineType<bigint, string>({
 *   name: "cents",
 *   db: { kind: "decimal" },
 *   cast: (input) =>
 *     typeof input === "string" && /^\d+$/.test(input)
 *       ? { success: true, data: BigInt(input) }
 *       : { success: false, message: "is not a whole amount" },
 *   fromDb: (stored) => BigInt(stored),
 *   toDb: (cents) => cents.toString(),
 * });
 * ```
 *
 * @throws SchemaDefinitionError when the definition is malformed: no name, a `cast` that
 * is not a function, a column kind that does not exist, or a `custom` column type that is
 * not a plain SQL type name.
 */
export function defineType<TApp, TDb = TApp>(definition: TypeDefinition<TApp, TDb>): FieldType<TApp, TDb> {
  // Own properties only: a key planted on Object.prototype is not part of the definition.
  const name = own(definition, "name");
  const db = own(definition, "db");
  const cast = own(definition, "cast");
  const equal = own(definition, "equal");
  const conversions = definition as {
    readonly fromDb?: (value: TDb) => TApp;
    readonly toDb?: (value: TApp) => TDb;
  };
  const fromDb = own(conversions, "fromDb");
  const toDb = own(conversions, "toDb");
  if (typeof name !== "string" || name === "") {
    throw new SchemaDefinitionError(
      "schema.typeName",
      `defineType needs a non-empty name (it appears in error messages), but got ${describe(name)}.`,
    );
  }
  const checkedDb = checkedDbType(name, db, "db");
  if (typeof cast !== "function") {
    throw new SchemaDefinitionError(
      "schema.typeCast",
      `Type "${name}": cast must be a function that returns { success: true, data } or { success: false }, but it is ${describe(cast)}.`,
    );
  }
  for (const [member, fn] of [
    ["fromDb", fromDb],
    ["toDb", toDb],
    ["equal", equal],
  ] as const) {
    if (fn !== undefined && typeof fn !== "function") {
      throw new SchemaDefinitionError(
        "schema.typeMember",
        `Type "${name}": ${member} must be a function or be left out, but it is ${describe(fn)}.`,
      );
    }
  }
  // One shape for every type, in the order of the FieldType interface: the hydration and
  // parameter loops read `fromDb` and `toDb` from many different types.
  const type: FieldType<TApp, TDb> = Object.freeze({
    name,
    db: checkedDb,
    cast,
    fromDb: fromDb ?? (IDENTITY as (value: TDb) => TApp),
    toDb: toDb ?? (IDENTITY as (value: TApp) => TDb),
    equal: equal ?? Object.is,
  });
  definedTypes.add(type);
  return type;
}

/** Every type made by {@link defineType}: in the options of a parameterized type, it is compared by identity. */
const definedTypes = /* @__PURE__ */ new WeakSet<object>();

/**
 * One of a type's functions, safe to call on its own.
 *
 * The `FieldType` contract declares its members as methods, so a type written by hand as
 * a class may use `this`. Code that keeps a type's function apart from the type (an array
 * type keeps its element's, a codec keeps `fromDb` and `toDb`) takes it through here: a
 * type made by `defineType` gives the function itself, which never uses `this`; any other
 * type gives it bound to the type, once. `IDENTITY` is never bound, so the reference check
 * that skips it keeps working.
 *
 * @example
 * ```ts
 * const fromDb = detached(type, "fromDb");
 * const value = fromDb === IDENTITY ? raw : fromDb(raw);
 * ```
 */
export function detached<K extends "cast" | "fromDb" | "toDb" | "equal">(
  type: AnyFieldType,
  member: K,
): AnyFieldType[K] {
  const fn = type[member] as (...args: never[]) => unknown;
  if (fn === IDENTITY || definedTypes.has(type)) return fn as AnyFieldType[K];
  return fn.bind(type) as AnyFieldType[K];
}

const identities = /* @__PURE__ */ new Map<symbol, number>();
const objectIdentities = /* @__PURE__ */ new WeakMap<object, number>();
let nextIdentity = 1;

function identityKey(value: object | symbol): string {
  const ids = typeof value === "symbol" ? identities : objectIdentities;
  let id = (ids as Map<unknown, number>).get(value);
  if (id === undefined) {
    id = nextIdentity++;
    (ids as Map<unknown, number>).set(value, id);
  }
  return `#${id}`;
}

/** Options nested deeper than this are taken to contain themselves. */
const MAX_OPTIONS_DEPTH = 100;

/**
 * A string that is equal for two option values when they are structurally equal, and
 * different otherwise. Plain objects compare by their own enumerable keys, symbol keys
 * included, whatever the key order; arrays by their elements in order; primitives by
 * value and type. Anything else (a type, a function, a symbol, a class instance) compares
 * by identity.
 */
function optionsKey(value: unknown, depth: number): string {
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return Object.is(value, -0) ? "-0" : String(value);
    case "bigint":
      return `${value}n`;
    case "boolean":
      return value ? "true" : "false";
    case "undefined":
      return "undefined";
    case "symbol":
    case "function":
      return identityKey(value);
    default:
      break;
  }
  if (value === null) return "null";
  if (depth > MAX_OPTIONS_DEPTH) {
    throw new SchemaDefinitionError(
      "schema.typeOptionsDepth",
      `The options of a parameterized type are nested more than ${MAX_OPTIONS_DEPTH} levels deep.`,
    );
  }
  const object = value as object;
  if (Array.isArray(object)) {
    let key = "[";
    for (let i = 0; i < object.length; i++) key += `${optionsKey(object[i], depth + 1)},`;
    return `${key}]`;
  }
  const prototype = Object.getPrototypeOf(object);
  if ((prototype !== Object.prototype && prototype !== null) || definedTypes.has(object)) {
    return identityKey(object);
  }
  const record = object as Record<string | symbol, unknown>;
  const entries: string[] = [];
  for (const name of Object.keys(record)) {
    entries.push(`${JSON.stringify(name)}:${optionsKey(record[name], depth + 1)}`);
  }
  for (const symbol of Object.getOwnPropertySymbols(record)) {
    if (Object.prototype.propertyIsEnumerable.call(record, symbol)) {
      entries.push(`${identityKey(symbol)}:${optionsKey(record[symbol], depth + 1)}`);
    }
  }
  return `{${entries.sort().join(",")}}`;
}

/**
 * Builds a family of types from options, and remembers the result per option set: calling
 * the returned function twice with equal options gives the same type object. That matters
 * because types are compared by identity when plans and codecs are cached.
 *
 * Options are compared by content: plain objects whatever their key order, arrays in
 * order, primitives by value. A type, a function or a class instance inside the options
 * is compared by identity. Options must be plain data: options that contain themselves
 * throw `SchemaDefinitionError`.
 *
 * @example
 * ```ts
 * const fixedString = parameterized((opts: { length: number }) =>
 *   defineType<string>({
 *     name: `char(${opts.length})`,
 *     db: { kind: "custom", sql: `char(${opts.length})` },
 *     cast: (input) =>
 *       typeof input === "string" && input.length === opts.length
 *         ? { success: true, data: input }
 *         : { success: false, message: "should be {count} character(s)", meta: { count: opts.length } },
 *   }),
 * );
 *
 * fixedString({ length: 2 }) === fixedString({ length: 2 }); // true
 * ```
 */
export function parameterized<TOptions, TType extends AnyFieldType>(
  build: (options: TOptions) => TType,
): (options: TOptions) => TType {
  const cache = new Map<string, TType>();
  return (options) => {
    const key = optionsKey(options, 0);
    let type = cache.get(key);
    if (type === undefined) {
      type = build(options);
      cache.set(key, type);
    }
    return type;
  };
}
