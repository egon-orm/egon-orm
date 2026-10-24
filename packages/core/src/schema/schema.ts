/**
 * `Schema()` and `EmbeddedSchema()`: the class factories, the metadata they compute once
 * per class, and the row factory (decision D2).
 *
 * @module
 */

import { generatedBuilders, refuseGeneration } from "../changeset/validators/generated.js";
import type {
  AnySchema,
  EmbedMeta,
  FieldMeta,
  FieldNames,
  FieldsShape,
  PrimaryKeyOf,
  Row,
  RowMeta,
  RowState,
  SchemaClass,
  SchemaMeta,
} from "../contracts/schema.js";
import { META, ROW } from "../contracts/schema.js";
import { SchemaDefinitionError } from "../errors.js";
import { generateFunction } from "../internal/codegen.js";
import { formatStruct, REDACTED } from "../internal/inspect.js";
import { camelToSnake } from "../internal/naming.js";
import { own } from "../internal/own.js";
import type { ResolvedAssoc } from "./assoc.js";
import { reservedName, resolveAssocs } from "./assoc.js";
import type { FieldState } from "./field.js";
import { fieldState } from "./field.js";
import { definedOnPrototype, describe, isRow } from "./guards.js";
import type { JsonTable } from "./json.js";
import { jsonTableOf, rowToJSON } from "./json.js";
import { MODEL } from "./model.js";

/**
 * How field names become column names (or, in an embedded schema, JSON keys):
 * `"snake_case"` turns `createdAt` into `created_at`, `"camelCase"` keeps the field name,
 * and a function decides for itself. Tables default to `"snake_case"`, embedded schemas to
 * `"camelCase"`.
 *
 * @example
 * ```ts
 * const upper: Naming = (field) => field.toUpperCase();
 * ```
 */
export type Naming = "snake_case" | "camelCase" | ((field: string) => string);

/**
 * Options of {@link Schema}.
 *
 * @example
 * ```ts
 * const options: SchemaOptions = { schema: "billing", naming: "snake_case" };
 * ```
 */
export interface SchemaOptions {
  /** The database schema the table is in (a Postgres schema, a MySQL database). */
  readonly schema?: string | undefined;
  /** How field names become column names. Defaults to `"snake_case"`. */
  readonly naming?: Naming | undefined;
  /** `false` for a table without a primary key. Such rows cannot be updated or deleted one at a time. */
  readonly primaryKey?: false | undefined;
  /**
   * `false` builds rows, and the values `changeset.validate()` hands a validator, with loops
   * instead of generated functions, so nothing about this schema ever calls `new Function`
   * (a strict Content Security Policy then reports nothing). Where generating code is
   * refused (such a policy, or a Cloudflare Worker handling a request), the loops are used
   * by themselves anyway.
   */
  readonly codegen?: boolean | undefined;
}

/**
 * Options of {@link EmbeddedSchema}.
 *
 * @example
 * ```ts
 * const options: EmbeddedSchemaOptions = { naming: "snake_case" };
 * ```
 */
export interface EmbeddedSchemaOptions {
  /** How field names become keys of the stored JSON object. Defaults to `"camelCase"`: the field names as they are. */
  readonly naming?: Naming | undefined;
  /** As for {@link SchemaOptions.codegen}. */
  readonly codegen?: boolean | undefined;
}

/** Node's `util.inspect.custom`, which Deno and Bun honour too. Looked up by name: no import of `node:util`. */
const INSPECT: unique symbol = /* @__PURE__ */ Symbol.for("nodejs.util.inspect.custom");

type Factory = (values: readonly unknown[], row: RowMeta) => object;
type LoadedFactory = (values: readonly unknown[], loaded: readonly unknown[], row: RowMeta) => object;

/**
 * The metadata object behind `S[META]`. It is the `SchemaMeta` contract plus what this
 * module precomputes for itself.
 */
interface Meta extends SchemaMeta {
  assocs(): ReadonlyMap<string, ResolvedAssoc>;
  /** The class this metadata describes. A class that extends it gets metadata of its own. */
  readonly model: AnySchema;
  /** The names of the redacted fields. */
  readonly redacted: ReadonlySet<string>;
  /** The field names in declaration order. */
  readonly fieldNames: readonly string[];
  /** Whether row factories are generated functions (unless the runtime refuses to generate code). */
  readonly codegen: boolean;
  /** The fields that are in JSON and how each is converted: built on the first `toJSON`, then cached. */
  jsonTable(): JsonTable;
  /** The maker of the plain row constructor, generated in `Schema()`; `undefined` for loops. */
  readonly maker: ConstructorMaker | undefined;
}

interface RowLike {
  readonly [MODEL]: Meta;
  readonly [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

function columnNamer(label: string, naming: unknown): (field: string) => string {
  if (naming === "snake_case") return camelToSnake;
  if (naming === "camelCase") return (field) => field;
  if (typeof naming === "function") {
    return (field) => {
      const column: unknown = naming(field);
      if (typeof column !== "string" || column === "") {
        throw new SchemaDefinitionError(
          "schema.namingResult",
          `${label}: the naming function returned ${describe(column)} for the field "${field}".`,
        );
      }
      return column;
    };
  }
  throw new SchemaDefinitionError(
    "schema.namingOption",
    `${label}: naming must be "snake_case", "camelCase" or a function from field name to column name.`,
  );
}

function fieldMeta(
  label: string,
  name: string,
  index: number,
  state: FieldState,
  column: (field: string) => string,
): FieldMeta {
  const at = `${label}: field "${name}"`;
  if (reservedName(name) || name === "") {
    throw new SchemaDefinitionError("schema.reservedName", `${at} has a reserved name.`, {
      params: { name },
    });
  }
  if (state.primaryKey && state.nullable) {
    throw new SchemaDefinitionError("schema.nullableKey", `${at} is a primary key and nullable.`);
  }
  if (state.virtual && (state.primaryKey || state.dbGenerated || state.autogenerate !== undefined)) {
    throw new SchemaDefinitionError(
      "schema.virtualStored",
      `${at} is virtual, so it is never stored: it cannot also be a primary key, database-generated or autogenerated.`,
    );
  }
  if (state.embed !== undefined && (state.primaryKey || state.virtual)) {
    throw new SchemaDefinitionError(
      "schema.embedModifier",
      `${at} is an embed, which cannot be a primary key or virtual.`,
    );
  }
  if (state.dbGenerated && state.autogenerate !== undefined) {
    throw new SchemaDefinitionError(
      "schema.generatedTwice",
      `${at} is both database-generated and autogenerated.`,
    );
  }
  if (state.default?.kind === "value" && state.default.value === null && !state.nullable) {
    throw new SchemaDefinitionError("schema.nullDefault", `${at} has the default null but is not nullable.`);
  }
  return Object.freeze({
    name,
    column: state.virtual ? name : (state.column ?? column(name)),
    type: state.type,
    nullable: state.nullable,
    primaryKey: state.primaryKey,
    virtual: state.virtual,
    redact: state.redact,
    json: state.json,
    writable: state.writable,
    dbGenerated: state.dbGenerated,
    default: state.default,
    autogenerate: state.autogenerate,
    index,
  });
}

interface Tables {
  readonly fields: readonly FieldMeta[];
  readonly fieldsByName: ReadonlyMap<string, FieldMeta>;
  readonly persisted: readonly FieldMeta[];
  readonly primaryKey: readonly FieldMeta[];
  readonly embeds: readonly EmbedMeta[];
  readonly redacted: ReadonlySet<string>;
  readonly fieldNames: readonly string[];
}

function tablesOf(
  label: string,
  declared: unknown,
  naming: unknown,
  keyless: boolean,
  embedded: boolean,
): Tables {
  if (typeof declared !== "object" || declared === null) {
    throw new SchemaDefinitionError(
      "schema.fieldsNotObject",
      `${label}: the fields must be an object from field name to type, such as { id: t.integer().primaryKey() }, but got ${describe(declared)}.`,
    );
  }
  const column = columnNamer(label, naming);
  const fields: FieldMeta[] = [];
  const embeds: EmbedMeta[] = [];
  const columns = new Map<string, string>();
  for (const name of Object.keys(declared)) {
    const state = fieldState((declared as Readonly<Record<string, unknown>>)[name]);
    if (state === undefined) {
      throw new SchemaDefinitionError(
        "schema.notFieldType",
        `${label}: field "${name}" is not a field type.`,
        { params: { name } },
      );
    }
    const field = fieldMeta(label, name, fields.length, state, column);
    if (!field.virtual) {
      const other = columns.get(field.column);
      if (other !== undefined) {
        throw new SchemaDefinitionError(
          "schema.columnTaken",
          `${label}: the fields "${other}" and "${name}" are both stored in the column "${field.column}".`,
        );
      }
      columns.set(field.column, name);
    }
    fields.push(field);
    if (state.embed !== undefined) {
      embeds.push(
        Object.freeze({
          name,
          cardinality: state.embed.cardinality,
          schema: state.embed.schema,
          onReplace: state.embed.onReplace,
          column: field.column,
        }),
      );
    }
  }
  const primaryKey = fields.filter((field) => field.primaryKey);
  if (keyless && primaryKey.length > 0) {
    throw new SchemaDefinitionError(
      "schema.keylessWithKey",
      `${label}: { primaryKey: false } says the table has no key, but the field "${primaryKey[0]?.name}" is declared with .primaryKey().`,
    );
  }
  if (!keyless && !embedded && primaryKey.length === 0) {
    throw new SchemaDefinitionError("schema.noPrimaryKey", `${label}: no field is the primary key.`);
  }
  return {
    fields: Object.freeze(fields),
    fieldsByName: new Map(fields.map((field) => [field.name, field])),
    persisted: Object.freeze(fields.filter((field) => !field.virtual)),
    primaryKey: Object.freeze(primaryKey),
    embeds: Object.freeze(embeds),
    redacted: new Set(fields.filter((field) => field.redact).map((field) => field.name)),
    fieldNames: Object.freeze(fields.map((field) => field.name)),
  };
}

// ---------------------------------------------------------------------------
// Row factories
// ---------------------------------------------------------------------------

/** Constructs a row: the fields' values, the loaded associations' values, the row's metadata. */
type RowConstructor = new (values: readonly unknown[], loaded: readonly unknown[], row: RowMeta) => object;

/**
 * Makes a new row constructor each time it is called: a new function object (so that its
 * `prototype` can be set to a class's), whose code was generated once.
 */
type ConstructorMaker = () => RowConstructor;

/** For each value slot of the fields (by the shared `fieldNames` array): where it is in `values`, -1 for a virtual field. */
function positionsOf(tables: Tables): number[] {
  const positions: number[] = [];
  let next = 0;
  for (const field of tables.fields) positions.push(field.virtual ? -1 : next++);
  return positions;
}

/**
 * Generates the maker of a row constructor for these fields and associations: every field
 * in declaration order, then the loaded associations, then the `ROW` marker, always in that
 * order, so that every row it makes has the same hidden class. `undefined` when the runtime
 * refuses to generate code; the caller then uses {@link loopConstructor}.
 *
 * Generated once per schema in `Schema()` (where code generation is allowed even on
 * runtimes that refuse it while handling a request), and used for every class that extends
 * the schema.
 */
function generateMaker(tables: Tables, assocs: readonly string[]): ConstructorMaker | undefined {
  const positions = positionsOf(tables);
  // Names go in as string literals, so nothing a schema declares can become code.
  const lines = tables.fieldNames.map((name, i) => {
    const position = positions[i] as number;
    return `this[${JSON.stringify(name)}] = ${position < 0 ? "undefined" : `values[${position}]`};`;
  });
  assocs.forEach((name, i) => {
    lines.push(`this[${JSON.stringify(name)}] = loaded[${i}];`);
  });
  lines.push("this[ROW] = row;");
  // Strict, as the loop is: an assignment that cannot be made throws instead of being lost.
  const outer = generateFunction(
    ["ROW"],
    `"use strict";\nreturn function make() {\nreturn function Row(values, loaded, row) {\n${lines.join("\n")}\n};\n};`,
  ) as ((row: typeof ROW) => ConstructorMaker) | undefined;
  return outer?.(ROW);
}

/** The row constructor as a loop, for runtimes that refuse code generation and for `codegen: false`. */
function loopConstructor(tables: Tables, assocs: readonly string[]): RowConstructor {
  const positions = positionsOf(tables);
  const names = tables.fieldNames;
  return function Row(
    this: Record<string | symbol, unknown>,
    values: readonly unknown[],
    loaded: readonly unknown[],
    row: RowMeta,
  ): void {
    for (let i = 0; i < names.length; i++) {
      const position = positions[i] as number;
      this[names[i] as string] = position < 0 ? undefined : values[position];
    }
    for (let i = 0; i < assocs.length; i++) this[assocs[i] as string] = loaded[i];
    this[ROW] = row;
  } as unknown as RowConstructor;
}

/**
 * Builds the function that makes rows. It is used as a constructor whose `prototype` is
 * the schema class's: the row is an instance of the class without the class's own
 * constructor ever running.
 */
function compileFactory(
  tables: Tables,
  prototype: object,
  assocs: readonly string[],
  maker: ConstructorMaker | undefined,
): RowConstructor {
  const construct = maker === undefined ? loopConstructor(tables, assocs) : maker();
  construct.prototype = prototype;
  return construct;
}

const NOTHING_LOADED: readonly unknown[] = /* @__PURE__ */ Object.freeze([]);

/** Past this many database schemas, the shared `RowMeta` objects of a table are dropped and made again. */
const ROW_META_LIMIT = 4096;

function rowMetaCache(source: string | null): (state: RowState, schema: string | undefined) => RowMeta {
  const bySchema = new Map<string | undefined, Readonly<Record<RowState, RowMeta>>>();
  return (state, schema) => {
    let states = bySchema.get(schema);
    if (states === undefined) {
      // A tenant per database schema must not grow this without bound.
      if (bySchema.size >= ROW_META_LIMIT) bySchema.clear();
      states = {
        built: Object.freeze({ state: "built", source, schema }),
        loaded: Object.freeze({ state: "loaded", source, schema }),
        deleted: Object.freeze({ state: "deleted", source, schema }),
      };
      bySchema.set(schema, states);
    }
    return states[state];
  };
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

interface Shared extends Tables {
  readonly source: string | null;
  readonly schema: string | undefined;
  readonly codegen: boolean;
  readonly maker: ConstructorMaker | undefined;
  readonly rowMeta: (state: RowState, schema: string | undefined) => RowMeta;
}

function makeMeta(shared: Shared, model: AnySchema, name: string): Meta {
  const prototype = model.prototype as object;
  for (const field of shared.fieldNames) {
    if (definedOnPrototype(prototype, field)) {
      throw new SchemaDefinitionError(
        "schema.memberShadowsField",
        `${name} defines "${field}" as a getter, method or property of the class, and "${field}" is also a field.`,
      );
    }
  }
  const Plain = compileFactory(shared, prototype, [], shared.maker);
  const factories = new Map<string, LoadedFactory>();
  let resolved: ReadonlyMap<string, ResolvedAssoc> | undefined;
  let resolving: ReadonlyMap<string, ResolvedAssoc> | undefined;
  let json: JsonTable | undefined;

  const self: Meta = Object.freeze({
    name,
    source: shared.source,
    schema: shared.schema,
    fields: shared.fields,
    fieldsByName: shared.fieldsByName,
    persisted: shared.persisted,
    primaryKey: shared.primaryKey,
    embeds: shared.embeds,
    assocs(): ReadonlyMap<string, ResolvedAssoc> {
      if (resolved !== undefined) return resolved;
      // Asked again while resolving (by a schema this one points at): what is there so far.
      if (resolving !== undefined) return resolving;
      try {
        resolved = resolveAssocs(model, self, meta, (partial) => {
          resolving = partial;
        });
        return resolved;
      } finally {
        resolving = undefined;
      }
    },
    rowMeta: shared.rowMeta,
    create: ((values, row) => new Plain(values, NOTHING_LOADED, row)) satisfies Factory,
    createWith(assocs: readonly string[]): LoadedFactory {
      const key = JSON.stringify(assocs);
      let factory = factories.get(key);
      if (factory === undefined) {
        const known = self.assocs();
        const seen = new Set<string>();
        for (const assoc of assocs) {
          if (!known.has(assoc) || seen.has(assoc)) {
            throw known.has(assoc)
              ? new SchemaDefinitionError(
                  "schema.createWithTwice",
                  `${name}: the association "${assoc}" is listed twice in createWith().`,
                )
              : new SchemaDefinitionError(
                  "schema.createWithUnknown",
                  `${name} has no association "${assoc}". It has: ${[...known.keys()].join(", ") || "none"}.`,
                );
          }
          seen.add(assoc);
        }
        // Generated now if the runtime allows it (Workers do not while handling a request).
        const maker = shared.codegen ? generateMaker(shared, assocs) : undefined;
        const Loaded = compileFactory(shared, prototype, [...assocs], maker);
        factory = (values, loaded, row) => new Loaded(values, loaded, row);
        factories.set(key, factory);
      }
      return factory;
    },
    model,
    redacted: shared.redacted,
    fieldNames: shared.fieldNames,
    codegen: shared.codegen,
    jsonTable(): JsonTable {
      if (json === undefined) json = jsonTableOf(shared.fields);
      return json;
    },
    maker: shared.maker,
  });
  return self;
}

function sharedOf(inherited: Meta): Shared {
  return {
    source: inherited.source,
    schema: inherited.schema,
    fields: inherited.fields,
    fieldsByName: inherited.fieldsByName,
    persisted: inherited.persisted,
    primaryKey: inherited.primaryKey,
    embeds: inherited.embeds,
    redacted: inherited.redacted,
    fieldNames: inherited.fieldNames,
    codegen: inherited.codegen,
    maker: inherited.maker,
    rowMeta: inherited.rowMeta,
  };
}

/**
 * Gives a class that extends a schema base its own metadata: the same fields, its own
 * name, its own associations, and a row factory that makes instances of that class.
 */
function adopt(schema: unknown, inherited: unknown): Meta {
  const base = inherited as Partial<Meta> | undefined;
  if (typeof schema !== "function" || base === undefined || typeof base.model !== "function") {
    throw new SchemaDefinitionError(
      "schema.notSchemaClass",
      `Expected a schema class (a class that extends Schema(...) or EmbeddedSchema(...)), but got ${describe(schema)}.`,
    );
  }
  const metadata = makeMeta(sharedOf(base as Meta), schema as AnySchema, schema.name || (base as Meta).name);
  Object.defineProperty(schema, META, { value: metadata });
  return metadata;
}

/**
 * The metadata of a schema class: its table, its fields, its primary key and, through
 * `assocs()`, its associations.
 *
 * @example
 * ```ts
 * meta(User).source; // "users"
 * meta(User).primaryKey.map((field) => field.name); // ["id"]
 * meta(User).assocs().get("posts")?.kind; // "hasMany"
 * ```
 *
 * @throws SchemaDefinitionError when `schema` is not a schema class.
 */
export function meta(schema: AnySchema): SchemaMeta {
  // The base that Schema() returned holds metadata that a class extending it inherits.
  // The first time such a class is seen it gets metadata of its own; from then on the
  // first check is all that runs.
  const found = (schema as Partial<AnySchema> | null | undefined)?.[META] as Meta | undefined;
  if (found !== undefined && (found.model === schema || Object.hasOwn(schema, META))) return found;
  return adopt(schema, found);
}

// ---------------------------------------------------------------------------
// What every row inherits
// ---------------------------------------------------------------------------

/** Prints as the bare text, where a string would be printed in quotes. */
const REDACTED_VALUE: object = /* @__PURE__ */ Object.freeze({ [INSPECT]: () => REDACTED });

interface InspectOptions {
  readonly depth?: number | null;
}

function className(row: object): string {
  const owner: unknown = (Object.getPrototypeOf(row) as { readonly constructor?: unknown }).constructor;
  return typeof owner === "function" && owner.name !== "" ? owner.name : "Row";
}

/** What `console.log(row)` shows: the class name and the fields, redacted ones masked. */
function rowInspect(
  this: RowLike,
  depth: number | null,
  options: InspectOptions,
  inspect?: (value: unknown, options: InspectOptions) => string,
): string {
  const redacted = this[MODEL].redacted;
  const name = className(this);
  if (typeof inspect !== "function") return formatStruct(name, this, redacted);
  if (depth !== null && depth < 0) return `[${name}]`;
  const shown: Record<string, unknown> = {};
  for (const key of Object.keys(this)) shown[key] = redacted.has(key) ? REDACTED_VALUE : this[key];
  return `${name} ${inspect(shown, { ...options, depth })}`;
}

// ---------------------------------------------------------------------------
// The class factories
// ---------------------------------------------------------------------------

function defineSchema(
  label: string,
  source: string | null,
  declared: unknown,
  options: SchemaOptions | undefined,
): AnySchema {
  if (options !== undefined && (typeof options !== "object" || options === null)) {
    throw new SchemaDefinitionError(
      "schema.optionsNotObject",
      `${label}: the options must be an object, but got ${describe(options)}.`,
    );
  }
  const schema: unknown = own(options, "schema");
  if (schema !== undefined && (typeof schema !== "string" || schema === "")) {
    throw new SchemaDefinitionError(
      "schema.schemaOption",
      `${label}: schema must be the name of the database schema, as a non-empty string.`,
    );
  }
  const keyless: unknown = own(options, "primaryKey");
  if (keyless !== undefined && keyless !== false) {
    throw new SchemaDefinitionError(
      "schema.primaryKeyOption",
      `${label}: primaryKey can only be false, for a table without a key.`,
    );
  }
  // A table's columns are snake_case by default; the keys of an embedded JSON object keep
  // the field names.
  const naming = own(options, "naming") ?? (source === null ? "camelCase" : "snake_case");
  const tables = tablesOf(label, declared, naming, keyless === false, source === null);

  class Base {
    static readonly fields = Object.freeze({ ...(declared as object) });

    constructor() {
      const name = new.target.name || label;
      throw new SchemaDefinitionError(
        "schema.noConstructor",
        `${name} has no public constructor: a row comes only from the database.`,
        { params: { name } },
      );
    }
  }
  const base = Base as unknown as AnySchema;
  const codegen = own(options, "codegen") !== false;
  // The builders `changeset.validate()` uses, for the same reason as the row factory.
  if (codegen) generatedBuilders(tables.fieldsByName);
  else refuseGeneration(tables.fieldsByName);
  const metadata = makeMeta(
    {
      ...tables,
      source,
      schema,
      codegen,
      // Eagerly, while the schema is defined: a schema is usually defined when the
      // application starts, which is when every runtime allows code generation.
      maker: codegen ? generateMaker(tables, []) : undefined,
      rowMeta: rowMetaCache(source),
    },
    base,
    label,
  );
  Object.defineProperty(base, META, { value: metadata });
  Object.defineProperties(Base.prototype, {
    toJSON: { value: rowToJSON, writable: true, configurable: true },
    [INSPECT]: { value: rowInspect, writable: true, configurable: true },
    [MODEL]: { value: metadata },
  });
  return base;
}

/**
 * Defines the schema of a table: returns a base class to extend. The class you write is
 * the type of the table's rows, and may add getters and methods. It may not define a
 * constructor or field initialisers: rows are built without running a constructor.
 *
 * You never write `new User()`. Rows come from the database; a record that does not exist
 * yet is described by a changeset.
 *
 * Associations are `static` members of the class: see `hasMany`, `hasOne`, `belongsTo`
 * and `manyToMany`.
 *
 * @example
 * ```ts
 * class User extends Schema("users", {
 *   id: t.integer().primaryKey().dbGenerated(),
 *   email: t.string(),
 *   name: t.string().nullable(),
 *   ...timestamps(),
 * }) {
 *   static posts = hasMany(() => Post, { foreignKey: "authorId" });
 *
 *   get displayName(): string {
 *     return this.name ?? this.email;
 *   }
 * }
 * ```
 *
 * @throws SchemaDefinitionError when the definition is wrong: no primary key (and no
 * `{ primaryKey: false }`), two fields in one column, a reserved field name, or modifiers
 * that contradict each other. The message names the schema, the field and the fix.
 */
export function Schema<const F extends FieldsShape>(
  source: string,
  fields: F,
  options?: SchemaOptions,
): SchemaClass<F> {
  if (typeof source !== "string" || source === "") {
    throw new SchemaDefinitionError(
      "schema.tableName",
      `Schema() was given ${describe(source)} as the table name.`,
    );
  }
  return defineSchema(`Schema("${source}")`, source, fields, options) as unknown as SchemaClass<F>;
}

/**
 * Defines an embedded schema: a structured object stored inside one JSON column of its
 * parent, declared there with `t.embedOne` or `t.embedMany`. It has fields like a schema,
 * but no table, and a primary key only if you give it one (items of a list are then
 * matched by it).
 *
 * @example
 * ```ts
 * class Address extends EmbeddedSchema({
 *   street: t.string(),
 *   city: t.string(),
 *   postcode: t.string().nullable(),
 * }) {}
 *
 * class User extends Schema("users", {
 *   id: t.integer().primaryKey().dbGenerated(),
 *   address: t.embedOne(() => Address).nullable(),
 * }) {}
 * ```
 *
 * @throws SchemaDefinitionError when the definition is wrong, as for {@link Schema}.
 */
export function EmbeddedSchema<const F extends FieldsShape>(
  fields: F,
  options?: EmbeddedSchemaOptions,
): SchemaClass<F> {
  return defineSchema("EmbeddedSchema", null, fields, options) as unknown as SchemaClass<F>;
}

// ---------------------------------------------------------------------------
// Reflection
// ---------------------------------------------------------------------------

/**
 * The field names of a schema class, in declaration order. The array is shared and frozen.
 *
 * @example
 * ```ts
 * fieldNames(User); // ["id", "email", "name", "createdAt", "updatedAt"]
 * ```
 *
 * @throws SchemaDefinitionError when `schema` is not a schema class.
 */
export function fieldNames<S extends AnySchema>(schema: S): readonly FieldNames<S>[] {
  return (meta(schema) as Meta).fieldNames as readonly FieldNames<S>[];
}

/**
 * The value that identifies a row: the key field's value, or an object of the key fields
 * for a composite key. Pass the schema class as well to have the result typed.
 *
 * @example
 * ```ts
 * primaryKeyOf(user); // 1
 * primaryKeyOf(user, User); // 1, typed number
 * primaryKeyOf(membership, Membership); // { orgId: "…", userId: 1 }
 * ```
 *
 * @throws SchemaDefinitionError when `row` is not a row, or its schema has no primary key.
 */
export function primaryKeyOf<S extends AnySchema>(row: Row<S>, schema: S): PrimaryKeyOf<S>;
export function primaryKeyOf(row: object): unknown;
export function primaryKeyOf(row: unknown, _schema?: AnySchema): unknown {
  const model = (row as Partial<RowLike> | null | undefined)?.[MODEL];
  if (model === undefined || !isRow(row)) {
    throw new SchemaDefinitionError(
      "schema.notRow",
      "primaryKeyOf() expects a row: an object returned by a query or a write.",
    );
  }
  const key = model.primaryKey;
  const values = row as unknown as Readonly<Record<string, unknown>>;
  if (key.length === 1) return values[(key[0] as FieldMeta).name];
  if (key.length === 0) {
    throw new SchemaDefinitionError(
      "schema.keylessRow",
      `${className(row)} has no primary key, so its rows have no key value.`,
    );
  }
  const composite: Record<string, unknown> = {};
  for (const field of key) composite[field.name] = values[field.name];
  return composite;
}
