/**
 * `toZod`: a Zod object schema derived from a schema class, so that the shape of a record
 * is written once.
 *
 * @module
 */
import type { AnyFieldType, AnySchema, EmbedMeta, FieldMeta, FieldValues, InsertShape } from "egon-orm";
import { EmbeddedSchema, meta, QueryError, t } from "egon-orm";
import { z } from "zod";
import { own } from "./own.js";

/**
 * Which shape `toZod` derives: `"row"` (every field, as in a row), `"insert"` (the
 * fields an insert takes, optional where the insert does not need them) or `"update"`
 * (every field, all optional).
 *
 * @example
 * ```ts
 * const mode: ToZodMode = "insert";
 * ```
 */
export type ToZodMode = "row" | "insert" | "update";

/**
 * The field names `toZod` can pick from in a mode: every field for `"row"` and
 * `"update"`, the fields an insert takes (no virtual fields) for `"insert"`.
 *
 * @example
 * ```ts
 * type Insertable = ToZodKeys<typeof User, "insert">; // "id" | "email" | "name" | …, not "password"
 * ```
 */
export type ToZodKeys<S extends AnySchema, M extends ToZodMode> = M extends "insert"
  ? keyof InsertShape<S> & string
  : keyof FieldValues<S> & string;

/** The optional keys of `T`: a key is optional when `T` does not require it. */
type OptionalKeys<T> = { [K in keyof T]-?: T extends Record<K, T[K]> ? never : K }[keyof T];

/** Whether a key of the mode's shape is optional. */
type IsOptional<S extends AnySchema, M extends ToZodMode, K> = M extends "update"
  ? true
  : M extends "insert"
    ? K extends OptionalKeys<InsertShape<S>>
      ? true
      : false
    : false;

/**
 * The shape of the Zod object `toZod` returns: one Zod type per field, typed with the
 * field's value, and optional (`exactOptional`) where the mode makes it optional.
 *
 * @example
 * ```ts
 * type Shape = ToZodShape<typeof User, "insert", "email" | "name">;
 * // { email: z.ZodType<string>; name: z.ZodExactOptional<z.ZodType<string | null>> }
 * ```
 */
export type ToZodShape<S extends AnySchema, M extends ToZodMode, K extends string> = {
  [P in K]: IsOptional<S, M, P> extends true
    ? z.ZodExactOptional<z.ZodType<FieldValues<S>[P & keyof FieldValues<S>]>>
    : z.ZodType<FieldValues<S>[P & keyof FieldValues<S>]>;
};

/**
 * Options of `toZod`. `pick` keeps only the named fields; `omit` leaves the named fields
 * out. Both are checked against the mode's fields.
 *
 * @example
 * ```ts
 * const options: ToZodOptions<typeof User, "insert", "email" | "name", never> = {
 *   mode: "insert",
 *   pick: ["email", "name"],
 * };
 * ```
 */
export interface ToZodOptions<S extends AnySchema, M extends ToZodMode, P extends string, O extends string> {
  readonly mode?: M;
  readonly pick?: readonly (P & ToZodKeys<S, M>)[];
  readonly omit?: readonly (O & ToZodKeys<S, M>)[];
}

/**
 * The hint a custom type gives `toZod`: the Zod schema for its values (or a function
 * that returns it). Without one, a custom type becomes a `z.custom()` check that accepts
 * exactly the values the type itself accepts.
 *
 * `defineType` keeps only the members it knows, so add the hint to the type it returns:
 *
 * @example
 * ```ts
 * const Slug = defineType<string>({ name: "slug", db: { kind: "text" }, cast: castSlug });
 * const SlugWithZod: FieldType<string, string> & ZodHint<string> = {
 *   ...Slug,
 *   zod: z.string().regex(/^[a-z0-9-]+$/),
 * };
 * class Article extends Schema("articles", { slug: t.type(SlugWithZod) }) {}
 * ```
 */
export interface ZodHint<T = unknown> {
  readonly zod: z.ZodType<T> | (() => z.ZodType<T>);
}

// ---------------------------------------------------------------------------
// Field types to Zod types
// ---------------------------------------------------------------------------

const INVALID = "is invalid";

/**
 * Whether `value` is already a value of `type`: the type casts it to an equal value of the
 * same kind (the same `typeof`, and for objects an instance of what the type produces: the
 * cast value's prototype is on the value's prototype chain, so a `Date` subclass passes).
 * The kind check matters because a type's `equal` is only defined on its own values: a
 * decimal's would call the number `12.5` equal to the string `"12.50"`.
 */
function accepts(type: AnyFieldType, value: unknown): boolean {
  if (value === null || value === undefined) return false;
  const result = type.cast(value);
  if (!result.success) return false;
  const data: unknown = result.data;
  if (data === value) return true;
  if (typeof data !== typeof value) return false;
  if (typeof value === "object" && data !== null) {
    const expected: unknown = Object.getPrototypeOf(data);
    if (expected !== null && !protoOf.call(expected, value)) return false;
  }
  return type.equal(data, value);
}

const protoOf = Object.prototype.isPrototypeOf;

function hintOf(type: AnyFieldType): z.ZodType | undefined {
  // An own property only (the hint is added to the type object, ZodHint): a `zod` planted on
  // Object.prototype is no hint, and the built-in types have none.
  const hint: unknown = own(type as Partial<ZodHint>, "zod");
  if (hint === undefined) return undefined;
  const schema: unknown = typeof hint === "function" ? (hint as () => unknown)() : hint;
  if (!(schema instanceof z.ZodType)) {
    throw new QueryError(
      "query.zodHint",
      `toZod(): the zod hint of the type "${type.name}" is not a Zod schema (or a function returning one).`,
    );
  }
  return schema;
}

/**
 * The Zod base type of each built-in type that has one, keyed by the type object itself.
 * The types are read from a schema declared here with the field builder, so they are the
 * very objects `t.string()`, `t.timestamp()`, … use: a custom type cannot be mistaken for a
 * built-in one by its name or column kind. Parameterized types (enums, arrays, decimals
 * with a precision) are not listed and get `z.custom()`.
 */
let bases: ReadonlyMap<AnyFieldType, () => z.ZodType> | undefined;
/** The built-in UUID type, whose refinement has a message of its own. */
let uuidType: AnyFieldType | undefined;

function builtInBases(): ReadonlyMap<AnyFieldType, () => z.ZodType> {
  if (bases !== undefined) return bases;
  class Probe extends EmbeddedSchema({
    string: t.string(),
    integer: t.integer(),
    bigint: t.bigint(),
    bigintNumber: t.bigint({ mode: "number" }),
    float: t.float(),
    decimal: t.decimal(),
    boolean: t.boolean(),
    uuid: t.uuid(),
    binary: t.binary(),
    date: t.date(),
    dateAsDate: t.date({ as: "date" }),
    time: t.time(),
    timestampS: t.timestamp({ precision: "s" }),
    timestampMs: t.timestamp({ precision: "ms" }),
    timestampUs: t.timestamp({ precision: "us" }),
    localTimestampS: t.localTimestamp({ precision: "s" }),
    localTimestampMs: t.localTimestamp({ precision: "ms" }),
    localTimestampUs: t.localTimestamp({ precision: "us" }),
  }) {}
  const byName = new Map(meta(Probe).fields.map((field) => [field.name, field.type]));
  const of = (name: string): AnyFieldType => byName.get(name) as AnyFieldType;
  const date = (): z.ZodType => z.date();
  const text = (): z.ZodType => z.string();
  uuidType = of("uuid");
  bases = new Map<AnyFieldType, () => z.ZodType>([
    [of("string"), text],
    [of("integer"), () => z.int()],
    [of("bigint"), () => z.bigint()],
    [of("bigintNumber"), () => z.int()],
    [of("float"), () => z.number()],
    [of("decimal"), text],
    [of("boolean"), () => z.boolean()],
    [of("uuid"), text],
    [of("binary"), () => z.instanceof(Uint8Array)],
    [of("date"), text],
    [of("dateAsDate"), date],
    [of("time"), text],
    [of("timestampS"), date],
    [of("timestampMs"), date],
    [of("timestampUs"), date],
    [of("localTimestampS"), date],
    [of("localTimestampMs"), date],
    [of("localTimestampUs"), date],
  ]);
  return bases;
}

/**
 * The Zod type of a non-null value of `type`. A built-in type gets its Zod base type (so
 * a value of the wrong kind gets Zod's own message), refined with the type's own `cast`
 * so that it accepts exactly what the type accepts (ranges, formats, precision). Any
 * other type, custom or parameterized, is `z.custom()` with that check.
 */
function valueSchema(type: AnyFieldType): z.ZodType {
  const hint = hintOf(type);
  if (hint !== undefined) return hint;
  const check = (value: unknown): boolean => accepts(type, value);
  const base = builtInBases().get(type);
  if (base === undefined) return z.custom(check, INVALID);
  return base().refine(check, type === uuidType ? "is not a valid UUID" : INVALID);
}

function embedSchema(embed: EmbedMeta): z.ZodType {
  const one = z.lazy(() => rowObject(embed.schema()));
  return embed.cardinality === "one" ? one : z.array(one);
}

function fieldSchema(field: FieldMeta, embed: EmbedMeta | undefined): z.ZodType {
  const base = embed === undefined ? valueSchema(field.type) : embedSchema(embed);
  return field.nullable ? base.nullable() : base;
}

function isOptional(field: FieldMeta, mode: ToZodMode): boolean {
  if (mode === "update") return true;
  if (mode === "row") return false;
  return (
    field.nullable || field.default !== undefined || field.autogenerate !== undefined || field.dbGenerated
  );
}

/** The fields of the mode, in declaration order. */
function fieldsFor(schema: AnySchema, mode: ToZodMode): readonly FieldMeta[] {
  const fields = meta(schema).fields;
  return mode === "insert" ? fields.filter((field) => !field.virtual) : fields;
}

function build(schema: AnySchema, mode: ToZodMode, keep: (name: string) => boolean): z.ZodObject {
  const info = meta(schema);
  const embeds = new Map(info.embeds.map((embed) => [embed.name, embed]));
  const shape: Record<string, z.ZodType> = {};
  for (const field of fieldsFor(schema, mode)) {
    if (!keep(field.name)) continue;
    const zod = fieldSchema(field, embeds.get(field.name));
    shape[field.name] = isOptional(field, mode) ? zod.exactOptional() : zod;
  }
  return z.object(shape);
}

/** The whole-row schema of a class, cached: used for embeds and for `toZod` without pick or omit. */
const cache = /* @__PURE__ */ new WeakMap<AnySchema, Map<ToZodMode, z.ZodObject>>();

function cached(schema: AnySchema, mode: ToZodMode): z.ZodObject {
  let byMode = cache.get(schema);
  if (byMode === undefined) {
    byMode = new Map();
    cache.set(schema, byMode);
  }
  let object = byMode.get(mode);
  if (object === undefined) {
    object = build(schema, mode, () => true);
    byMode.set(mode, object);
  }
  return object;
}

function rowObject(schema: AnySchema): z.ZodObject {
  return cached(schema, "row");
}

function namesOf(list: unknown, option: string, allowed: ReadonlySet<string>): ReadonlySet<string> {
  if (!Array.isArray(list))
    throw new QueryError("query.zodFieldList", `toZod(): ${option} must be a list of field names.`);
  for (const name of list) {
    if (typeof name !== "string" || !allowed.has(name)) {
      throw new QueryError(
        "query.zodUnknownField",
        `toZod(): ${option} names ${typeof name === "string" ? `"${name}"` : String(name)}, which is not one of the fields: ${[...allowed].join(", ")}.`,
      );
    }
  }
  return new Set(list as readonly string[]);
}

/**
 * Derives a Zod object schema from a schema class: one key per field, with the field's
 * type and nullability, so the shape is written once. Virtual and redacted fields are
 * included in `"row"` mode; `"insert"` leaves virtual fields out and makes a field
 * optional where an insert does not need it; `"update"` makes every field optional.
 *
 * The result is an ordinary Zod object: `.extend()` it to add rules
 * (`z.string().email()`), and pass it to `cs.validate()`.
 *
 * @example
 * ```ts
 * const UserZ = toZod(User); // matches the fields of a User row
 * const CreateUser = toZod(User, { mode: "insert", pick: ["email", "name", "age"] })
 *   .extend({ email: z.string().email() });
 * type CreateUser = z.infer<typeof CreateUser>; // { email: string; name?: string | null; age?: number | null }
 * ```
 *
 * @throws QueryError when `schema` is not a schema class, `mode` is unknown, or `pick` or
 * `omit` names something that is not a field of the mode.
 */
export function toZod<
  S extends AnySchema,
  M extends ToZodMode = "row",
  const P extends string = ToZodKeys<S, M>,
  const O extends string = never,
>(
  schema: S,
  options?: ToZodOptions<S, M, P, O>,
): z.ZodObject<ToZodShape<S, M, Exclude<P & ToZodKeys<S, M>, O>>> {
  const mode: unknown = own(options, "mode") ?? "row";
  if (mode !== "row" && mode !== "insert" && mode !== "update") {
    throw new QueryError("query.zodMode", 'toZod(): mode must be "row", "insert" or "update".');
  }
  const pick = own(options, "pick");
  const omit = own(options, "omit");
  if (pick === undefined && omit === undefined) {
    return cached(schema, mode) as unknown as z.ZodObject<ToZodShape<S, M, Exclude<P & ToZodKeys<S, M>, O>>>;
  }
  const allowed = new Set(fieldsFor(schema, mode).map((field) => field.name));
  const picked = pick === undefined ? undefined : namesOf(pick, "pick", allowed);
  const omitted = omit === undefined ? undefined : namesOf(omit, "omit", allowed);
  return build(
    schema,
    mode,
    (name) => (picked === undefined || picked.has(name)) && (omitted === undefined || !omitted.has(name)),
  ) as unknown as z.ZodObject<ToZodShape<S, M, Exclude<P & ToZodKeys<S, M>, O>>>;
}
