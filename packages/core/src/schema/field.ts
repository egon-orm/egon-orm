/**
 * The field builder `t` and `timestamps()`: how the fields of a schema are declared.
 *
 * A builder is an immutable value. Every modifier returns a new one, so a builder can be
 * shared between schemas; `Schema()` reads what the builders say when the class is made.
 *
 * @module
 */
import type {
  AnySchema,
  DefaultFieldFlags,
  FieldBuilder,
  FieldFlags,
  FieldMeta,
  Row,
  WithFlag,
  WithoutJson,
  Writable,
} from "../contracts/schema.js";
import { META } from "../contracts/schema.js";
import type { AnyFieldType, FieldType } from "../contracts/type.js";
import { SchemaDefinitionError } from "../errors.js";
import { own } from "../internal/own.js";
import { embedType } from "../types/embed.js";
import type { DecimalOptions, EnumMapping, TimestampOptions } from "../types/index.js";
import {
  arrayType,
  bigintType,
  binaryType,
  booleanType,
  dateType,
  decimalType,
  detached,
  enumType,
  floatType,
  integerType,
  jsonType,
  localTimestampType,
  stringType,
  timestampType,
  timeType,
  uuidType,
} from "../types/index.js";
import { uuidv7 } from "./uuid.js";

/**
 * What a nested write does with an embed that the new value replaces (step 15).
 *
 * @example
 * ```ts
 * const onReplace: EmbedOnReplace = "delete";
 * ```
 */
export type EmbedOnReplace = "error" | "invalid" | "update" | "delete";

/**
 * Options of `t.embedOne` and `t.embedMany`.
 *
 * @example
 * ```ts
 * const options: EmbedOptions = { onReplace: "delete" };
 * ```
 */
export interface EmbedOptions {
  /** Defaults to `"error"`. `"update"` is for `embedOne` only. */
  readonly onReplace?: EmbedOnReplace;
}

/**
 * The builder of an embed field, as the types see it: a {@link FieldBuilder} that also
 * records the embedded schema class `E` and whether the field holds one row or a list
 * (`M`), through every modifier that applies to an embed. Changesets read it to type
 * `castEmbed`, `putEmbed` and the nested changes of the field. At run time it is an
 * ordinary builder; `"~embed"` exists only in the type system.
 *
 * @example
 * ```ts
 * const address: EmbedFieldBuilder<typeof Address, "one", Address | null> = t.embedOne(() => Address).nullable();
 * ```
 */
export interface EmbedFieldBuilder<
  E extends AnySchema,
  M extends "one" | "many",
  T,
  F extends FieldFlags = DefaultFieldFlags,
> extends FieldBuilder<T, F> {
  readonly "~embed"?: { readonly schema: E; readonly cardinality: M };
  nullable(): EmbedFieldBuilder<E, M, T | null, WithFlag<F, "nullable">>;
  default(value: T | (() => T)): EmbedFieldBuilder<E, M, T, WithFlag<F, "defaulted">>;
  column(name: string): EmbedFieldBuilder<E, M, T, F>;
  redact(): EmbedFieldBuilder<E, M, T, WithoutJson<F>>;
  writable(mode: Writable): EmbedFieldBuilder<E, M, T, F>;
}

/** What an embed builder knows beyond a plain field. */
export interface EmbedState {
  readonly cardinality: "one" | "many";
  readonly schema: () => AnySchema;
  readonly onReplace: EmbedOnReplace;
}

/**
 * Everything a builder has been told. `Schema()` turns it into a `FieldMeta` once the
 * field's name is known.
 */
export interface FieldState {
  readonly type: AnyFieldType;
  readonly nullable: boolean;
  readonly primaryKey: boolean;
  readonly virtual: boolean;
  readonly redact: boolean;
  /** In a row's JSON: false once `.redact()` or `.virtual()` (without `{ json: true }`) was called. */
  readonly json: boolean;
  readonly writable: Writable;
  readonly dbGenerated: boolean;
  readonly default: FieldMeta["default"];
  readonly autogenerate: FieldMeta["autogenerate"];
  readonly column: string | undefined;
  readonly embed: EmbedState | undefined;
}

/** The key under which a builder holds its {@link FieldState}. Registered, so two copies of the package agree. */
const FIELD: unique symbol = /* @__PURE__ */ Symbol.for("egon.field");

const WRITABLE: ReadonlySet<unknown> = /* @__PURE__ */ new Set<Writable>(["always", "insert", "never"]);

/** The builder that `t.<type>()` returns. Its public face is the `FieldBuilder` contract. */
class Builder<T, F extends FieldFlags> implements FieldBuilder<T, F> {
  declare readonly "~field"?: { readonly type: T; readonly flags: F };
  readonly [FIELD]: FieldState;

  constructor(state: FieldState) {
    this[FIELD] = state;
    Object.freeze(this);
  }

  nullable(): FieldBuilder<T | null, WithFlag<F, "nullable">> {
    return new Builder({ ...this[FIELD], nullable: true });
  }

  default(value: T | (() => T)): FieldBuilder<T, WithFlag<F, "defaulted">> {
    if (value === undefined) {
      throw new SchemaDefinitionError(
        "schema.defaultValue",
        "default() needs a value, or a function that returns one.",
      );
    }
    return new Builder({
      ...this[FIELD],
      default:
        typeof value === "function"
          ? Object.freeze({ kind: "fn" as const, fn: value as () => unknown })
          : Object.freeze({ kind: "value" as const, value }),
    });
  }

  primaryKey(): FieldBuilder<T, WithFlag<F, "primaryKey">> {
    return new Builder({ ...this[FIELD], primaryKey: true });
  }

  autogenerate(fn?: () => T): FieldBuilder<T, WithFlag<F, "defaulted">> {
    if (fn !== undefined && typeof fn !== "function") {
      throw new SchemaDefinitionError(
        "schema.autogenerateFunction",
        "autogenerate() takes a function that returns the value.",
      );
    }
    const generate = fn ?? defaultGenerator(this[FIELD].type);
    return new Builder({
      ...this[FIELD],
      autogenerate: Object.freeze({ on: "insert" as const, fn: generate }),
    });
  }

  virtual(options?: { readonly json?: false }): FieldBuilder<T, WithoutJson<WithFlag<F, "virtual">>>;
  virtual(options: { readonly json: true }): FieldBuilder<T, WithFlag<F, "virtual">>;
  virtual(options?: { readonly json?: boolean }): FieldBuilder<T, FieldFlags> {
    const given: unknown = options;
    if (given !== undefined && (typeof given !== "object" || given === null)) {
      throw new SchemaDefinitionError(
        "schema.virtualOptions",
        "virtual() takes no options, or { json: true }.",
      );
    }
    const unknownKey = given === undefined ? undefined : Object.keys(given).find((key) => key !== "json");
    if (unknownKey !== undefined) {
      throw new SchemaDefinitionError(
        "schema.virtualUnknownOption",
        `virtual() has no option "${unknownKey}". It takes json.`,
      );
    }
    const json: unknown = own(given as { readonly json?: unknown } | undefined, "json");
    if (json !== undefined && typeof json !== "boolean") {
      throw new SchemaDefinitionError("schema.virtualJsonOption", "virtual(): json must be true or false.");
    }
    // { json: true } keeps the flag as it is: a redacted field stays out of JSON.
    return new Builder({ ...this[FIELD], virtual: true, json: json === true ? this[FIELD].json : false });
  }

  column(name: string): FieldBuilder<T, F> {
    if (typeof name !== "string" || name === "") {
      throw new SchemaDefinitionError(
        "schema.columnName",
        "column() needs the column name as a non-empty string.",
      );
    }
    return new Builder({ ...this[FIELD], column: name });
  }

  redact(): FieldBuilder<T, WithoutJson<F>> {
    return new Builder({ ...this[FIELD], redact: true, json: false });
  }

  dbGenerated(): FieldBuilder<T, WithFlag<F, "defaulted">> {
    return new Builder({ ...this[FIELD], dbGenerated: true });
  }

  writable(mode: Writable): FieldBuilder<T, F> {
    if (!WRITABLE.has(mode)) {
      throw new SchemaDefinitionError(
        "schema.writableOption",
        'writable() takes "always", "insert" or "never".',
      );
    }
    return new Builder({ ...this[FIELD], writable: mode });
  }
}

type AnyBuilder = Builder<never, never>;

/** The value an `.autogenerate()` without a function produces, by type. */
function defaultGenerator(type: AnyFieldType): () => unknown {
  // Wrapped, so that an argument given to the generator is never taken for a time.
  if (type.name === "uuid") return () => uuidv7();
  const now = currentTime(type);
  if (now !== undefined) return now;
  throw new SchemaDefinitionError(
    "schema.autogenerateType",
    `autogenerate() without a function has no value to make for the type ${type.name}.`,
  );
}

/**
 * A function returning the current time as `type` holds it (a seconds-precision type
 * drops the milliseconds), or `undefined` when `type` does not take a `Date`.
 */
function currentTime(type: AnyFieldType): (() => unknown) | undefined {
  if (type.db.kind !== "timestamptz" && type.db.kind !== "timestamp") return undefined;
  const cast = detached(type, "cast");
  if (!cast(new Date()).success) return undefined;
  return () => (cast(new Date()) as { readonly data?: unknown }).data;
}

function pristine(type: AnyFieldType): FieldState {
  return {
    type,
    nullable: false,
    primaryKey: false,
    virtual: false,
    redact: false,
    json: true,
    writable: "always",
    dbGenerated: false,
    default: undefined,
    autogenerate: undefined,
    column: undefined,
    embed: undefined,
  };
}

function isPristine(state: FieldState): boolean {
  return (
    !state.nullable &&
    !state.primaryKey &&
    !state.virtual &&
    !state.redact &&
    state.writable === "always" &&
    !state.dbGenerated &&
    state.default === undefined &&
    state.autogenerate === undefined &&
    state.column === undefined &&
    state.embed === undefined
  );
}

function builder<T, F extends FieldFlags = DefaultFieldFlags>(type: AnyFieldType): FieldBuilder<T, F> {
  return new Builder<T, F>(pristine(type));
}

/**
 * What a builder has been told, or `undefined` when `value` is not a field builder.
 *
 * @example
 * ```ts
 * fieldState(t.string().nullable())?.nullable; // true
 * fieldState("not a builder"); // undefined
 * ```
 */
export function fieldState(value: unknown): FieldState | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const state = (value as { readonly [FIELD]?: unknown })[FIELD];
  return typeof state === "object" && state !== null ? (state as FieldState) : undefined;
}

/**
 * The type behind a field builder: what `param`, `expr.cast` and schemaless changesets
 * read when they are given `t.integer()` to say which type a value has.
 *
 * @example
 * ```ts
 * fieldTypeOf(t.integer()).name; // "integer"
 * ```
 *
 * @throws SchemaDefinitionError when `value` is not a field builder.
 */
export function fieldTypeOf(value: unknown): AnyFieldType {
  const state = fieldState(value);
  if (state === undefined) {
    throw new SchemaDefinitionError(
      "schema.notFieldTypeValue",
      "Expected a field type such as t.integer() or t.string().",
    );
  }
  return state.type;
}

function embed(
  factory: "embedOne" | "embedMany",
  schema: () => AnySchema,
  options: EmbedOptions | undefined,
): FieldState {
  // A schema class holds its metadata under META and a thunk does not: `Address` for `() => Address`.
  if (typeof schema !== "function" || META in schema) {
    throw new SchemaDefinitionError(
      "schema.embedSchemaThunk",
      `t.${factory}() takes a function that returns the embedded schema class.`,
    );
  }
  const onReplace = own(options, "onReplace") ?? "error";
  const allowed = factory === "embedOne" ? EMBED_ONE_ON_REPLACE : EMBED_MANY_ON_REPLACE;
  if (!allowed.has(onReplace)) {
    throw new SchemaDefinitionError(
      "schema.onReplaceOption",
      `t.${factory}(): onReplace must be one of ${[...allowed].map((mode) => `"${mode}"`).join(", ")}.`,
    );
  }
  return {
    ...pristine(embedType(factory === "embedOne" ? "one" : "many", schema, onReplace)),
    embed: Object.freeze({ cardinality: factory === "embedOne" ? "one" : "many", schema, onReplace }),
  };
}

const EMBED_ONE_ON_REPLACE: ReadonlySet<unknown> = /* @__PURE__ */ new Set([
  "error",
  "invalid",
  "update",
  "delete",
]);
const EMBED_MANY_ON_REPLACE: ReadonlySet<unknown> = /* @__PURE__ */ new Set(["error", "invalid", "delete"]);

const emptyList = (): unknown[] => [];

/**
 * The field types: what `t` offers. Each call returns a {@link FieldBuilder} to chain
 * modifiers on.
 *
 * @example
 * ```ts
 * const fields = {
 *   id: t.integer().primaryKey().dbGenerated(),
 *   email: t.string(),
 *   role: t.enum(["admin", "member"]).default("member"),
 *   tags: t.array(t.string()).nullable(),
 * };
 * ```
 */
export interface FieldTypes {
  /** Text. */
  string(): FieldBuilder<string>;
  /** A whole number that a JavaScript `number` holds exactly. */
  integer(): FieldBuilder<number>;
  /** A 64-bit integer: a `bigint`, or with `{ mode: "number" }` a `number`. */
  bigint(options?: { readonly mode?: "bigint" }): FieldBuilder<bigint>;
  bigint(options: { readonly mode: "number" }): FieldBuilder<number>;
  /** A floating-point number. */
  float(): FieldBuilder<number>;
  /** An exact decimal, as a string. `{ precision, scale }` rounds to the column's scale. */
  decimal(options?: DecimalOptions): FieldBuilder<string>;
  /** `true` or `false`. */
  boolean(): FieldBuilder<boolean>;
  /** A UUID, in its 36-character lower-case form. */
  uuid(): FieldBuilder<string>;
  /** Bytes. */
  binary(): FieldBuilder<Uint8Array>;
  /** A calendar date: a `"YYYY-MM-DD"` string, or with `{ as: "date" }` a `Date` at midnight UTC. */
  date(options?: { readonly as?: "string" }): FieldBuilder<string>;
  date(options: { readonly as: "date" }): FieldBuilder<Date>;
  /** A time of day, as `"HH:MM:SS"` with an optional fraction. */
  time(): FieldBuilder<string>;
  /** A point in time (`timestamptz`), as a `Date`. */
  timestamp(options?: TimestampOptions): FieldBuilder<Date>;
  /** A date and time without a time zone (`timestamp`), as a `Date` whose UTC fields are the wall time. */
  localTimestamp(options?: TimestampOptions): FieldBuilder<Date>;
  /** Any JSON document, typed as `T`. The shape is not checked. */
  json<T = unknown>(): FieldBuilder<T>;
  /** An array of `inner`. Modifiers go on the array, not on `inner`. */
  array<T>(inner: FieldBuilder<T, DefaultFieldFlags>): FieldBuilder<T[]>;
  /** One of a list of strings, or one of the keys of a mapping to stored values. */
  enum<const V extends readonly [string, ...string[]]>(values: V): FieldBuilder<V[number]>;
  enum<const M extends EnumMapping>(mapping: M): FieldBuilder<keyof M & string>;
  /** A type of your own, made with `defineType`. */
  type<TApp, TDb>(type: FieldType<TApp, TDb>): FieldBuilder<TApp>;
  /** One embedded object, stored in a JSON column. */
  embedOne<S extends AnySchema>(schema: () => S, options?: EmbedOptions): EmbedFieldBuilder<S, "one", Row<S>>;
  /** A list of embedded objects, stored in a JSON column. A new record starts with an empty list. */
  embedMany<S extends AnySchema>(
    schema: () => S,
    options?: EmbedOptions,
  ): EmbedFieldBuilder<S, "many", Row<S>[], WithFlag<DefaultFieldFlags, "defaulted">>;
}

/**
 * The field builder: `t.<type>()` starts a field, and modifiers chain from it. It is the
 * one place types are named, so wherever a type is needed outside a schema (a query
 * parameter, a cast expression) you pass `t.integer()` there too.
 *
 * @example
 * ```ts
 * class User extends Schema("users", {
 *   id: t.integer().primaryKey().dbGenerated(),
 *   email: t.string(),
 *   name: t.string().nullable(),
 *   passwordHash: t.string().redact().column("pw_hash"),
 * }) {}
 * ```
 *
 * @throws SchemaDefinitionError when a type or a modifier is given something it cannot use.
 */
export const t: FieldTypes = /* @__PURE__ */ Object.freeze({
  string: () => builder(stringType()),
  integer: () => builder(integerType()),
  bigint: (options?: { readonly mode?: "bigint" | "number" }) =>
    builder(own(options, "mode") === "number" ? bigintType({ mode: "number" }) : bigintType()),
  float: () => builder(floatType()),
  decimal: (options?: DecimalOptions) => builder(decimalType(options)),
  boolean: () => builder(booleanType()),
  uuid: () => builder(uuidType()),
  binary: () => builder(binaryType()),
  date: (options?: { readonly as?: "string" | "date" }) =>
    builder(own(options, "as") === "date" ? dateType({ as: "date" }) : dateType()),
  time: () => builder(timeType()),
  timestamp: (options?: TimestampOptions) => builder(timestampType(options)),
  localTimestamp: (options?: TimestampOptions) => builder(localTimestampType(options)),
  json: () => builder(jsonType()),
  array: (inner: unknown) => {
    const state = fieldState(inner);
    if (state === undefined || !isPristine(state)) {
      throw new SchemaDefinitionError(
        "schema.arrayElement",
        "t.array() takes a field type with no modifiers, such as t.array(t.string()).",
      );
    }
    return builder(arrayType(state.type));
  },
  enum: (members: readonly [string, ...string[]] | EnumMapping) =>
    builder(
      Array.isArray(members)
        ? enumType(members as readonly [string, ...string[]])
        : enumType(members as EnumMapping),
    ),
  type: (type: AnyFieldType) => {
    if (typeof type !== "object" || type === null || typeof type.cast !== "function") {
      throw new SchemaDefinitionError(
        "schema.typeNotDefined",
        "t.type() takes a type made with defineType(): t.type(MoneyType).",
      );
    }
    return builder(type);
  },
  embedOne: (schema: () => AnySchema, options?: EmbedOptions) =>
    new Builder(embed("embedOne", schema, options)),
  embedMany: (schema: () => AnySchema, options?: EmbedOptions) =>
    new Builder({
      ...embed("embedMany", schema, options),
      default: Object.freeze({ kind: "fn" as const, fn: emptyList }),
    }),
} as unknown as FieldTypes);

/**
 * Options of {@link timestamps}.
 *
 * @example
 * ```ts
 * const options: TimestampsOptions<"insertedAt", false> = { createdAt: "insertedAt", updatedAt: false };
 * ```
 */
export interface TimestampsOptions<C extends string | false, U extends string | false> {
  /** The name of the field set on insert, or `false` to leave it out. Defaults to `"createdAt"`. */
  readonly createdAt?: C;
  /** The name of the field set on insert and on every update, or `false` to leave it out. Defaults to `"updatedAt"`. */
  readonly updatedAt?: U;
  /** The type of both fields: `t.timestamp()` (the default), or another type that holds a `Date`. */
  readonly type?: FieldBuilder<Date>;
}

/**
 * The fields {@link timestamps} returns.
 *
 * @example
 * ```ts
 * type Fields = TimestampFields<"createdAt", false>; // { createdAt: FieldBuilder<Date, …> }
 * ```
 */
export type TimestampFields<C extends string | false, U extends string | false> = {
  [K in Extract<C | U, string>]: FieldBuilder<Date, WithFlag<DefaultFieldFlags, "defaulted">>;
};

/**
 * The two bookkeeping fields, to spread into a schema's fields: `createdAt` is set when
 * the record is inserted, `updatedAt` on insert and again on every update that changes
 * something.
 *
 * @example
 * ```ts
 * class Post extends Schema("posts", {
 *   id: t.integer().primaryKey().dbGenerated(),
 *   title: t.string(),
 *   ...timestamps(),                                  // createdAt, updatedAt
 * }) {}
 *
 * timestamps({ createdAt: "insertedAt" });            // rename one
 * timestamps({ updatedAt: false });                   // leave one out
 * timestamps({ type: t.timestamp({ precision: "s" }) });
 * ```
 *
 * @throws SchemaDefinitionError when a name is not a non-empty string or `false`, when
 * both fields are given the same name, or when `type` cannot hold a `Date`.
 */
export function timestamps<
  const C extends string | false = "createdAt",
  const U extends string | false = "updatedAt",
>(options?: TimestampsOptions<C, U>): TimestampFields<C, U> {
  const createdAt: unknown = own(options, "createdAt") ?? "createdAt";
  const updatedAt: unknown = own(options, "updatedAt") ?? "updatedAt";
  for (const [option, name] of [
    ["createdAt", createdAt],
    ["updatedAt", updatedAt],
  ] as const) {
    if (name !== false && (typeof name !== "string" || name === "")) {
      throw new SchemaDefinitionError(
        "schema.timestampsField",
        `timestamps(): ${option} must be a field name, or false to leave the field out.`,
      );
    }
  }
  if (createdAt === updatedAt && createdAt !== false) {
    throw new SchemaDefinitionError(
      "schema.timestampsSameName",
      `timestamps(): createdAt and updatedAt are both named "${String(createdAt)}".`,
    );
  }
  const type = own(options, "type");
  const state = type === undefined ? pristine(timestampType()) : fieldState(type);
  const now = state !== undefined && isPristine(state) ? currentTime(state.type) : undefined;
  if (state === undefined || now === undefined) {
    throw new SchemaDefinitionError(
      "schema.timestampsType",
      "timestamps(): type must be a timestamp type with no modifiers, such as t.timestamp() or t.localTimestamp().",
    );
  }
  // No prototype, so that a field named "__proto__" stays a key and `Schema()` can refuse it.
  const fields = Object.create(null) as Record<string, AnyBuilder>;
  if (createdAt !== false) {
    fields[createdAt as string] = new Builder({
      ...state,
      autogenerate: Object.freeze({ on: "insert" as const, fn: now }),
    });
  }
  if (updatedAt !== false) {
    fields[updatedAt as string] = new Builder({
      ...state,
      autogenerate: Object.freeze({ on: "insertAndUpdate" as const, fn: now }),
    });
  }
  return fields as unknown as TimestampFields<C, U>;
}
