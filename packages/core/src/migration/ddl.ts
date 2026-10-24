/**
 * The DDL emitter: one function per migration operation, writing SQL text under the same
 * rules as the query emitter (ADR 0003):
 *
 * - Every identifier is quoted by the dialect's quote function.
 * - Type names come from the compiler's dialect table, or from a `custom` type's `sql`
 *   once it has matched `CUSTOM_SQL_TYPE`.
 * - Keywords, reference actions, index methods and the boolean constants come from the
 *   tables; an index method is looked up and the table's spelling is written.
 * - Fragments are compiled by the adapter; in DDL they may not bind values.
 * - DDL takes no bound parameters, so a column default that is a constant (and the
 *   allowed values of `enumText`) is written by the dialect's literal writer
 *   (`MigrationDialect.stringLiteral`). These constants are program text, from the
 *   migration file.
 * - `m.execute` is the one operation with parameters: its fragment is compiled as any
 *   fragment statement, with its values bound.
 *
 * @module
 */
import { bindParams } from "../compiler/bind.js";
import { quoteIdentifier, type SqlDialect } from "../compiler/dialect.js";
import type { CompiledQuery, ParamSlot } from "../contracts/adapter.js";
import type { FragmentNode } from "../contracts/query.js";
import { CUSTOM_SQL_TYPE } from "../contracts/type.js";
import { MigrationError } from "../errors.js";
import { own } from "../internal/own.js";
import { isLiteralText } from "./builder.js";
import type { MigrationDialect } from "./dialect.js";
import type {
  AlterChange,
  ColumnDef,
  ConstraintDef,
  CreateTableOp,
  DefaultSpec,
  ExecuteStatement,
  IndexDef,
  Operation,
  ReferenceSpec,
  TableRef,
  TypeSpec,
} from "./types.js";

/**
 * One statement to run: SQL text, its parameter values (empty for DDL) and their slots
 * (for redaction in telemetry).
 *
 * @example
 * ```ts
 * const statement: MigrationStatement = { sql: 'drop table "users"', params: [], slots: [] };
 * ```
 */
export interface MigrationStatement {
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly slots: readonly ParamSlot[];
}

/**
 * What the emitter writes with.
 *
 * @example
 * ```ts
 * declare const adapter: Adapter;
 * const ctx: DdlContext = {
 *   syntax: postgresDialect,
 *   dialect: POSTGRES_MIGRATION_DIALECT,
 *   compileFragment: (node) => adapter.compileFragment(node),
 * };
 * ```
 */
export interface DdlContext {
  /** The compiler's SQL table: quoting and type names. */
  readonly syntax: SqlDialect;
  /** The migration table: DDL features and keywords. */
  readonly dialect: MigrationDialect;
  /** Compiles a fragment as a statement (the adapter's `compileFragment`). */
  readonly compileFragment: (node: FragmentNode) => CompiledQuery;
}

const NO_PARAMS: readonly unknown[] = /* @__PURE__ */ Object.freeze([]);
const NO_SLOTS: readonly ParamSlot[] = /* @__PURE__ */ Object.freeze([]);

function ddl(sql: string): MigrationStatement {
  return { sql, params: NO_PARAMS, slots: NO_SLOTS };
}

function unsupported(ctx: DdlContext, feature: string): MigrationError {
  return new MigrationError(
    "migration.unsupportedFeature",
    `${feature} is not supported by ${ctx.dialect.name}.`,
    { params: { dialect: ctx.dialect.name } },
  );
}

/**
 * The statements of one operation, in order.
 *
 * @example
 * ```ts
 * const statements = emitOperation(op, { syntax: postgresDialect, dialect: POSTGRES_MIGRATION_DIALECT, compileFragment });
 * ```
 *
 * @throws MigrationError when the operation uses a feature the dialect lacks, or a DDL
 * fragment binds a value.
 */
export function emitOperation(op: Operation, ctx: DdlContext): MigrationStatement[] {
  const q = (name: string): string => quoteIdentifier(ctx.syntax, name);
  switch (op.op) {
    case "createTable":
      return [ddl(createTable(op, ctx))];
    case "dropTable":
      return [
        ddl(
          `drop table ${op.ifExists ? "if exists " : ""}${table(op.table, ctx)}${cascade(op.cascade, ctx)}`,
        ),
      ];
    case "alterTable":
      return op.changes.map((change) => ddl(alter(op.table, change, ctx)));
    case "renameTable":
      return [ddl(`alter table ${table(op.table, ctx)} rename to ${q(op.to)}`)];
    case "createIndex":
      return [ddl(createIndex(op.index, op.ifNotExists, ctx))];
    case "dropIndex": {
      if (op.concurrently && !ctx.dialect.features.concurrentIndexes) {
        throw unsupported(ctx, "DROP INDEX CONCURRENTLY");
      }
      if (op.ifExists && !ctx.dialect.features.indexIfExists) throw unsupported(ctx, "DROP INDEX IF EXISTS");
      // MySQL names the table an index belongs to; the others name the index alone.
      if (ctx.dialect.dropIndexOnTable) return [ddl(`drop index ${q(op.name)} on ${table(op.table, ctx)}`)];
      const name =
        op.table.schema === undefined ? q(op.name) : `${schemaName(op.table.schema, ctx)}.${q(op.name)}`;
      return [
        ddl(`drop index ${op.concurrently ? "concurrently " : ""}${op.ifExists ? "if exists " : ""}${name}`),
      ];
    }
    case "createConstraint":
      if (!ctx.dialect.features.alterConstraints) throw unsupported(ctx, "ALTER TABLE … ADD CONSTRAINT");
      return [
        ddl(
          `alter table ${table(op.table, ctx)} add constraint ${q(op.name)} ${constraint(op.definition, ctx)}`,
        ),
      ];
    case "dropConstraint":
      if (!ctx.dialect.features.alterConstraints) throw unsupported(ctx, "ALTER TABLE … DROP CONSTRAINT");
      if (op.ifExists && !ctx.dialect.features.constraintIfExists) {
        throw unsupported(ctx, "DROP CONSTRAINT IF EXISTS");
      }
      return [
        ddl(
          `alter table ${table(op.table, ctx)} drop constraint ${op.ifExists ? "if exists " : ""}${q(op.name)}`,
        ),
      ];
    case "execute":
      return [execute(op.statement, ctx)];
    case "createSchema":
      return [ddl(`create schema ${op.ifNotExists ? "if not exists " : ""}${schemaName(op.name, ctx)}`)];
    case "dropSchema":
      return [
        ddl(
          `drop schema ${op.ifExists ? "if exists " : ""}${schemaName(op.name, ctx)}${cascade(op.cascade, ctx)}`,
        ),
      ];
    case "createExtension": {
      if (!ctx.dialect.features.extensions) throw unsupported(ctx, "CREATE EXTENSION");
      const schema = op.schema === undefined ? "" : ` schema ${schemaName(op.schema, ctx)}`;
      return [ddl(`create extension ${op.ifNotExists ? "if not exists " : ""}${q(op.name)}${schema}`)];
    }
    case "dropExtension":
      if (!ctx.dialect.features.extensions) throw unsupported(ctx, "DROP EXTENSION");
      return [ddl(`drop extension ${op.ifExists ? "if exists " : ""}${q(op.name)}`)];
  }
}

function schemaName(name: string, ctx: DdlContext): string {
  if (!ctx.dialect.features.schemas) throw unsupported(ctx, "A database schema");
  return quoteIdentifier(ctx.syntax, name);
}

/**
 * A table name, qualified by its database schema when it has one.
 *
 * @example
 * ```ts
 * table({ name: "users", schema: "auth" }, ctx); // '"auth"."users"'
 * ```
 */
export function table(ref: TableRef, ctx: DdlContext): string {
  const name = quoteIdentifier(ctx.syntax, ref.name);
  return ref.schema === undefined ? name : `${schemaName(ref.schema, ctx)}.${name}`;
}

function cascade(on: boolean, ctx: DdlContext): string {
  if (!on) return "";
  if (!ctx.dialect.features.dropCascade) throw unsupported(ctx, "DROP … CASCADE");
  return " cascade";
}

function createTable(op: CreateTableOp, ctx: DdlContext): string {
  const keys = op.columns.filter((column) => column.primaryKey);
  const parts = op.columns.map((column) => columnDefinition(column, keys.length === 1, ctx));
  if (keys.length > 1) {
    parts.push(`primary key (${keys.map((column) => quoteIdentifier(ctx.syntax, column.name)).join(", ")})`);
  }
  for (const column of op.columns) parts.push(...tableConstraints(column, ctx));
  return `create table ${op.ifNotExists ? "if not exists " : ""}${table(op.table, ctx)} (${parts.join(", ")})`;
}

/**
 * A column's unique constraint and foreign key as constraints of the table, where the
 * dialect takes neither in a column (`columnConstraints: "table"`); none otherwise.
 */
function tableConstraints(column: ColumnDef, ctx: DdlContext): string[] {
  if (ctx.dialect.columnConstraints !== "table") return [];
  const q = (name: string): string => quoteIdentifier(ctx.syntax, name);
  const parts: string[] = [];
  if (column.unique !== undefined) parts.push(`constraint ${q(column.unique)} unique (${q(column.name)})`);
  const ref = column.references;
  if (ref !== undefined) {
    // MySQL's index for the foreign key, made explicit (see MigrationDialect.columnConstraints).
    parts.push(`key ${q(ref.name)} (${q(column.name)})`);
    let sql = `constraint ${q(ref.name)} foreign key (${q(column.name)}) references ${table(ref.table, ctx)} (${q(ref.column)})`;
    if (ref.onDelete !== undefined) sql += ` on delete ${ctx.dialect.referenceActions[ref.onDelete]}`;
    if (ref.onUpdate !== undefined) sql += ` on update ${ctx.dialect.referenceActions[ref.onUpdate]}`;
    parts.push(sql);
  }
  return parts;
}

/**
 * The SQL of a column type.
 *
 * @throws MigrationError for a `custom` type that is not a plain type name.
 *
 * @example
 * ```ts
 * declare const ctx: DdlContext;
 * typeSql({ kind: "timestamptz", precision: 3, scale: undefined, of: undefined, sql: undefined }, false, ctx); // "timestamptz(3)"
 * ```
 */
export function typeSql(type: TypeSpec, serial: boolean, ctx: DdlContext): string {
  const dialect = ctx.dialect;
  switch (type.kind) {
    case "array":
      // A database without array columns stores the array as one value (JSON).
      if (dialect.arrayType !== undefined) return dialect.arrayType;
      return `${typeSql(type.of as TypeSpec, false, ctx)}[]`;
    case "custom":
      if (typeof type.sql !== "string" || !CUSTOM_SQL_TYPE.test(type.sql)) {
        throw new MigrationError(
          "migration.customTypeSql",
          "A custom column type's sql is not a plain type name, so it was not written.",
        );
      }
      return type.sql;
    default: {
      if (serial) return type.kind === "integer" ? dialect.serial.integer : dialect.serial.bigint;
      const name = dialect.columnTypes[type.kind];
      if (!dialect.precision) return name;
      // A partial table: a kind it lacks reads as absent, never from Object.prototype.
      const fallback = own(dialect.defaultPrecision, type.kind);
      const precision = type.precision ?? fallback?.[0];
      if (precision === undefined) return name;
      const scale = type.precision === undefined ? fallback?.[1] : type.scale;
      return scale === undefined ? `${name}(${precision})` : `${name}(${precision}, ${scale})`;
    }
  }
}

/** The precision of a timestamp column, for a "now" default that must match it (MySQL). */
function timePrecision(type: TypeSpec | undefined, ctx: DdlContext): number | undefined {
  if (type === undefined || type.kind === "array" || type.kind === "custom") return undefined;
  return type.precision ?? own(ctx.dialect.defaultPrecision, type.kind)?.[0];
}

/** A default as SQL; `type` is the column's, for a "now" that carries the column's precision. */
function defaultSql(spec: DefaultSpec, ctx: DdlContext, type?: TypeSpec): string {
  switch (spec.kind) {
    case "now": {
      const precision = ctx.dialect.nowWithPrecision ? timePrecision(type, ctx) : undefined;
      return precision === undefined ? ctx.dialect.now : `${ctx.dialect.now}(${precision})`;
    }
    case "sql":
      // In parentheses: a default is a restricted expression in the grammar, a parenthesised one is any.
      return `(${fragmentSql(spec.node, "A column default", ctx)})`;
    default:
      // MySQL takes a constant default for a json column only as an expression.
      return ctx.dialect.parenthesizedDefaults ? `(${literal(spec.value, ctx)})` : literal(spec.value, ctx);
  }
}

/** A constant from the migration's program text, as a SQL literal. */
function literal(value: unknown, ctx: DdlContext): string {
  switch (typeof value) {
    case "string":
      if (!isLiteralText(value)) {
        throw new MigrationError(
          "migration.stringConstant",
          "A string constant in DDL cannot hold a NUL character or a lone surrogate.",
        );
      }
      return ctx.dialect.stringLiteral(value);
    case "number":
      if (!Number.isFinite(value))
        throw new MigrationError("migration.numberConstant", "A number constant in DDL must be finite.");
      return String(value);
    case "bigint":
      return String(value);
    case "boolean":
      return value ? ctx.dialect.booleans.true : ctx.dialect.booleans.false;
    default:
      if (value === null) return "null";
      throw new MigrationError(
        "migration.constantType",
        "A constant in DDL must be a string, a finite number, a bigint, a boolean or null.",
      );
  }
}

/** A DDL fragment's SQL: compiled by the adapter, and refused when it binds a value. */
function fragmentSql(node: FragmentNode, what: string, ctx: DdlContext): string {
  const plan = ctx.compileFragment(node);
  if (plan.slots.length > 0) {
    throw new MigrationError("migration.ddlParams", `${what} cannot bind values: DDL takes no parameters.`);
  }
  return plan.sql;
}

function columnDefinition(column: ColumnDef, inlineKey: boolean, ctx: DdlContext): string {
  const q = (name: string): string => quoteIdentifier(ctx.syntax, name);
  const inline = ctx.dialect.columnConstraints === "inline";
  let sql = `${q(column.name)} ${typeSql(column.type, column.serial, ctx)}`;
  if (column.notNull) sql += " not null";
  if (column.default !== undefined) sql += ` default ${defaultSql(column.default, ctx, column.type)}`;
  if (column.primaryKey && inlineKey) sql += ` primary key${column.serial ? ctx.dialect.serialKey : ""}`;
  else if (column.serial && ctx.dialect.serialKey !== "") {
    throw new MigrationError(
      "migration.generatedKeyAlone",
      `The generated key "${column.name}" must be the table's only key column on ${ctx.dialect.name}.`,
    );
  }
  if (column.unique !== undefined && inline) sql += ` constraint ${q(column.unique)} unique`;
  if (column.check !== undefined) {
    const values = column.check.values.map((value) => literal(value, ctx)).join(", ");
    sql += ` constraint ${q(column.check.name)} check (${q(column.name)} in (${values}))`;
  }
  if (column.references !== undefined && inline) sql += references(column.references, ctx);
  return sql;
}

function references(ref: ReferenceSpec, ctx: DdlContext): string {
  const q = (name: string): string => quoteIdentifier(ctx.syntax, name);
  let sql = ` constraint ${q(ref.name)} references ${table(ref.table, ctx)} (${q(ref.column)})`;
  if (ref.onDelete !== undefined) sql += ` on delete ${ctx.dialect.referenceActions[ref.onDelete]}`;
  if (ref.onUpdate !== undefined) sql += ` on update ${ctx.dialect.referenceActions[ref.onUpdate]}`;
  return sql;
}

function alter(ref: TableRef, change: AlterChange, ctx: DdlContext): string {
  const q = (name: string): string => quoteIdentifier(ctx.syntax, name);
  const head = `alter table ${table(ref, ctx)}`;
  switch (change.change) {
    case "add": {
      // A key column added to an existing table is that table's whole key.
      const added = `${head} add column ${columnDefinition(change.column, true, ctx)}`;
      const constraints = tableConstraints(change.column, ctx);
      return constraints.length === 0
        ? added
        : `${added}, ${constraints.map((each) => `add ${each}`).join(", ")}`;
    }
    case "remove":
      return `${head} drop column ${q(change.column)}`;
    case "rename":
      return `${head} rename column ${q(change.column)} to ${q(change.to)}`;
    case "modify": {
      const style = ctx.dialect.features.modifyColumn;
      if (style === "none") throw unsupported(ctx, "Changing a column (ALTER COLUMN)");
      if (style === "modify") {
        // MODIFY COLUMN writes the whole column: what is not given would be lost.
        if (change.notNull === undefined || change.default === undefined) {
          throw new MigrationError(
            "migration.modifyWhole",
            `${ctx.dialect.name} changes a column by writing it whole (MODIFY COLUMN), and modify() of "${change.column}" does not give both notNull and default.`,
            { params: { column: change.column } },
          );
        }
        let sql = `${head} modify column ${q(change.column)} ${typeSql(change.type, false, ctx)} ${change.notNull ? "not null" : "null"}`;
        if (change.default !== null) sql += ` default ${defaultSql(change.default, ctx, change.type)}`;
        return sql;
      }
      const column = `alter column ${q(change.column)}`;
      const actions = [`${column} type ${typeSql(change.type, false, ctx)}`];
      if (change.notNull !== undefined) actions.push(`${column} ${change.notNull ? "set" : "drop"} not null`);
      if (change.default === null) actions.push(`${column} drop default`);
      else if (change.default !== undefined)
        actions.push(`${column} set default ${defaultSql(change.default, ctx, change.type)}`);
      return `${head} ${actions.join(", ")}`;
    }
  }
}

function indexMethod(using: string, ctx: DdlContext): string {
  const method = ctx.dialect.features.indexMethods.find((name) => name === using.toLowerCase());
  if (method === undefined) {
    throw new MigrationError(
      "migration.indexMethod",
      `The index method "${using}" is not one ${ctx.dialect.name} has; it has ${ctx.dialect.features.indexMethods.join(", ")}.`,
    );
  }
  return method;
}

function createIndex(index: IndexDef, ifNotExists: boolean, ctx: DdlContext): string {
  const q = (name: string): string => quoteIdentifier(ctx.syntax, name);
  const features = ctx.dialect.features;
  if (index.concurrently && !features.concurrentIndexes) throw unsupported(ctx, "CREATE INDEX CONCURRENTLY");
  if (ifNotExists && !features.indexIfExists) throw unsupported(ctx, "CREATE INDEX IF NOT EXISTS");
  let sql = `create ${index.unique ? "unique " : ""}index ${index.concurrently ? "concurrently " : ""}`;
  sql += `${ifNotExists ? "if not exists " : ""}${q(index.name)} on ${table(index.table, ctx)}`;
  if (index.using !== undefined) sql += ` using ${indexMethod(index.using, ctx)}`;
  const columns = index.columns.map((column) =>
    typeof column === "string" ? q(column) : `(${fragmentSql(column, "An index expression", ctx)})`,
  );
  sql += ` (${columns.join(", ")})`;
  if (index.include.length > 0) {
    if (!features.includeColumns) throw unsupported(ctx, "An index with INCLUDE columns");
    sql += ` include (${index.include.map(q).join(", ")})`;
  }
  if (index.where !== undefined) {
    if (!features.partialIndexes) throw unsupported(ctx, "A partial index (WHERE)");
    sql += ` where ${fragmentSql(index.where, "An index predicate", ctx)}`;
  }
  return sql;
}

function constraint(definition: ConstraintDef, ctx: DdlContext): string {
  if (definition.kind === "check") {
    return `check (${fragmentSql(definition.expression, "A check constraint", ctx)})`;
  }
  if (!ctx.dialect.features.exclusionConstraints) throw unsupported(ctx, "An exclusion constraint");
  const using = indexMethod(definition.using ?? "gist", ctx);
  return `exclude using ${using} (${fragmentSql(definition.expression, "An exclusion constraint", ctx)})`;
}

function execute(statement: ExecuteStatement, ctx: DdlContext): MigrationStatement {
  const plan = ctx.compileFragment(statement.node);
  return { sql: plan.sql, params: bindParams(plan.slots, statement.params), slots: plan.slots };
}
