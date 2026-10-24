/**
 * Row-level writes: `INSERT`, `UPDATE … WHERE key = …` and `DELETE … WHERE key = …` of
 * one schema's table, as the repo issues them for changesets (`compileInsert`,
 * `compileUpdate`, `compileDelete` of the `Adapter` contract).
 *
 * The table has no alias, columns are written bare (quoted), and the parameter array is
 * the one the contract describes for each method. A row-level write has one table and no
 * query, so its `schema` argument is the table's own database schema, the strongest
 * position: `schema ?? meta.schema`.
 *
 * A query nested in the write (the query of `INSERT … SELECT`, a subquery in an expression
 * cell or in a fragment conflict target) is read as a query compiled with `schema` as its
 * argument: a table of it that has no database schema of its own (from its source, its
 * schema class or its query's `.schema()`) is read from `schema`.
 *
 * @module
 */
import type {
  ConflictTarget,
  ConflictUpdate,
  InsertCell,
  InsertPlanOptions,
  OnConflict,
  OutputPlan,
} from "../contracts/adapter.js";
import type { FragmentNode } from "../contracts/query.js";
import type { FieldMeta, SchemaMeta } from "../contracts/schema.js";
import { QueryError } from "../errors.js";
import { own } from "../internal/own.js";
import { quoteIdentifier, unsupported } from "./dialect.js";
import { type EmitContext, emitLooseExpr, emitLooseQuery, inlineValue, namedValue } from "./emit.js";
import { resolveTableSchema } from "./plan.js";

/**
 * How to split an insert of `rows` rows into statements whose plans can be cached: chunk
 * sizes that are powers of two, largest first, none over the dialect's parameter limit
 * (`maxParams / columns` rows). A plan is cached per exact row count, so with these chunks
 * one column set has at most about log2(limit) + 1 insert plans (17 on Postgres for one
 * column), however many rows are inserted: 1,000 rows of 3 columns are 512 + 256 + 128 +
 * 64 + 32 + 8, six statements over plans that the next insert reuses.
 *
 * @example
 * ```ts
 * insertChunks(13, 2, 65_535); // [8, 4, 1]
 * insertChunks(100, 30_000, 65_535); // [2, 2, …] (two rows of 30,000 columns fit)
 * ```
 *
 * @throws QueryError when `rows` is not a whole number of zero or more, or one row alone
 * has more values than the dialect accepts.
 */
export function insertChunks(rows: number, columns: number, maxParams: number): number[] {
  if (!Number.isSafeInteger(rows) || rows < 0) {
    throw new QueryError("query.insertRowCount", "An insert's row count is a whole number of zero or more.");
  }
  const perRow = Math.max(columns, 1);
  const fit = Math.floor(maxParams / perRow);
  if (fit < 1) {
    throw new QueryError(
      "query.insertRowTooWide",
      `One row of ${columns} values is more than the ${maxParams} parameters a statement may have.`,
      { params: { maxParams } },
    );
  }
  let largest = 1;
  while (largest * 2 <= fit) largest *= 2;
  const chunks: number[] = [];
  let left = rows;
  let size = largest;
  while (left > 0) {
    while (size > left) size /= 2;
    chunks.push(size);
    left -= size;
  }
  return chunks;
}

/**
 * What writing one row-level statement produced.
 *
 * @example
 * ```ts
 * declare const written: WrittenWrite;
 * written.sql; // 'insert into "users" ("email") values ($1) returning "id" as "c0"'
 * ```
 */
export interface WrittenWrite {
  readonly sql: string;
  readonly output: OutputPlan | undefined;
  /** The database schema the table resolved to. */
  readonly schema: string | undefined;
}

/**
 * Checks that every field belongs to `meta` and is stored in a column.
 *
 * @example
 * ```ts
 * checkFields(userMeta, [emailField], "compileInsert columns");
 * ```
 *
 * @throws QueryError naming the list and the field otherwise.
 */
export function checkFields(meta: SchemaMeta, fields: readonly FieldMeta[], what: string): void {
  for (const field of fields) {
    if (typeof field !== "object" || field === null || meta.fields[field.index] !== field) {
      throw new QueryError(
        "query.writeUnknownField",
        `${what} holds a field that is not a field of ${meta.name}.`,
      );
    }
    if (field.virtual) {
      throw new QueryError(
        "query.writeVirtualField",
        `${what} holds the virtual field ${meta.name}.${field.name}, which has no column.`,
      );
    }
  }
}

function table(
  ctx: EmitContext,
  meta: SchemaMeta,
  schema: string | undefined,
): { sql: string; schema: string | undefined } {
  if (meta.source === null) {
    throw new QueryError(
      "query.writeEmbedded",
      `${meta.name} is an embedded schema: it has no table to write to.`,
    );
  }
  const resolved = resolveTableSchema(schema, meta, undefined);
  const name = quoteIdentifier(ctx.dialect, meta.source);
  return {
    sql: resolved === undefined ? name : `${quoteIdentifier(ctx.dialect, resolved)}.${name}`,
    schema: resolved,
  };
}

function columnList(ctx: EmitContext, fields: readonly FieldMeta[]): string {
  let text = "";
  for (let i = 0; i < fields.length; i++) {
    text += `${i > 0 ? ", " : ""}${quoteIdentifier(ctx.dialect, (fields[i] as FieldMeta).column)}`;
  }
  return text;
}

function returning(
  ctx: EmitContext,
  meta: SchemaMeta,
  fields: readonly FieldMeta[],
): { sql: string; output: OutputPlan | undefined } {
  if (fields.length === 0) return { sql: "", output: undefined };
  checkFields(meta, fields, "The returning list");
  if (!ctx.dialect.capabilities.returning) throw unsupported(ctx.dialect, "RETURNING");
  const keys: string[] = [];
  const values: OutputPlan[] = [];
  let sql = " returning ";
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] as FieldMeta;
    const alias = `c${i}`;
    sql += `${i > 0 ? ", " : ""}${quoteIdentifier(ctx.dialect, field.column)} as ${quoteIdentifier(ctx.dialect, alias)}`;
    keys.push(field.name);
    values.push({ kind: "value", alias, type: field.type });
  }
  return { sql, output: { kind: "object", keys, values } };
}

function equalities(ctx: EmitContext, fields: readonly FieldMeta[]): string {
  let text = "";
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] as FieldMeta;
    text += `${i > 0 ? " and " : ""}${quoteIdentifier(ctx.dialect, field.column)} = ${inlineValue(ctx, field.type, field.redact)}`;
  }
  return text;
}

/**
 * `INSERT INTO table (columns) … [ON CONFLICT …] [RETURNING …]`.
 *
 * @example
 * ```ts
 * emitInsert(ctx, userMeta, [email], { source: { kind: "values", rows: 1 }, returning: [id], onConflict: undefined }, undefined);
 * ```
 *
 * @throws QueryError for an invalid description or a form the dialect lacks.
 */
export function emitInsert(
  ctx: EmitContext,
  meta: SchemaMeta,
  columns: readonly FieldMeta[],
  options: InsertPlanOptions,
  schema: string | undefined,
): WrittenWrite {
  checkFields(meta, columns, "The insert's column list");
  const target = table(ctx, meta, schema);
  let sql = `insert into ${target.sql}`;
  const source = options.source;
  switch (source?.kind) {
    case "values":
      sql += insertValues(ctx, meta, columns, source.rows);
      break;
    case "cells":
      sql += insertCells(ctx, columns, source.rows, schema);
      break;
    case "query":
      if (columns.length === 0)
        throw new QueryError("query.insertQueryColumns", "An insert from a query needs a column list.");
      sql += ` (${columnList(ctx, columns)}) ${emitLooseQuery(ctx, source.query, schema)}`;
      break;
    default:
      throw new QueryError("query.astInsertSource", "An insert's source is values, cells or a query.");
  }
  const conflict = own(options, "onConflict");
  if (conflict !== undefined) {
    sql +=
      ctx.dialect.upsert === "onDuplicateKey"
        ? onDuplicateKey(ctx, meta, columns, conflict, source.kind === "query")
        : onConflict(ctx, meta, columns, conflict, schema);
  }
  const back = returning(ctx, meta, options.returning);
  return { sql: sql + back.sql, output: back.output, schema: target.schema };
}

function insertValues(
  ctx: EmitContext,
  meta: SchemaMeta,
  columns: readonly FieldMeta[],
  rows: number,
): string {
  if (!Number.isSafeInteger(rows) || rows < 1) {
    throw new QueryError(
      "query.insertValuesRows",
      "An insert of values needs a whole number of rows, at least one.",
    );
  }
  if (columns.length === 0) {
    if (rows === 1) {
      if (!ctx.dialect.capabilities.insertDefaultValues)
        throw unsupported(ctx.dialect, "INSERT … DEFAULT VALUES");
      return ctx.dialect.defaultValues;
    }
    // Several rows of defaults: name one column and give it its default in every row.
    if (!ctx.dialect.capabilities.defaultInValues) {
      throw unsupported(ctx.dialect, "DEFAULT in a VALUES list (several rows of defaults)");
    }
    const first = meta.persisted[0];
    if (first === undefined)
      throw new QueryError(
        "query.insertDefaultsNoColumn",
        `${meta.name} has no column to insert defaults into.`,
      );
    let text = ` (${quoteIdentifier(ctx.dialect, first.column)}) values `;
    for (let r = 0; r < rows; r++) text += `${r > 0 ? ", " : ""}(default)`;
    return text;
  }
  let text = ` (${columnList(ctx, columns)}) values `;
  for (let r = 0; r < rows; r++) {
    text += r > 0 ? ", (" : "(";
    for (let c = 0; c < columns.length; c++) {
      const field = columns[c] as FieldMeta;
      text += `${c > 0 ? ", " : ""}${inlineValue(ctx, field.type, field.redact)}`;
    }
    text += ")";
  }
  return text;
}

function insertCells(
  ctx: EmitContext,
  columns: readonly FieldMeta[],
  rows: readonly (readonly InsertCell[])[],
  schema: string | undefined,
): string {
  if (columns.length === 0)
    throw new QueryError("query.insertCellsColumns", "An insert of cells needs a column list.");
  if (!Array.isArray(rows) || rows.length === 0)
    throw new QueryError("query.insertNoRows", "An insert of cells needs at least one row.");
  let text = ` (${columnList(ctx, columns)}) values `;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] as readonly InsertCell[];
    if (row.length !== columns.length) {
      throw new QueryError(
        "query.insertCellsRowLength",
        `Row ${r} of the insert has ${row.length} cells for ${columns.length} columns.`,
      );
    }
    text += r > 0 ? ", (" : "(";
    for (let c = 0; c < row.length; c++) {
      const cell = row[c] as InsertCell;
      const field = columns[c] as FieldMeta;
      if (c > 0) text += ", ";
      switch (cell.kind) {
        case "value":
          text += inlineValue(ctx, field.type, field.redact);
          break;
        case "default":
          if (!ctx.dialect.capabilities.defaultInValues) {
            throw unsupported(ctx.dialect, "DEFAULT in a VALUES list (rows with different fields)");
          }
          text += "default";
          break;
        case "expr":
          text += emitLooseExpr(ctx, cell.expr, schema);
          break;
        case "placeholder":
          text += namedValue(ctx, cell.name, field.type, field.redact);
          break;
        default:
          throw new QueryError(
            "query.astInsertCell",
            `Unknown insert cell kind "${String((cell as { kind: unknown }).kind)}".`,
          );
      }
    }
    text += ")";
  }
  return text;
}

function onConflict(
  ctx: EmitContext,
  meta: SchemaMeta,
  columns: readonly FieldMeta[],
  conflict: OnConflict,
  schema: string | undefined,
): string {
  if (!ctx.dialect.capabilities.onConflict) throw unsupported(ctx.dialect, "onConflict");
  if (conflict === "nothing") return " on conflict do nothing";
  if (typeof conflict !== "object" || conflict === null) {
    throw new QueryError("query.onConflictShape", 'onConflict is "nothing" or { target, update }.');
  }
  let text = " on conflict";
  const target = own(conflict, "target");
  if (target === undefined) {
    if (ctx.dialect.conflictUpdateNeedsTarget) {
      throw new QueryError(
        "query.onConflictTarget",
        `onConflict with update needs a target on ${ctx.dialect.name}.`,
      );
    }
  } else {
    if (!ctx.dialect.capabilities.conflictTarget) throw unsupported(ctx.dialect, "An onConflict target");
    text += conflictTarget(ctx, meta, target, schema);
  }
  const fields = updatedFields(meta, columns, own(conflict, "update") as ConflictUpdate);
  if (fields.length === 0) {
    throw new QueryError("query.onConflictNoUpdate", "onConflict's update leaves no column to update.");
  }
  text += " do update set ";
  for (let i = 0; i < fields.length; i++) {
    const column = quoteIdentifier(ctx.dialect, (fields[i] as FieldMeta).column);
    text += `${i > 0 ? ", " : ""}${column} = ${quoteIdentifier(ctx.dialect, "excluded")}.${column}`;
  }
  return text;
}

/** The name of the row alias that stands for the row an upsert tried to insert, as `excluded` does on the others. */
const EXCLUDED = "excluded";

/**
 * MySQL's upsert: `as excluded on duplicate key update …`. It takes no conflict target:
 * any unique index applies.
 *
 * - `"nothing"` sets the first key column to itself, which changes no row: a conflict is
 *   then reported as no row written.
 * - With `update`, each column takes the value of the row alias `excluded`. When the table
 *   has a single key the database generates, the key is also set to
 *   `last_insert_id(key)`, which makes the result report the key of the row that was
 *   updated (as it does for a row inserted), so that the repo can read that row back.
 */
function onDuplicateKey(
  ctx: EmitContext,
  meta: SchemaMeta,
  columns: readonly FieldMeta[],
  conflict: OnConflict,
  fromQuery: boolean,
): string {
  if (!ctx.dialect.capabilities.onConflict) throw unsupported(ctx.dialect, "onConflict");
  if (conflict === "nothing") {
    const first = meta.primaryKey[0] ?? columns[0] ?? meta.persisted[0];
    if (first === undefined)
      throw new QueryError(
        "query.onConflictNoColumn",
        `${meta.name} has no column to write onConflict with.`,
      );
    const column = quoteIdentifier(ctx.dialect, first.column);
    return ` on duplicate key update ${column} = ${column}`;
  }
  if (typeof conflict !== "object" || conflict === null) {
    throw new QueryError("query.onConflictShape", 'onConflict is "nothing" or { target, update }.');
  }
  if (own(conflict, "target") !== undefined && !ctx.dialect.capabilities.conflictTarget) {
    throw unsupported(ctx.dialect, "An onConflict target");
  }
  if (fromQuery) throw unsupported(ctx.dialect, "onConflict with update on an insert from a query");
  const fields = updatedFields(meta, columns, own(conflict, "update") as ConflictUpdate);
  if (fields.length === 0) {
    throw new QueryError("query.onConflictNoUpdate", "onConflict's update leaves no column to update.");
  }
  const excluded = quoteIdentifier(ctx.dialect, EXCLUDED);
  let text = ` as ${excluded} on duplicate key update `;
  const key = meta.primaryKey.length === 1 ? (meta.primaryKey[0] as FieldMeta) : undefined;
  const kind = key?.type.db.kind;
  if (key?.dbGenerated === true && (kind === "integer" || kind === "bigint") && !fields.includes(key)) {
    const column = quoteIdentifier(ctx.dialect, key.column);
    text += `${column} = last_insert_id(${column}), `;
  }
  for (let i = 0; i < fields.length; i++) {
    const column = quoteIdentifier(ctx.dialect, (fields[i] as FieldMeta).column);
    text += `${i > 0 ? ", " : ""}${column} = ${excluded}.${column}`;
  }
  return text;
}

function conflictTarget(
  ctx: EmitContext,
  meta: SchemaMeta,
  target: ConflictTarget,
  schema: string | undefined,
): string {
  if (Array.isArray(target)) {
    const fields = target as readonly FieldMeta[];
    if (fields.length === 0)
      throw new QueryError("query.onConflictTargetEmpty", "onConflict's target lists no field.");
    checkFields(meta, fields, "onConflict's target");
    return ` (${columnList(ctx, fields)})`;
  }
  const node = target as Exclude<ConflictTarget, readonly FieldMeta[]>;
  if (Object.hasOwn(node, "kind") && (node as FragmentNode).kind === "fragment")
    return ` ${emitLooseExpr(ctx, node as FragmentNode, schema)}`;
  const constraint = own(node as { readonly constraint?: unknown }, "constraint");
  if (typeof constraint === "string" && constraint !== "") {
    if (!ctx.dialect.capabilities.conflictConstraint) {
      throw unsupported(ctx.dialect, "An onConflict target that names a constraint ({ constraint })");
    }
    return ` on constraint ${quoteIdentifier(ctx.dialect, constraint)}`;
  }
  throw new QueryError(
    "query.onConflictTargetShape",
    "onConflict's target is a list of fields, { constraint: name } or a fragment.",
  );
}

function updatedFields(
  meta: SchemaMeta,
  columns: readonly FieldMeta[],
  update: ConflictUpdate,
): readonly FieldMeta[] {
  if (update === "all") return columns;
  if (Array.isArray(update)) {
    const fields = update as readonly FieldMeta[];
    checkFields(meta, fields, "onConflict's update list");
    return fields;
  }
  const except = own(update as { readonly except?: unknown }, "except");
  if (!Array.isArray(except))
    throw new QueryError(
      "query.onConflictUpdate",
      'onConflict\'s update is "all", a list of fields or { except }.',
    );
  checkFields(meta, except as readonly FieldMeta[], "onConflict's except list");
  return columns.filter((field) => !(except as readonly FieldMeta[]).includes(field));
}

/**
 * `UPDATE table SET … WHERE … [RETURNING …]`: the `set` values, then the `where` values.
 *
 * @example
 * ```ts
 * emitUpdate(ctx, userMeta, [name], [id], [], undefined); // 'update "users" set "name" = $1 where "id" = $2'
 * ```
 *
 * @throws QueryError when `set` or `where` is empty, or a field does not belong to `meta`.
 */
export function emitUpdate(
  ctx: EmitContext,
  meta: SchemaMeta,
  set: readonly FieldMeta[],
  where: readonly FieldMeta[],
  back: readonly FieldMeta[],
  schema: string | undefined,
): WrittenWrite {
  checkFields(meta, set, "The update's set list");
  checkFields(meta, where, "The update's where list");
  if (set.length === 0)
    throw new QueryError("query.updateNoSet", "A row update needs at least one field to set.");
  if (where.length === 0)
    throw new QueryError("query.updateNoKey", "A row update needs at least one field to find the row by.");
  const target = table(ctx, meta, schema);
  let sql = `update ${target.sql} set `;
  for (let i = 0; i < set.length; i++) {
    const field = set[i] as FieldMeta;
    sql += `${i > 0 ? ", " : ""}${quoteIdentifier(ctx.dialect, field.column)} = ${inlineValue(ctx, field.type, field.redact)}`;
  }
  sql += ` where ${equalities(ctx, where)}`;
  const written = returning(ctx, meta, back);
  return { sql: sql + written.sql, output: written.output, schema: target.schema };
}

/**
 * `DELETE FROM table WHERE … [RETURNING …]`: the `where` values.
 *
 * @example
 * ```ts
 * emitDelete(ctx, userMeta, [id], [], undefined); // 'delete from "users" where "id" = $1'
 * ```
 *
 * @throws QueryError when `where` is empty, or a field does not belong to `meta`.
 */
export function emitDelete(
  ctx: EmitContext,
  meta: SchemaMeta,
  where: readonly FieldMeta[],
  back: readonly FieldMeta[],
  schema: string | undefined,
): WrittenWrite {
  checkFields(meta, where, "The delete's where list");
  if (where.length === 0)
    throw new QueryError("query.deleteNoKey", "A row delete needs at least one field to find the row by.");
  const target = table(ctx, meta, schema);
  const sql = `delete from ${target.sql} where ${equalities(ctx, where)}`;
  const written = returning(ctx, meta, back);
  return { sql: sql + written.sql, output: written.output, schema: target.schema };
}
