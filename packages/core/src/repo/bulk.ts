/**
 * The bulk writes of the repo: `insertAll`, `updateAll` and `deleteAll`. They take no
 * changeset and run no validation.
 *
 * ## insertAll
 *
 * The rows are plain objects of field values; a value may also be an expression (a
 * `fragment`, `now()`, a named parameter `param(name, type)` filled from the
 * `placeholders` option) or a query (a subquery that selects one value). Each row gets
 * its fields' defaults and generated values (one instant for every timestamp of the
 * call), and every row is written with the same column list: a field a row leaves out is
 * written as `DEFAULT`, so the database default applies. The rows are sent in chunks that
 * stay under the dialect's parameter limit (`insertChunks`), inside one transaction when
 * there is more than one chunk. A query in place of the rows is `INSERT … SELECT`: its
 * select names the fields, by key.
 *
 * ## updateAll and deleteAll
 *
 * A query compiled as an `UPDATE` (with its `.set(...)` assignments) or a `DELETE`. Both
 * return the number of rows written and, when the query declares `.returning(...)`, the
 * rows it returned.
 *
 * @module
 */

import { bindParams, fieldOfRefusal } from "../compiler/bind.js";
import { insertChunks } from "../compiler/write.js";
import type {
  CompiledQuery,
  Executor,
  InsertCell,
  InsertSource,
  OnConflict,
  RawResult,
} from "../contracts/adapter.js";
import type {
  ExprNode,
  NamedParamNode,
  QueryAst,
  QueryNode,
  SelectNode,
  SelectShape,
  TableSourceNode,
} from "../contracts/query.js";
import type { AnySchema, FieldMeta, FieldNames, InsertShape, SchemaMeta } from "../contracts/schema.js";
import { QueryError } from "../errors.js";
import { own } from "../internal/own.js";
import { isPlainObject } from "../internal/plain-object.js";
import { needsFieldType } from "../query/advanced/assignments.js";
import { PreparedQuery } from "../query/advanced/prepare.js";
import { castNode, collectParams, shapeOf } from "../query/ast.js";
import type { Expr, SomeParams } from "../query/expr.js";
import { isExpr } from "../query/expr.js";
import { isSchema } from "../schema/guards.js";
import { meta } from "../schema/schema.js";
import { decodeRows, decoderFor } from "./hydrate.js";
import {
  checkReadOptions,
  READ_OPTION_KEYS,
  type ReadOptions,
  type SplitArgs,
  splitArgs,
} from "./options.js";
import { inputOf, type ReadCore } from "./read.js";
import { atomically } from "./transaction.js";
import {
  conflictOption,
  deadlineOf,
  type OnConflictOption,
  persistedField,
  returningOption,
  runWrite,
  writeTable,
} from "./write.js";

const NONE: readonly never[] = /* @__PURE__ */ Object.freeze([]);
const hasOwn = Object.hasOwn;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One row of `insertAll`: the fields a new record needs (as `InsertShape` has them), each
 * given as a value or an expression of exactly that type. A subquery is an expression
 * too: `scalar(query)` is typed `T | null`, so a non-nullable field takes it only when the
 * caller says it cannot be null, `scalar(query).as<T>()`, or gives a fallback,
 * `coalesce(scalar(query), value)`.
 *
 * @example
 * ```ts
 * const row: InsertAllRow<typeof Post> = { authorId: 1, title: "Hello", publishedAt: now() };
 * ```
 */
export type InsertAllRow<S extends AnySchema> = {
  [K in keyof InsertShape<S>]: InsertShape<S>[K] | Expr<InsertShape<S>[K], SomeParams>;
};

/** A query given where a value goes. */
interface QueryLikeValue {
  readonly ast: QueryAst;
}

/**
 * The options of `repo.insertAll`.
 *
 * - `returning`: `true` returns every row inserted as a row of the schema; a list of
 *   field names returns plain objects of those fields. Without it, `rows` is `null`.
 * - `onConflict`: as for `repo.insert`. With `"nothing"`, `count` leaves the skipped rows out.
 * - `placeholders`: the values of the named parameters (`param("now", t.timestamp())`)
 *   used in the rows or in the source query: each value is given once here, and sent with
 *   every row (or cell) that uses it.
 *
 * @example
 * ```ts
 * const options: InsertAllOptions<typeof Post> = { returning: ["id"], placeholders: { now: new Date() } };
 * ```
 */
export interface InsertAllOptions<S extends AnySchema = AnySchema> extends ReadOptions {
  readonly returning?: true | readonly FieldNames<S>[] | undefined;
  readonly onConflict?: OnConflictOption<S> | undefined;
  readonly placeholders?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * What a bulk write returns: how many rows it wrote, and the rows it returned (`null`
 * when it was not asked to return any).
 *
 * @example
 * ```ts
 * const { count, rows }: BulkResult<{ id: number }> = await repo.deleteAll(stale.returning(({ p }) => ({ id: p.id })));
 * ```
 */
export interface BulkResult<R> {
  readonly count: number;
  readonly rows: R[] | null;
}

export const INSERT_ALL_OPTION_KEYS: readonly string[] = /* @__PURE__ */ Object.freeze(
  /* @__PURE__ */ READ_OPTION_KEYS.concat(["returning", "onConflict", "placeholders"]),
);

// ---------------------------------------------------------------------------
// Transactions and budgets
// ---------------------------------------------------------------------------

// Several chunks run through `atomically` (step 16): in a transaction of their own on the
// pool, in a savepoint inside a transaction (so that a failed chunk undoes only this call
// and the caller's transaction stays usable).

// ---------------------------------------------------------------------------
// insertAll
// ---------------------------------------------------------------------------

/** One prepared row: its cells and the values they bind, and how many placeholders they take. */
interface PreparedRow {
  readonly cells: readonly InsertCell[];
  readonly values: readonly unknown[];
  readonly params: number;
}

const VALUE_CELL: InsertCell = /* @__PURE__ */ Object.freeze({ kind: "value" });
const DEFAULT_CELL: InsertCell = /* @__PURE__ */ Object.freeze({ kind: "default" });

/** What decodes the rows an insertAll returned. */
interface Returning {
  readonly schemaMeta: SchemaMeta;
  /** `true`: whole rows of the schema; `false`: plain objects of the fields asked for; `undefined`: none. */
  readonly whole: boolean | undefined;
}

interface Chunked {
  readonly count: number;
  readonly rows: unknown[] | null;
}

function decodeInserted(result: RawResult, plan: CompiledQuery, core: ReadCore, back: Returning): Chunked {
  if (back.whole === undefined || plan.output === undefined) return { count: result.rowCount, rows: null };
  const decoder = decoderFor(plan, core.adapter, core.codegen, back.schemaMeta.name);
  const objects = decodeRows(result.rows, decoder, NONE);
  if (!back.whole) return { count: result.rowCount, rows: objects };
  const schemaMeta = back.schemaMeta;
  const rowMeta = schemaMeta.rowMeta("loaded", plan.schema);
  const rows: unknown[] = [];
  for (const object of objects as readonly Readonly<Record<string, unknown>>[]) {
    const values: unknown[] = [];
    for (const field of schemaMeta.persisted) values.push(object[field.name]);
    rows.push(schemaMeta.create(values, rowMeta));
  }
  return { count: result.rowCount, rows };
}

function isQueryLike(value: unknown): value is QueryLikeValue {
  if (typeof value !== "object" || value === null) return false;
  const ast = (value as { readonly ast?: unknown }).ast;
  return typeof ast === "object" && ast !== null && (ast as { readonly kind?: unknown }).kind === "query";
}

/**
 * Appends the cell for one value of `field` to `cells` and what it binds to `values`;
 * returns how many placeholders it takes. The target column is the type context (option
 * A): a plain value, and an expression that is just an untyped value (`val(x)`), are bound
 * with the field's type; a `CASE` or `coalesce` of bound values and `NULL`s is cast to it,
 * as `set` does.
 */
function pushCell(
  value: unknown,
  field: FieldMeta,
  cells: InsertCell[],
  values: unknown[],
  names: NamedParamNode[],
  expandLists: boolean,
): number {
  if (isExpr(value)) {
    const node = value.node as ExprNode;
    if (node.kind === "param" && node.type === undefined) {
      cells.push(VALUE_CELL);
      values.push(node.value);
      return 1;
    }
    if (node.kind === "namedParam") {
      names.push(node);
      cells.push({ kind: "placeholder", name: node.name });
      return 1;
    }
    const typed = needsFieldType(node) ? castNode(node, field.type) : node;
    cells.push({ kind: "expr", expr: typed });
    return bindExpr(typed, values, names, expandLists);
  }
  if (isQueryLike(value)) {
    throw new QueryError("query.insertAllQueryValue", "repo.insertAll(): a row holds a query as a value.");
  }
  cells.push(VALUE_CELL);
  values.push(value);
  return 1;
}

/**
 * Appends an expression cell's values; returns how many placeholders it takes: one per value
 * and per named parameter, and a list counts its length on a dialect that expands lists
 * (`IN (?, ?, ?)`), one where it is bound as an array.
 */
function bindExpr(node: ExprNode, values: unknown[], names: NamedParamNode[], expandLists: boolean): number {
  const inline: unknown[] = [];
  const lists: number[] = [];
  const named: NamedParamNode[] = [];
  collectParams(node, inline, lists, named);
  for (const value of inline) values.push(value);
  for (const each of named) names.push(each);
  let params = inline.length + named.length;
  if (expandLists) for (const length of lists) params += Math.max(0, length - 1);
  return params;
}

/** Sizes of chunks of `rows` (each with its placeholder count) such that none exceeds `maxParams`. */
function chunkByParams(rows: readonly PreparedRow[], maxParams: number, extra: number): number[] {
  const sizes: number[] = [];
  let size = 0;
  let params = extra;
  for (const row of rows) {
    if (size > 0 && params + row.params > maxParams) {
      sizes.push(size);
      size = 0;
      params = extra;
    }
    size++;
    params += row.params;
  }
  if (size > 0) sizes.push(size);
  return sizes;
}

/**
 * Checks the `placeholders` option against the named parameters the statement uses: every
 * one used needs a value, and every value given must be used.
 *
 * @throws QueryError otherwise.
 */
function checkPlaceholders(
  placeholders: Readonly<Record<string, unknown>> | undefined,
  used: readonly NamedParamNode[],
): void {
  const names = new Set(used.map((node) => node.name));
  const given = placeholders === undefined ? [] : Object.keys(placeholders);
  const unknown = given.filter((name) => !names.has(name));
  if (unknown.length > 0) {
    throw new QueryError(
      "query.placeholdersUnused",
      `repo.insertAll(): placeholders ${unknown.map((name) => `"${name}"`).join(", ")} ${unknown.length > 1 ? "are" : "is"} not used by any row; ${names.size === 0 ? "the rows use none" : `the rows use ${[...names].map((name) => `"${name}"`).join(", ")}`}.`,
      { params: { unknown: unknown[0] as string } },
    );
  }
  const missing = [...names].filter((name) => own(placeholders, name) === undefined);
  if (missing.length > 0) {
    throw new QueryError(
      "query.placeholdersMissing",
      `repo.insertAll(): the rows use the named parameter${missing.length > 1 ? "s" : ""} ${missing.map((name) => `"${name}"`).join(", ")}.`,
      { params: { name: missing[0] ?? "name" } },
    );
  }
}

/** The named values a plan uses, out of the `placeholders` option. */
function usedPlaceholders(
  plan: CompiledQuery,
  placeholders: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (placeholders === undefined) return undefined;
  const used: Record<string, unknown> = {};
  let any = false;
  for (const slot of plan.slots) {
    if (slot.kind === "named" && hasOwn(placeholders, slot.name)) {
      used[slot.name] = placeholders[slot.name];
      any = true;
    }
  }
  return any ? used : undefined;
}

/** The checked options of insertAll. */
interface InsertAllSettings {
  readonly options: ReadOptions | undefined;
  readonly returning: readonly FieldMeta[] | true | undefined;
  readonly onConflict: OnConflict | undefined;
  readonly conflictParams: readonly unknown[];
  readonly placeholders: Readonly<Record<string, unknown>> | undefined;
}

function insertAllSettings(schemaMeta: SchemaMeta, options: unknown): InsertAllSettings {
  const checked = checkReadOptions<ReadOptions>("insertAll", options, INSERT_ALL_OPTION_KEYS);
  const given = checked as Readonly<Record<string, unknown>> | undefined;
  const conflict = conflictOption(schemaMeta, own(given, "onConflict"), "insertAll");
  const placeholders = own(given, "placeholders");
  if (
    placeholders !== undefined &&
    (typeof placeholders !== "object" || placeholders === null || !isPlainObject(placeholders))
  ) {
    throw new TypeError(
      "repo.insertAll(): placeholders must be an object of named values, such as { now: new Date() }.",
    );
  }
  return {
    options: checked,
    returning: returningOption(schemaMeta, own(given, "returning"), "insertAll"),
    onConflict: conflict.onConflict,
    conflictParams: conflict.params,
    placeholders: placeholders as Readonly<Record<string, unknown>> | undefined,
  };
}

/**
 * `repo.insertAll(Schema, rows | query, options)`.
 *
 * @throws TypeError, QueryError for misuse; ConstraintError and DatabaseError from the database.
 */
export async function insertAll(
  core: ReadCore,
  schema: unknown,
  source: unknown,
  options: unknown,
): Promise<BulkResult<unknown>> {
  if (!isSchema(schema)) {
    throw new TypeError("repo.insertAll() takes a schema class first: repo.insertAll(User, rows).");
  }
  const schemaMeta = meta(schema as AnySchema);
  const table = writeTable(schemaMeta);
  const settings = insertAllSettings(schemaMeta, options);
  const returning: readonly FieldMeta[] =
    settings.returning === undefined
      ? NONE
      : settings.returning === true
        ? schemaMeta.persisted
        : settings.returning;
  const back: Returning = {
    schemaMeta,
    whole: settings.returning === undefined ? undefined : settings.returning === true,
  };
  const databaseSchema = own(settings.options, "schema") ?? schemaMeta.schema ?? core.schema;
  if (isQueryLike(source))
    return insertFromQuery(core, schemaMeta, source.ast, settings, returning, back, databaseSchema);
  if (!Array.isArray(source)) {
    throw new TypeError(
      "repo.insertAll(Schema, rows): rows is an array of objects of field values, or a query (INSERT … SELECT).",
    );
  }
  if (source.length === 0) return { count: 0, rows: back.whole === undefined ? null : [] };

  // The columns: every field a row gives, and every field with a default or a generated value.
  const persisted = schemaMeta.persisted;
  const used: boolean[] = persisted.map(
    (field) => field.default !== undefined || field.autogenerate !== undefined,
  );
  for (let r = 0; r < source.length; r++) {
    const row: unknown = source[r];
    if (typeof row !== "object" || row === null || !isPlainObject(row)) {
      throw new TypeError(`repo.insertAll(): row ${r} is not a plain object of field values.`);
    }
    for (const key of Object.keys(row)) {
      if ((row as Readonly<Record<string, unknown>>)[key] === undefined) continue;
      const field = persistedField(schemaMeta, key, `repo.insertAll(): row ${r}`);
      if (field.writable === "never") {
        throw new QueryError(
          "query.insertAllNeverWritable",
          `repo.insertAll(): row ${r} gives a value for ${schemaMeta.name}.${field.name}, which the database owns (writable: "never").`,
        );
      }
      used[table.positions.get(field) as number] = true;
    }
  }
  const columns: FieldMeta[] = [];
  const positions: number[] = [];
  for (let i = 0; i < persisted.length; i++) {
    const field = persisted[i] as FieldMeta;
    if (used[i] === true && field.writable !== "never") {
      columns.push(field);
      positions.push(i);
    }
  }

  // The cells of every row, with its values; one instant for every timestamp of the call.
  const expandLists = !core.adapter.capabilities.arrayParams;
  const defaultInValues = core.adapter.capabilities.defaultInValues;
  const stamps: unknown[] = [];
  const names: NamedParamNode[] = [];
  const prepared: PreparedRow[] = [];
  let plain = true;
  for (let r = 0; r < source.length; r++) {
    const given = source[r] as Readonly<Record<string, unknown>>;
    const cells: InsertCell[] = [];
    const values: unknown[] = [];
    let params = 0;
    for (let c = 0; c < columns.length; c++) {
      const field = columns[c] as FieldMeta;
      const index = positions[c] as number;
      let value = hasOwn(given, field.name) ? given[field.name] : undefined;
      if (value === undefined) {
        const fallback = field.default;
        if (fallback !== undefined) value = fallback.kind === "value" ? fallback.value : fallback.fn();
        else if (field.autogenerate !== undefined) value = generate(table.shares, field, index, stamps);
      }
      if (value === undefined) {
        if (!defaultInValues) throw raggedRows(core.adapter.dialect, schemaMeta, r, field, columns);
        cells.push(DEFAULT_CELL);
        plain = false;
        continue;
      }
      params += pushCell(value, field, cells, values, names, expandLists);
      if (cells[cells.length - 1] !== VALUE_CELL) plain = false;
    }
    prepared.push({ cells, values, params });
  }
  checkPlaceholders(settings.placeholders, names);

  const maxParams = core.adapter.capabilities.maxParams;
  const extra = settings.conflictParams.length;
  const sizes = plain
    ? insertChunks(prepared.length, columns.length, maxParams - extra)
    : chunkByParams(prepared, maxParams, extra);
  const deadline = sizes.length > 1 ? deadlineOf(settings.options) : undefined;
  const run = async (executor: Executor): Promise<BulkResult<unknown>> => {
    let count = 0;
    const rows: unknown[] | null = back.whole === undefined ? null : [];
    let start = 0;
    for (const size of sizes) {
      const chunk = prepared.slice(start, start + size);
      start += size;
      const insertSource: InsertSource = plain
        ? { kind: "values", rows: size }
        : { kind: "cells", rows: chunk.map((row) => row.cells) };
      const plan = core.adapter.compileInsert(
        schemaMeta,
        columns,
        { source: insertSource, returning, onConflict: settings.onConflict },
        databaseSchema,
      );
      const values: unknown[] = [];
      for (const row of chunk) for (const value of row.values) values.push(value);
      for (const value of settings.conflictParams) values.push(value);
      let bound: unknown[];
      try {
        bound = bindParams(plan.slots, values, usedPlaceholders(plan, settings.placeholders));
      } catch (error) {
        throw fieldOfRefusal(error, (index) => cellFieldAt(schemaMeta, columns, chunk, index));
      }
      const done = await runWrite(
        core,
        executor,
        "insertAll",
        schemaMeta.source as string,
        plan,
        bound,
        settings.options,
        deadline,
        decodeInserted,
        back,
      );
      count += done.count;
      if (rows !== null && done.rows !== null) for (const row of done.rows) rows.push(row);
    }
    return { count, rows };
  };
  return sizes.length > 1 ? atomically(core, settings.options, deadline, run) : run(core.executor);
}

/**
 * The error for rows of different fields on a database that cannot write `DEFAULT` in a
 * `VALUES` list (`capabilities.defaultInValues`): the rows cannot share one statement,
 * and splitting them would be a different statement per row. Names the row, the fields it
 * lacks and the fields the call writes, never a value.
 */
function raggedRows(
  dialect: string,
  schemaMeta: SchemaMeta,
  row: number,
  field: FieldMeta,
  columns: readonly FieldMeta[],
): QueryError {
  return new QueryError(
    "query.insertAllMixedColumns",
    `repo.insertAll(): row ${row} has no value for ${schemaMeta.name}.${field.name}, which other rows give (they give ${columns.map((column) => column.name).join(", ")}), and ${dialect} cannot write DEFAULT in a VALUES list.`,
  );
}

/**
 * The value of a generated field for one row. A timestamp is generated once per call and
 * shared by every row and by the timestamps of the same generator (`createdAt` and
 * `updatedAt`); anything else (a uuid) is generated per row.
 */
function generate(shares: readonly number[], field: FieldMeta, index: number, stamps: unknown[]): unknown {
  const generator = (field.autogenerate as NonNullable<FieldMeta["autogenerate"]>).fn;
  const kind = field.type.db.kind;
  if (kind !== "timestamp" && kind !== "timestamptz") return generator();
  const share = shares[index] as number;
  if (stamps[share] === undefined) stamps[share] = generator();
  return stamps[share];
}

// The field a refused value was written to (owner row 7, status 03). These run only when
// binding failed, so counting a node's values again costs nothing on the path that binds.

/** How many values `node` binds. */
function valueCount(node: QueryNode): number {
  const out: unknown[] = [];
  collectParams(node, out);
  return out.length;
}

/** How many values `nodes` bind. */
function valueCountAll(nodes: readonly QueryNode[]): number {
  let count = 0;
  for (const node of nodes) count += valueCount(node);
  return count;
}

/** The field of `insertAll` rows whose cell holds entry `index` of the chunk's values. */
function cellFieldAt(
  schemaMeta: SchemaMeta,
  columns: readonly FieldMeta[],
  chunk: readonly PreparedRow[],
  index: number,
): string | undefined {
  let at = 0;
  for (const row of chunk) {
    for (let c = 0; c < row.cells.length; c++) {
      const cell = row.cells[c] as InsertCell;
      const count = cell === VALUE_CELL ? 1 : cell.kind === "expr" ? valueCount(cell.expr) : 0;
      if (index < at + count) return `${schemaMeta.name}.${(columns[c] as FieldMeta).name}`;
      at += count;
    }
  }
  return undefined;
}

/**
 * The field of `insertAll(Schema, query)` whose selected expression holds entry `index` of
 * the source query's values: the select's values come after those of the source, the joins
 * and the conditions (the canonical order of `collectParams`).
 */
function selectedFieldAt(
  schemaMeta: SchemaMeta,
  source: QueryAst,
  columns: readonly FieldMeta[],
  index: number,
): string | undefined {
  // insertFromQuery has checked that the select is an object of expressions, one per column.
  const shape = (source.select as SelectNode).shape as Extract<SelectShape, { readonly kind: "object" }>;
  let at = valueCount(source.from) + valueCountAll(source.joins) + valueCountAll(source.wheres);
  for (let i = 0; i < shape.values.length; i++) {
    const count = valueCount((shape.values[i] as Extract<SelectShape, { readonly kind: "expr" }>).expr);
    if (index >= at && index < at + count) return `${schemaMeta.name}.${(columns[i] as FieldMeta).name}`;
    at += count;
  }
  return undefined;
}

/**
 * The field of `updateAll` whose `set` value holds entry `index` of the query's values: the
 * set values come last (an update takes no hints; the canonical order of `collectParams`).
 */
function setFieldAt(ast: QueryAst, index: number): string | undefined {
  // The plan was made, so the root is a table (the compiler refuses any other).
  const from = ast.from as TableSourceNode;
  const table = from.meta === undefined ? from.source : from.meta.name;
  let at = ast.params.length - valueCountAll(ast.updates);
  for (const update of ast.updates) {
    const count = valueCount(update.value);
    if (index >= at && index < at + count) return `${table}.${update.field}`;
    at += count;
  }
  return undefined;
}

/** The typed copies of source queries, per query AST: a query is rewritten once. */
const typedSources = /* @__PURE__ */ new WeakMap<QueryAst, QueryAst>();

/**
 * The source query of `INSERT … SELECT` with each selected `CASE` or `coalesce` of bound
 * values and `NULL`s cast to its target field's type (option A, as for the cells of
 * `insertAll` and for `set`); the query itself when none needs it. The copy has its
 * `params`, `listLengths` and `shape` recomputed, as the AST contract asks of hand-built
 * queries.
 */
function typedSelect(
  ast: QueryAst,
  shape: Extract<SelectShape, { readonly kind: "object" }>,
  columns: readonly FieldMeta[],
): QueryAst {
  if (!shape.values.some((value) => value.kind === "expr" && needsFieldType(value.expr))) return ast;
  const cached = typedSources.get(ast);
  if (cached !== undefined) return cached;
  const values: SelectShape[] = shape.values.map((value, i) => {
    if (value.kind !== "expr" || !needsFieldType(value.expr)) return value;
    const type = (columns[i] as FieldMeta).type;
    return { kind: "expr", expr: castNode(value.expr, type), type };
  });
  const select: SelectNode = {
    kind: "select",
    shape: { kind: "object", keys: shape.keys, values },
    constants: (ast.select as SelectNode).constants,
  };
  const draft: QueryAst = { ...ast, select, params: NONE, listLengths: NONE, shape: 0 };
  const params: unknown[] = [];
  const lists: number[] = [];
  collectParams(draft, params, lists);
  const typed: QueryAst = { ...draft, params, listLengths: lists, shape: shapeOf(draft) };
  typedSources.set(ast, typed);
  return typed;
}

/** `INSERT INTO table (fields of the select) SELECT …`. */
async function insertFromQuery(
  core: ReadCore,
  schemaMeta: SchemaMeta,
  ast: QueryAst,
  settings: InsertAllSettings,
  returning: readonly FieldMeta[],
  back: Returning,
  databaseSchema: string | undefined,
): Promise<BulkResult<unknown>> {
  const shape = ast.select?.shape;
  if (shape === undefined || shape.kind !== "object") {
    throw new QueryError(
      "query.insertAllQuerySelect",
      `repo.insertAll(${schemaMeta.name}, query): the query must select an object whose keys are the fields to fill.`,
    );
  }
  const columns = shape.keys.map((key, i) => {
    const field = persistedField(
      schemaMeta,
      key,
      `repo.insertAll(${schemaMeta.name}, query): the select's key`,
    );
    if (shape.values[i]?.kind !== "expr") {
      throw new QueryError(
        "query.insertAllSelectValue",
        `repo.insertAll(${schemaMeta.name}, query): the select's "${key}" is not one SQL value (a plain value is kept out of the statement, and a binding is a whole row).`,
      );
    }
    if (field.writable === "never") {
      throw new QueryError(
        "query.insertAllSelectNeverWritable",
        `repo.insertAll(): the query selects ${schemaMeta.name}.${field.name}, which the database owns (writable: "never").`,
      );
    }
    return field;
  });
  const source = typedSelect(ast, shape, columns);
  const plan = core.adapter.compileInsert(
    schemaMeta,
    columns,
    { source: { kind: "query", query: source }, returning, onConflict: settings.onConflict },
    databaseSchema,
  );
  const values: unknown[] = [...source.params, ...settings.conflictParams];
  let bound: unknown[];
  try {
    bound = bindParams(plan.slots, values, settings.placeholders);
  } catch (error) {
    throw fieldOfRefusal(error, (index) => selectedFieldAt(schemaMeta, source, columns, index));
  }
  const done = await runWrite(
    core,
    core.executor,
    "insertAll",
    schemaMeta.source as string,
    plan,
    bound,
    settings.options,
    undefined,
    decodeInserted,
    back,
  );
  return { count: done.count, rows: done.rows };
}

// ---------------------------------------------------------------------------
// updateAll and deleteAll
// ---------------------------------------------------------------------------

function decodeModified(
  result: RawResult,
  plan: CompiledQuery,
  core: ReadCore,
  ast: QueryAst,
): BulkResult<unknown> {
  if (plan.output === undefined) return { count: result.rowCount, rows: null };
  const constants = ast.select === undefined ? NONE : ast.select.constants;
  return {
    count: result.rowCount,
    rows: decodeRows(result.rows, decoderFor(plan, core.adapter, core.codegen), constants),
  };
}

/**
 * `repo.updateAll(query, params?, options?)` and `repo.deleteAll(queryable, params?, options?)`.
 *
 * @throws TypeError, QueryError for misuse (an `updateAll` query without `.set(...)`).
 */
export async function modifyAll(
  core: ReadCore,
  operation: "updateAll" | "deleteAll",
  queryable: unknown,
  args: readonly unknown[],
): Promise<BulkResult<unknown>> {
  if (operation === "updateAll" && isSchema(queryable)) {
    throw new QueryError("query.updateAllArgument", "repo.updateAll() takes a query with .set(...)");
  }
  const input = inputOf(operation, queryable);
  const ast = input.ast;
  if (operation === "updateAll" && ast.updates.length === 0) {
    throw new QueryError("query.updateAllNoSet", "repo.updateAll() needs a query with .set(...)");
  }
  const split: SplitArgs<ReadOptions> = splitArgs<ReadOptions>(
    operation,
    input.names,
    args,
    READ_OPTION_KEYS,
  );
  const options = split.options;
  const schema = own(options, "schema") ?? core.schema;
  // A prepared query keeps its plan; anything else is found in the adapter's plan cache.
  const plan =
    queryable instanceof PreparedQuery
      ? queryable.plan(core.adapter, operation, schema)
      : core.adapter.compile(ast, operation, schema);
  let values: unknown[];
  try {
    values = bindParams(plan.slots, ast.params, split.named);
  } catch (error) {
    throw fieldOfRefusal(error, (index) => setFieldAt(ast, index));
  }
  const source = ast.from.kind === "table" ? ast.from.source : undefined;
  return runWrite(
    core,
    core.executor,
    operation,
    source,
    plan,
    values,
    options,
    undefined,
    decodeModified,
    ast,
  );
}
