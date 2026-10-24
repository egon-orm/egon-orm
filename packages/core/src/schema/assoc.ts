/**
 * Associations: the four declaration functions, and the code that turns what they were
 * given into `AssocMeta` the first time a schema's associations are asked for.
 *
 * A declaration only records its arguments. Nothing is checked when a class is defined,
 * because the class an association points at may not exist yet (decision D1).
 *
 * @module
 */
import type {
  AnySchema,
  Assoc,
  AssocKind,
  AssocMeta,
  AssocOrderMeta,
  FieldMeta,
  FieldNames,
  JoinKeyMeta,
  JoinThroughMeta,
  OnReplace,
  SchemaMeta,
} from "../contracts/schema.js";
import { type ErrorDetails, type ErrorParams, type IdsOf, SchemaDefinitionError } from "../errors.js";
import { frozenOptions, own } from "../internal/own.js";
import { isPlainObject } from "../internal/plain-object.js";
import { definedOnPrototype, describe, isSchema } from "./guards.js";

/**
 * A field name, or several for a composite key.
 *
 * @example
 * ```ts
 * const single: KeyFields<"authorId" | "orgId"> = "authorId";
 * const composite: KeyFields<"authorId" | "orgId"> = ["orgId", "authorId"];
 * ```
 */
export type KeyFields<N extends string = string> = N | readonly [N, ...N[]];

/**
 * A condition that an association always applies to its target: field name to value. A
 * value means equality, `null` means `IS NULL`, an array means `IN`.
 *
 * @example
 * ```ts
 * const published: AssocWhere<typeof Post> = { published: true };
 * ```
 */
export type AssocWhere<T> = { readonly [K in FieldNames<T>]?: unknown };

/**
 * The default order of an association's rows: field names (ascending), or objects from
 * field name to direction.
 *
 * @example
 * ```ts
 * const newestFirst: AssocOrderBy<typeof Post> = [{ createdAt: "desc" }, "id"];
 * ```
 */
export type AssocOrderBy<T> = readonly (FieldNames<T> | { readonly [K in FieldNames<T>]?: "asc" | "desc" })[];

/**
 * Options of {@link belongsTo}.
 *
 * @example
 * ```ts
 * const options: BelongsToOptions<typeof User> = { foreignKey: "authorId", references: "id" };
 * ```
 */
export interface BelongsToOptions<T> {
  /** The field on this schema that holds the key. Defaults to the property name plus `Id`. */
  readonly foreignKey?: KeyFields | undefined;
  /** The field on the target that the key points at. Defaults to the target's primary key. */
  readonly references?: KeyFields<FieldNames<T>>;
  /** What a nested write does with a parent that is replaced. Defaults to `"error"`. */
  readonly onReplace?: OnReplace;
}

/**
 * Options of {@link hasOne}.
 *
 * @example
 * ```ts
 * const options: HasOneOptions<typeof Profile, "userId"> = { foreignKey: "userId" };
 * ```
 */
export interface HasOneOptions<T, FK> {
  /** The field on the target that points back at this schema. */
  readonly foreignKey: FK;
  /** The field on this schema that the key points at. Defaults to the primary key. */
  readonly references?: KeyFields;
  /** A condition always applied when joining or preloading. */
  readonly where?: AssocWhere<T>;
  /** What a nested write does with children that were left out. Defaults to `"error"`. */
  readonly onReplace?: OnReplace;
}

/**
 * Options of {@link hasMany}.
 *
 * @example
 * ```ts
 * const options: HasManyOptions<typeof Post, "authorId"> = { foreignKey: "authorId", orderBy: ["createdAt"] };
 * ```
 */
export interface HasManyOptions<T, FK> extends HasOneOptions<T, FK> {
  /** The order of preloaded rows when the preload gives none. */
  readonly orderBy?: AssocOrderBy<T>;
}

/**
 * Options of a {@link hasOne} or {@link hasMany} that follows a chain of other associations.
 *
 * @example
 * ```ts
 * const options: ThroughOptions = { through: ["posts", "comments"] };
 * ```
 */
export interface ThroughOptions {
  /** The association names to follow, starting from this schema. Read-only. */
  readonly through: readonly [string, string, ...string[]];
}

/**
 * The two sides of a join table: `owner` points at the schema that declares the
 * association, `target` at the other one.
 *
 * @example
 * ```ts
 * const keys: JoinKeys = { owner: "post_id", target: "tag_id" };
 * ```
 */
export interface JoinKeys<N extends string = string> {
  readonly owner: N;
  readonly target: N;
}

interface ManyToManyCommon<T> {
  /** A condition on the target, always applied. */
  readonly where?: AssocWhere<T>;
  /** The order of preloaded rows when the preload gives none. */
  readonly orderBy?: AssocOrderBy<T>;
  /** What a nested write does with links that were left out. Defaults to `"error"`. */
  readonly onReplace?: Extract<OnReplace, "error" | "invalid" | "delete">;
  /** Whether a pair of rows may be linked only once. Defaults to `false`. */
  readonly unique?: boolean;
}

/**
 * Options of {@link manyToMany} when the join table is given by name. `joinKeys` holds the
 * join table's **column** names and is required.
 *
 * @example
 * ```ts
 * const options: ManyToManyTableOptions<typeof Tag> = {
 *   joinThrough: "posts_tags",
 *   joinKeys: { owner: "post_id", target: "tag_id" },
 * };
 * ```
 */
export interface ManyToManyTableOptions<T> extends ManyToManyCommon<T> {
  /** The join table. */
  readonly joinThrough: string;
  /** The join table's columns. */
  readonly joinKeys: JoinKeys;
  /** A condition on the join table's columns, always applied. */
  readonly joinWhere?: Readonly<Record<string, unknown>>;
}

/**
 * Options of {@link manyToMany} when the join table has a schema class of its own.
 * `joinKeys` then holds that schema's **field** names, and may be left out when the join
 * schema declares a `belongsTo` to each side.
 *
 * @example
 * ```ts
 * const options: ManyToManySchemaOptions<typeof Org, typeof Membership> = {
 *   joinThrough: () => Membership,
 *   joinKeys: { owner: "userId", target: "orgId" },
 * };
 * ```
 */
export interface ManyToManySchemaOptions<T, J> extends ManyToManyCommon<T> {
  /** A function returning the join schema class. */
  readonly joinThrough: () => J;
  /** The join schema's fields. */
  readonly joinKeys?: JoinKeys<FieldNames<J>>;
  /** A condition on the join schema's fields, always applied. */
  readonly joinWhere?: AssocWhere<J>;
}

/** The key under which a declaration holds the options it was given. */
const ASSOC: unique symbol = /* @__PURE__ */ Symbol.for("egon.assoc");

interface Declaration {
  readonly kind: AssocKind;
  readonly target: unknown;
  readonly [ASSOC]: unknown;
}

function declare<K extends AssocKind, T, FK extends string | readonly string[] | undefined>(
  kind: K,
  target: () => T,
  options: unknown,
): Assoc<K, T, FK> {
  const declaration: Declaration = { kind, target, [ASSOC]: options };
  return Object.freeze(declaration) as unknown as Assoc<K, T, FK>;
}

/**
 * Declares that this schema holds a foreign key to `target`. The foreign key is an
 * ordinary field that you declare yourself; by default it is the property name plus `Id`.
 *
 * Preloaded, it is the target's row, or `| null` when the foreign-key field is nullable.
 *
 * @example
 * ```ts
 * class Post extends Schema("posts", {
 *   id: t.integer().primaryKey().dbGenerated(),
 *   authorId: t.integer(),
 * }) {
 *   static author = belongsTo(() => User);                          // foreign key: authorId
 *   static editor = belongsTo(() => User, { foreignKey: "authorId" });
 * }
 * ```
 */
export function belongsTo<T>(
  target: () => T,
  options?: BelongsToOptions<T> & { readonly foreignKey?: undefined },
): Assoc<"belongsTo", T, undefined>;
export function belongsTo<T, const FK extends KeyFields>(
  target: () => T,
  options: BelongsToOptions<T> & { readonly foreignKey: FK },
): Assoc<"belongsTo", T, FK>;
export function belongsTo<T>(target: () => T, options?: unknown): Assoc<"belongsTo", T> {
  return declare("belongsTo", target, options);
}

/**
 * Declares that at most one row of `target` points at this schema. `foreignKey` names the
 * field on the target and is required.
 *
 * Preloaded, it is the target's row or `null`.
 *
 * @example
 * ```ts
 * class User extends Schema("users", { id: t.integer().primaryKey().dbGenerated() }) {
 *   static profile = hasOne(() => Profile, { foreignKey: "userId" });
 * }
 * ```
 */
export function hasOne<T, const FK extends KeyFields<FieldNames<T>>>(
  target: () => T,
  options: HasOneOptions<T, FK>,
): Assoc<"hasOne", T, FK>;
export function hasOne<T>(target: () => T, options: ThroughOptions): Assoc<"hasOne", T, undefined>;
export function hasOne<T>(target: () => T, options: unknown): Assoc<"hasOne", T> {
  return declare("hasOne", target, options);
}

/**
 * Declares that any number of rows of `target` point at this schema. `foreignKey` names
 * the field on the target and is required.
 *
 * With `through`, the rows are reached by following other associations instead; such an
 * association can be joined and preloaded, but not written through.
 *
 * Preloaded, it is an array of the target's rows.
 *
 * @example
 * ```ts
 * class User extends Schema("users", { id: t.integer().primaryKey().dbGenerated() }) {
 *   static posts = hasMany(() => Post, { foreignKey: "authorId", orderBy: ["createdAt"] });
 *   static comments = hasMany(() => Comment, { through: ["posts", "comments"] });
 * }
 * ```
 */
export function hasMany<T, const FK extends KeyFields<FieldNames<T>>>(
  target: () => T,
  options: HasManyOptions<T, FK>,
): Assoc<"hasMany", T, FK>;
export function hasMany<T>(target: () => T, options: ThroughOptions): Assoc<"hasMany", T, undefined>;
export function hasMany<T>(target: () => T, options: unknown): Assoc<"hasMany", T> {
  return declare("hasMany", target, options);
}

/**
 * Declares that rows of `target` are linked to this schema through a join table.
 *
 * Give the join table by name, with `joinKeys` holding its two column names, or give a
 * function returning a join schema class.
 *
 * Preloaded, it is an array of the target's rows.
 *
 * @example
 * ```ts
 * class Post extends Schema("posts", { id: t.integer().primaryKey().dbGenerated() }) {
 *   static tags = manyToMany(() => Tag, {
 *     joinThrough: "posts_tags",
 *     joinKeys: { owner: "post_id", target: "tag_id" },
 *   });
 * }
 * ```
 */
export function manyToMany<T>(
  target: () => T,
  options: ManyToManyTableOptions<T>,
): Assoc<"manyToMany", T, undefined>;
export function manyToMany<T, J>(
  target: () => T,
  options: ManyToManySchemaOptions<T, J>,
): Assoc<"manyToMany", T, undefined>;
export function manyToMany<T>(target: () => T, options: unknown): Assoc<"manyToMany", T> {
  return declare("manyToMany", target, options);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * What `SchemaMeta.assocs()` holds. It is the `AssocMeta` contract plus `unique`, which a
 * `manyToMany` declares and the contract has no member for.
 *
 * @example
 * ```ts
 * const tags = meta(Post).assocs().get("tags") as ResolvedAssoc;
 * tags.unique; // false
 * ```
 */
export interface ResolvedAssoc extends AssocMeta {
  /** `manyToMany` only: whether a pair of rows may be linked only once. */
  readonly unique: boolean;
}

/**
 * Names that a row cannot have as a property: they would hide what the prototype
 * provides, or change the object's prototype. They are refused for fields and for
 * associations alike (a preloaded association is a property of the row).
 *
 * @example
 * ```ts
 * reservedName("toJSON"); // true
 * reservedName("$from"); // true
 * reservedName("title"); // false
 * ```
 */
export function reservedName(name: string): boolean {
  return name === "constructor" || name === "__proto__" || name === "toJSON" || name.startsWith("$");
}

const OPTIONS: Readonly<Record<AssocKind, readonly string[]>> = {
  belongsTo: ["foreignKey", "references", "onReplace"],
  hasOne: ["foreignKey", "references", "where", "onReplace", "through"],
  hasMany: ["foreignKey", "references", "where", "orderBy", "onReplace", "through"],
  manyToMany: ["joinThrough", "joinKeys", "where", "joinWhere", "orderBy", "onReplace", "unique"],
};

const ON_REPLACE: Readonly<Record<AssocKind, readonly OnReplace[]>> = {
  belongsTo: ["error", "invalid", "setNull", "update", "delete", "deleteIfExists"],
  hasOne: ["error", "invalid", "setNull", "update", "delete", "deleteIfExists"],
  hasMany: ["error", "invalid", "setNull", "delete", "deleteIfExists"],
  manyToMany: ["error", "invalid", "delete"],
};

const NO_KEYS: readonly string[] = /* @__PURE__ */ Object.freeze([]);
const NO_ORDER: readonly AssocOrderMeta[] = /* @__PURE__ */ Object.freeze([]);

const quoted = (names: readonly string[]): string => names.map((name) => `"${name}"`).join(", ");

/** Everything the resolution of one association needs to know about where it stands. */
interface Context {
  /** `"User.posts"`, the start of every message. */
  readonly label: string;
  readonly name: string;
  readonly kind: AssocKind;
  readonly owner: AnySchema;
  readonly ownerMeta: SchemaMeta;
  readonly options: Readonly<Record<string, unknown>>;
  readonly metaOf: (schema: AnySchema) => SchemaMeta;
}

function fail(context: Context, id: IdsOf<"schema">, problem: string, details?: ErrorDetails): never {
  throw new SchemaDefinitionError(id, `${context.label}: ${problem}`, details);
}

/** The association declarations of a class and of the classes it extends, nearest first winning. */
function declarations(model: AnySchema): [string, Declaration][] {
  const levels: [string, Declaration][][] = [];
  const seen = new Set<string>();
  for (
    let current: unknown = model;
    typeof current === "function" && current !== Function.prototype;
    current = Object.getPrototypeOf(current)
  ) {
    const level: [string, Declaration][] = [];
    for (const name of Object.getOwnPropertyNames(current)) {
      if (seen.has(name)) continue;
      seen.add(name);
      // Read as data: a static getter is not an association and is not run.
      const value: unknown = Object.getOwnPropertyDescriptor(current, name)?.value;
      if (typeof value === "object" && value !== null && ASSOC in value) {
        level.push([name, value as Declaration]);
      }
    }
    levels.push(level);
  }
  // An ancestor's associations come first, each level in the order it was written.
  return levels.reverse().flat();
}

/** The options of an association declared without any: no prototype, so nothing is inherited. */
const NO_OPTIONS: Readonly<Record<string, unknown>> = /* @__PURE__ */ frozenOptions({});

function optionsOf(context: Omit<Context, "options">, declaration: Declaration): Context {
  const raw = declaration[ASSOC] ?? NO_OPTIONS;
  const full = context as Context;
  if (typeof raw !== "object" || !isPlainObject(raw)) {
    fail(
      full,
      "schema.assocOptionsNotObject",
      `the options of ${context.kind} must be an object, but got ${describe(raw)}.`,
    );
  }
  const allowed = OPTIONS[context.kind];
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      fail(
        full,
        "schema.assocUnknownOption",
        `${context.kind} has no option "${key}". It takes ${allowed.join(", ")}.`,
      );
    }
  }
  return { ...context, options: raw as Readonly<Record<string, unknown>> };
}

function targetOf(context: Context, thunk: unknown, role = "target"): [AnySchema, SchemaMeta] {
  const example = role === "join schema" ? "joinThrough: () => PostTag" : `${context.kind}(() => Post)`;
  if (typeof thunk !== "function" || isSchema(thunk)) {
    fail(
      context,
      "schema.assocTargetThunk",
      `the ${role} must be given as a function that returns the class.`,
      { params: { example } },
    );
  }
  let target: unknown;
  try {
    target = (thunk as () => unknown)();
  } catch (cause) {
    fail(
      context,
      "schema.assocTargetThrew",
      `the function for the ${role} threw (${cause instanceof Error ? cause.message : describe(cause)}).`,
      { cause },
    );
  }
  if (!isSchema(target)) {
    fail(
      context,
      "schema.assocTargetNotSchema",
      `the function for the ${role} returned ${describe(target)}, not a schema class.`,
    );
  }
  const targetMeta = context.metaOf(target);
  if (targetMeta.source === null) {
    fail(
      context,
      "schema.assocTargetEmbedded",
      `${targetMeta.name} is an embedded schema and has no table, so it cannot be the ${role} of an association.`,
      { params: { name: targetMeta.name } },
    );
  }
  return [target, targetMeta];
}

function keyNames(context: Context, option: string, value: unknown): readonly string[] {
  const names = typeof value === "string" ? [value] : value;
  if (
    !Array.isArray(names) ||
    names.length === 0 ||
    names.some((name) => typeof name !== "string" || name === "")
  ) {
    fail(
      context,
      "schema.assocKeyOption",
      `${option} must be a field name, or an array of field names for a composite key.`,
    );
  }
  return Object.freeze([...(names as string[])]);
}

/** What a missing field is reported as: one identifier per role, and the values its advice names. */
interface Missing {
  readonly id: IdsOf<"schema">;
  readonly params?: ErrorParams;
}

/** A stored field of `meta` by name. `role` names it in the message; `missing` is the error when there is none. */
function storedField(
  context: Context,
  meta: SchemaMeta,
  name: string,
  role: string,
  missing: Missing,
): FieldMeta {
  const field = meta.fieldsByName.get(name);
  if (field === undefined) {
    fail(
      context,
      missing.id,
      `${context.kind} expects the ${role} field "${name}" on ${meta.name}, but ${meta.name} has no such field.`,
      { params: { field: name, ...missing.params } },
    );
  }
  if (field.virtual) {
    fail(
      context,
      "schema.assocFieldVirtual",
      `the ${role} field "${name}" of ${meta.name} is virtual, so it is not stored and cannot be part of an association.`,
    );
  }
  return field;
}

function primaryKeyOf(context: Context, meta: SchemaMeta, option: string): readonly string[] {
  if (meta.primaryKey.length === 0) {
    fail(
      context,
      "schema.assocNoPrimaryKey",
      `${meta.name} has no primary key, so the field the key points at cannot be guessed.`,
      { params: { option } },
    );
  }
  return Object.freeze(meta.primaryKey.map((field) => field.name));
}

/**
 * How a key's value looks in JavaScript and in the database. Two key fields can be
 * matched when these are equal: `integer` and `bigint({ mode: "number" })` are both
 * numbers, while a `bigint` field never equals a number.
 */
function keyShape(field: FieldMeta): string {
  const { name, db } = field.type;
  if (name === "integer" || name === "bigint(number)") return "a whole number";
  if (db.kind === "custom") return `custom:${db.sql}`;
  return db.kind === "bigint" ? name : db.kind;
}

function checkPairs(
  context: Context,
  holderMeta: SchemaMeta,
  foreignKey: readonly string[],
  referencedMeta: SchemaMeta,
  references: readonly string[],
  foreignKeyMissing: Missing,
): void {
  if (foreignKey.length !== references.length) {
    fail(
      context,
      "schema.assocKeyCount",
      `the foreign key has ${foreignKey.length} field(s) (${quoted(foreignKey)}) but it points at ${references.length} (${quoted(references)} on ${referencedMeta.name}).`,
    );
  }
  for (let i = 0; i < foreignKey.length; i++) {
    const key = storedField(context, holderMeta, foreignKey[i] as string, "foreign key", foreignKeyMissing);
    const referenced = storedField(context, referencedMeta, references[i] as string, "referenced", {
      id: "schema.referencedFieldMissing",
    });
    if (keyShape(key) !== keyShape(referenced)) {
      fail(
        context,
        "schema.assocKeyType",
        `the foreign key ${holderMeta.name}.${key.name} is of type ${key.type.name}, but ${referencedMeta.name}.${referenced.name}, which it points at, is of type ${referenced.type.name}.`,
      );
    }
  }
}

function onReplaceOf(context: Context): OnReplace {
  const value = own(context.options, "onReplace") ?? "error";
  const allowed = ON_REPLACE[context.kind];
  if (!allowed.includes(value as OnReplace)) {
    fail(
      context,
      "schema.assocOnReplace",
      `onReplace must be one of ${quoted(allowed)} for ${context.kind}.`,
    );
  }
  return value as OnReplace;
}

/** Checks a `where`-style filter and returns a frozen copy keyed by `rename(key)`. */
function filterOf(
  context: Context,
  option: string,
  rename: (key: string) => string,
): Readonly<Record<string, unknown>> | undefined {
  const value = own(context.options, option);
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || !isPlainObject(value)) {
    fail(context, "schema.assocWhereOption", `${option} must be an object from name to value.`);
  }
  const filter: Record<string, unknown> = {};
  for (const [key, expected] of Object.entries(value)) {
    if (expected === undefined) {
      fail(context, "schema.assocWhereUndefined", `${option}.${key} is undefined.`);
    }
    filter[rename(key)] = expected;
  }
  return Object.freeze(filter);
}

function whereOf(context: Context, targetMeta: SchemaMeta): Readonly<Record<string, unknown>> | undefined {
  return filterOf(
    context,
    "where",
    (key) => storedField(context, targetMeta, key, "where", { id: "schema.assocWhereFieldMissing" }).name,
  );
}

function orderOf(context: Context, targetMeta: SchemaMeta): readonly AssocOrderMeta[] {
  const value = own(context.options, "orderBy");
  if (value === undefined) return NO_ORDER;
  const problem = 'orderBy must be an array of field names or { field: "asc" | "desc" } objects.';
  if (!Array.isArray(value)) fail(context, "schema.assocOrderBy", problem);
  const order: AssocOrderMeta[] = [];
  const add = (field: unknown, direction: unknown): void => {
    if (typeof field !== "string" || (direction !== "asc" && direction !== "desc"))
      fail(context, "schema.assocOrderBy", problem);
    storedField(context, targetMeta, field, "orderBy", { id: "schema.assocOrderByFieldMissing" });
    order.push(Object.freeze({ field, direction }));
  };
  for (const entry of value as unknown[]) {
    if (typeof entry === "object" && entry !== null && isPlainObject(entry)) {
      for (const [field, direction] of Object.entries(entry)) add(field, direction);
    } else {
      add(entry, "asc");
    }
  }
  return Object.freeze(order);
}

interface Parts {
  readonly target: () => AnySchema;
  readonly ownerKey: readonly string[];
  readonly relatedKey: readonly string[];
  readonly joinThrough?: JoinThroughMeta;
  readonly joinKeys?: readonly [JoinKeyMeta, JoinKeyMeta];
  readonly through?: readonly string[];
  readonly onReplace: OnReplace;
  readonly where?: Readonly<Record<string, unknown>> | undefined;
  readonly joinWhere?: Readonly<Record<string, unknown>> | undefined;
  readonly orderBy?: readonly AssocOrderMeta[];
  readonly unique?: boolean;
}

/** Every association has the same members in the same order, whatever its kind. */
function assocMeta(context: Context, parts: Parts): ResolvedAssoc {
  return Object.freeze({
    name: context.name,
    kind: context.kind,
    owner: context.owner,
    target: parts.target,
    ownerKey: parts.ownerKey,
    relatedKey: parts.relatedKey,
    joinThrough: parts.joinThrough,
    joinKeys: parts.joinKeys,
    through: parts.through,
    onReplace: parts.onReplace,
    where: parts.where,
    joinWhere: parts.joinWhere,
    orderBy: parts.orderBy ?? NO_ORDER,
    defaults: undefined,
    unique: parts.unique ?? false,
  });
}

function resolveBelongsTo(context: Context, declaration: Declaration): ResolvedAssoc {
  const [, targetMeta] = targetOf(context, declaration.target);
  const { options, ownerMeta, name } = context;
  const foreignKey = keyNames(context, "foreignKey", own(options, "foreignKey") ?? `${name}Id`);
  const given = own(options, "references");
  const references =
    given === undefined
      ? primaryKeyOf(context, targetMeta, "references")
      : keyNames(context, "references", given);
  checkPairs(context, ownerMeta, foreignKey, targetMeta, references, { id: "schema.belongsToKeyMissing" });
  return assocMeta(context, {
    target: declaration.target as () => AnySchema,
    ownerKey: foreignKey,
    relatedKey: references,
    onReplace: onReplaceOf(context),
  });
}

function resolveHas(context: Context, declaration: Declaration): ResolvedAssoc {
  const [, targetMeta] = targetOf(context, declaration.target);
  const { options, ownerMeta, kind } = context;
  const foreignKeyOption = own(options, "foreignKey");
  if (foreignKeyOption === undefined) {
    fail(
      context,
      "schema.foreignKeyRequired",
      `${kind} needs { foreignKey }: the field on ${targetMeta.name} that points at ${ownerMeta.name}.`,
      { params: { kind, target: targetMeta.name } },
    );
  }
  const foreignKey = keyNames(context, "foreignKey", foreignKeyOption);
  const given = own(options, "references");
  const references =
    given === undefined
      ? primaryKeyOf(context, ownerMeta, "references")
      : keyNames(context, "references", given);
  checkPairs(context, targetMeta, foreignKey, ownerMeta, references, {
    id: "schema.hasKeyMissing",
    params: { target: targetMeta.name },
  });
  return assocMeta(context, {
    target: declaration.target as () => AnySchema,
    ownerKey: references,
    relatedKey: foreignKey,
    onReplace: onReplaceOf(context),
    where: whereOf(context, targetMeta),
    orderBy: orderOf(context, targetMeta),
  });
}

/** The single key field of one side of a many-to-many. */
function singleKey(context: Context, meta: SchemaMeta): FieldMeta {
  const [key, ...rest] = meta.primaryKey;
  if (key === undefined || rest.length > 0) {
    fail(
      context,
      "schema.manyToManyCompositeKey",
      `manyToMany needs ${meta.name} to have a primary key of exactly one field, because a join table holds one column for each side. ${meta.name} has ${meta.primaryKey.length}.`,
    );
  }
  return key;
}

function joinKeyNames(context: Context, unit: string): { owner: string; target: string } | undefined {
  const value = own(context.options, "joinKeys");
  if (value === undefined) return undefined;
  const keys = value as { readonly owner?: unknown; readonly target?: unknown } | null;
  const owner = typeof keys === "object" ? own(keys, "owner") : undefined;
  const target = typeof keys === "object" ? own(keys, "target") : undefined;
  if (typeof owner !== "string" || typeof target !== "string" || owner === "" || target === "") {
    fail(
      context,
      "schema.joinKeysOption",
      `joinKeys must be { owner, target }, each the name of a ${unit} of the join table.`,
      { params: { unit } },
    );
  }
  if (owner === target) {
    fail(context, "schema.joinKeysSame", `joinKeys.owner and joinKeys.target are both "${owner}".`, {
      params: { unit },
    });
  }
  return { owner, target };
}

/** The join schema's `belongsTo` that points at `side`, when there is exactly one. */
function joinFieldTo(context: Context, joinMeta: SchemaMeta, side: AnySchema, sideMeta: SchemaMeta): string {
  const found: AssocMeta[] = [];
  for (const assoc of joinMeta.assocs().values()) {
    if (assoc.kind === "belongsTo" && assoc.target() === side) found.push(assoc);
  }
  const [only, ...rest] = found;
  if (only === undefined || rest.length > 0 || only.ownerKey.length !== 1) {
    fail(
      context,
      "schema.joinKeysAmbiguous",
      `the join keys cannot be worked out: ${joinMeta.name} declares ${found.length} belongsTo association(s) to ${sideMeta.name} and exactly one, with a single foreign key, is needed.`,
      { params: { name: joinMeta.name } },
    );
  }
  return only.ownerKey[0] as string;
}

function resolveManyToMany(context: Context, declaration: Declaration): ResolvedAssoc {
  const [target, targetMeta] = targetOf(context, declaration.target);
  const { options, owner, ownerMeta } = context;
  const ownerKey = singleKey(context, ownerMeta);
  const targetKey = singleKey(context, targetMeta);
  const through = own(options, "joinThrough");

  let joinThrough: JoinThroughMeta;
  let ownerColumn: string;
  let targetColumn: string;
  let joinWhere: Readonly<Record<string, unknown>> | undefined;
  if (typeof through === "string") {
    if (through === "") fail(context, "schema.joinThroughEmpty", "joinThrough is an empty string.");
    const keys = joinKeyNames(context, "column");
    if (keys === undefined) {
      fail(
        context,
        "schema.joinKeysRequired",
        `manyToMany through the table "${through}" needs joinKeys with that table's column names.`,
        { params: { through, owner: ownerMeta.name, target: targetMeta.name } },
      );
    }
    joinThrough = Object.freeze({ source: through, schema: undefined, model: undefined });
    ownerColumn = keys.owner;
    targetColumn = keys.target;
    joinWhere = filterOf(context, "joinWhere", (column) => column);
  } else if (through === undefined) {
    fail(
      context,
      "schema.joinThroughRequired",
      "manyToMany needs { joinThrough }: the name of the join table (with joinKeys), or a function returning its schema class.",
    );
  } else {
    const [, joinMeta] = targetOf(context, through, "join schema");
    const keys = joinKeyNames(context, "field");
    if (keys === undefined && owner === target) {
      fail(
        context,
        "schema.joinKeysSelf",
        `${ownerMeta.name} is on both sides of this manyToMany, so the join keys cannot be told apart.`,
        { params: { name: joinMeta.name } },
      );
    }
    const fix: Missing = { id: "schema.joinKeyFieldMissing", params: { join: joinMeta.name } };
    const ownerField = storedField(
      context,
      joinMeta,
      keys?.owner ?? joinFieldTo(context, joinMeta, owner, ownerMeta),
      "join key",
      fix,
    );
    const targetField = storedField(
      context,
      joinMeta,
      keys?.target ?? joinFieldTo(context, joinMeta, target, targetMeta),
      "join key",
      fix,
    );
    for (const [joinField, key, side] of [
      [ownerField, ownerKey, ownerMeta],
      [targetField, targetKey, targetMeta],
    ] as const) {
      if (keyShape(joinField) !== keyShape(key)) {
        fail(
          context,
          "schema.joinKeyType",
          `the join key ${joinMeta.name}.${joinField.name} is of type ${joinField.type.name}, but ${side.name}.${key.name}, which it points at, is of type ${key.type.name}.`,
        );
      }
    }
    joinThrough = Object.freeze({
      source: joinMeta.source as string,
      schema: joinMeta.schema,
      model: through as () => AnySchema,
    });
    ownerColumn = ownerField.column;
    targetColumn = targetField.column;
    joinWhere = filterOf(
      context,
      "joinWhere",
      (key) =>
        storedField(context, joinMeta, key, "joinWhere", {
          id: "schema.joinWhereFieldMissing",
          params: { join: joinMeta.name },
        }).column,
    );
  }

  const unique = own(options, "unique") ?? false;
  if (typeof unique !== "boolean") fail(context, "schema.uniqueOption", "unique must be true or false.");
  return assocMeta(context, {
    target: declaration.target as () => AnySchema,
    ownerKey: Object.freeze([ownerKey.name]),
    relatedKey: Object.freeze([targetKey.name]),
    joinThrough,
    joinKeys: Object.freeze([
      Object.freeze({ column: ownerColumn, field: ownerKey.name }),
      Object.freeze({ column: targetColumn, field: targetKey.name }),
    ]) as readonly [JoinKeyMeta, JoinKeyMeta],
    onReplace: onReplaceOf(context),
    where: whereOf(context, targetMeta),
    joinWhere,
    orderBy: orderOf(context, targetMeta),
    unique,
  });
}

function resolveThrough(context: Context, declaration: Declaration): ResolvedAssoc {
  targetOf(context, declaration.target);
  const { options, kind } = context;
  const others = Object.keys(options).filter((key) => key !== "through");
  if (others.length > 0) {
    fail(context, "schema.throughCombined", `through cannot be combined with ${others.join(", ")}.`);
  }
  const path = own(options, "through");
  if (
    !Array.isArray(path) ||
    path.length < 2 ||
    path.some((step) => typeof step !== "string" || step === "")
  ) {
    fail(
      context,
      "schema.throughPath",
      "through must be an array of at least two association names to follow.",
      { params: { kind } },
    );
  }
  return assocMeta(context, {
    target: declaration.target as () => AnySchema,
    ownerKey: NO_KEYS,
    relatedKey: NO_KEYS,
    through: Object.freeze([...(path as string[])]),
    onReplace: "error",
  });
}

/**
 * Follows a has-through path and checks that it ends at the declared target. It reads the
 * declarations of the schemas on the path, not their resolved associations: those may be
 * in the middle of being resolved, and their own resolution reports their own mistakes.
 */
function checkPath(context: Context, assoc: ResolvedAssoc, path: readonly string[]): void {
  let current = context.owner;
  let currentMeta = context.ownerMeta;
  for (const step of path) {
    const declared = declarations(current);
    // An association cannot be reached through itself.
    const itself = current === context.owner && step === context.name;
    const next = itself ? undefined : declared.find(([name]) => name === step)?.[1];
    if (next === undefined) {
      const known = declared
        .map(([name]) => name)
        .filter((name) => current !== context.owner || name !== context.name);
      fail(
        context,
        "schema.throughUnknownStep",
        `through follows "${step}" on ${currentMeta.name}, but ${currentMeta.name} has no such association. It has: ${known.length === 0 ? "none" : known.join(", ")}.`,
      );
    }
    [current, currentMeta] = targetOf(context, next.target, `target of ${currentMeta.name}.${step}`);
  }
  const target = assoc.target();
  if (current !== target) {
    fail(
      context,
      "schema.throughWrongTarget",
      `through [${quoted(path)}] ends at ${currentMeta.name}, but the association is declared with ${context.metaOf(target).name} as its target.`,
    );
  }
}

/**
 * Resolves and validates every association that `owner` declares.
 *
 * `publish` is called once, before anything is resolved, with the map that is being
 * filled. A schema whose own resolution asks for this schema's associations in the
 * meantime (two schemas with has-through associations across each other, a join schema
 * that points back) is given that map instead of starting over.
 *
 * @example
 * ```ts
 * const assocs = resolveAssocs(User, meta(User), meta, () => {});
 * assocs.get("posts")?.relatedKey; // ["authorId"]
 * ```
 *
 * @throws SchemaDefinitionError naming the schema, the association and the fix.
 */
export function resolveAssocs(
  owner: AnySchema,
  ownerMeta: SchemaMeta,
  metaOf: (schema: AnySchema) => SchemaMeta,
  publish: (partial: ReadonlyMap<string, ResolvedAssoc>) => void,
): ReadonlyMap<string, ResolvedAssoc> {
  const built = new Map<string, ResolvedAssoc>();
  publish(built);

  const pending: [Context, Declaration][] = [];
  for (const [name, declaration] of declarations(owner)) {
    const context = optionsOf(
      { label: `${ownerMeta.name}.${name}`, name, kind: declaration.kind, owner, ownerMeta, metaOf },
      declaration,
    );
    if (ownerMeta.source === null) {
      fail(
        context,
        "schema.assocOnEmbedded",
        `${ownerMeta.name} is an embedded schema: it is stored inside its parent's row and has no table to associate.`,
      );
    }
    if (ownerMeta.fieldsByName.has(name)) {
      fail(
        context,
        "schema.assocFieldClash",
        `${ownerMeta.name} has a field and an association that are both named "${name}".`,
        { params: { name } },
      );
    }
    if (reservedName(name) || name === "fields") {
      fail(
        context,
        "schema.assocReservedName",
        `"${name}" cannot be the name of an association: "constructor", "__proto__", "toJSON", "fields" and names that start with "$" are reserved.`,
      );
    }
    if (definedOnPrototype(owner.prototype, name)) {
      fail(
        context,
        "schema.assocShadowedByMember",
        `${ownerMeta.name} defines "${name}" as a getter, method or property of the class, and "${name}" is also an association.`,
      );
    }
    pending.push([context, declaration]);
  }

  // Three rounds, so that what a later round looks up in another schema is already
  // there: plain keys first, then join tables (which may read the join schema's
  // belongsTo), then the chains that follow all of them.
  const isThrough = (context: Context): boolean => own(context.options, "through") !== undefined;
  for (const [context, declaration] of pending) {
    if (isThrough(context) || context.kind === "manyToMany") continue;
    built.set(
      context.name,
      context.kind === "belongsTo"
        ? resolveBelongsTo(context, declaration)
        : resolveHas(context, declaration),
    );
  }
  for (const [context, declaration] of pending) {
    if (context.kind === "manyToMany") built.set(context.name, resolveManyToMany(context, declaration));
  }
  const chains: [Context, ResolvedAssoc][] = [];
  for (const [context, declaration] of pending) {
    if (!isThrough(context)) continue;
    const assoc = resolveThrough(context, declaration);
    built.set(context.name, assoc);
    chains.push([context, assoc]);
  }
  for (const [context, assoc] of chains) checkPath(context, assoc, assoc.through as readonly string[]);

  const ordered = new Map<string, ResolvedAssoc>();
  for (const [context] of pending) ordered.set(context.name, built.get(context.name) as ResolvedAssoc);
  return ordered;
}
