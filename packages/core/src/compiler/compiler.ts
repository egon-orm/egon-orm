/**
 * The compiler of one adapter instance: the `compile*` methods of the `Adapter` contract,
 * over one dialect table, with their plan cache.
 *
 * @module
 */
import type {
  CompiledQuery,
  ExplainOptions,
  InsertCell,
  InsertPlanOptions,
  OnConflict,
} from "../contracts/adapter.js";
import type { FragmentNode, QueryAst, QueryNode, QueryOperation } from "../contracts/query.js";
import type { FieldMeta, SchemaMeta } from "../contracts/schema.js";
import { QueryError } from "../errors.js";
import { own } from "../internal/own.js";
import { collectParams, shapeOf } from "../query/ast.js";
import { PlanCache, type PlanCacheStats } from "./cache.js";
import type { SqlDialect } from "./dialect.js";
import {
  type CodecSource,
  type EmitContext,
  emitFragmentStatement,
  emitStatement,
  finish,
  newContext,
} from "./emit.js";
import { checkFields, emitDelete, emitInsert, emitUpdate, type WrittenWrite } from "./write.js";

/**
 * Options of {@link createCompiler}.
 *
 * @example
 * ```ts
 * const options: CompilerOptions = { planCacheSize: 500, codecs: adapter };
 * ```
 */
export interface CompilerOptions {
  /** How many query shapes (and, separately, row-level write plans) to keep. Default 1,000. */
  readonly planCacheSize?: number;
  /** Where the driver conversions of a type come from (the adapter's `typeOverrides`). Default: the types' own. */
  readonly codecs?: CodecSource;
  /** Internal, for tests: the L2 cache key of a query or fragment (a constant forces collisions). */
  readonly keyOf?: (node: QueryNode) => number;
}

const OWN_CONVERSIONS: CodecSource = /* @__PURE__ */ Object.freeze({ typeOverrides: () => undefined });

/** Numbers each schema's metadata for the write-plan keys; the numbers never reach SQL. */
const metaIds = /* @__PURE__ */ new WeakMap<SchemaMeta, number>();
let nextMetaId = 1;

function metaId(meta: SchemaMeta): number {
  let id = metaIds.get(meta);
  if (id === undefined) {
    id = nextMetaId++;
    metaIds.set(meta, id);
  }
  return id;
}

/**
 * Compiles queries and row-level writes to SQL for one dialect, and caches the plans. One
 * instance belongs to one adapter instance (its `planCacheSize` option sizes the cache).
 *
 * Every method returns a {@link CompiledQuery} with no values in it: bind the values of an
 * execution with `bindParams(plan.slots, params, named)`.
 *
 * @example
 * ```ts
 * const compiler = createCompiler(postgresDialect, { planCacheSize: 1000, codecs: adapter });
 * const plan = compiler.compile(from(User, "u").where(({ u }) => u.age.gte(18)).ast, "all", undefined);
 * plan.sql; // 'select "u"."id" as "c0", … from "users" as "u" where "u"."age" >= $1'
 * ```
 */
export class Compiler {
  /** The dialect table the compiler writes for. */
  readonly dialect: SqlDialect;
  readonly #codecs: CodecSource;
  readonly #cache: PlanCache;
  /** The dialect expands lists (`IN (?, ?, …)`): list lengths are part of every key. */
  readonly #expands: boolean;
  readonly #explained = new WeakMap<CompiledQuery, Map<string, CompiledQuery>>();

  /**
   * @param dialect The dialect table.
   * @param options Cache size and type conversions.
   * @throws RangeError when `planCacheSize` is not a positive integer.
   */
  constructor(dialect: SqlDialect, options?: CompilerOptions) {
    this.dialect = dialect;
    this.#codecs = own(options, "codecs") ?? OWN_CONVERSIONS;
    this.#expands = !dialect.capabilities.arrayParams;
    this.#cache = new PlanCache({
      capacity: own(options, "planCacheSize") ?? 1000,
      keyLists: !dialect.capabilities.arrayParams,
      keyOf: own(options, "keyOf"),
    });
  }

  /**
   * Compiles a query as a `SELECT` (`"all"`), an `UPDATE` (`"updateAll"`) or a `DELETE`
   * (`"deleteAll"`). `schema` is the per-call or repo-level database schema, the weakest
   * position in the resolution order. Slots refer to `ast.params`.
   *
   * @example
   * ```ts
   * compiler.compile(query.ast, "all", undefined);
   * ```
   *
   * @throws QueryError when the query is invalid or uses a feature the dialect lacks.
   */
  compile(ast: QueryAst, operation: QueryOperation, schema: string | undefined): CompiledQuery {
    const cached = this.#cache.get(ast, operation, schema, ast.shape, ast.listLengths);
    if (cached !== undefined) return cached;
    const ctx = newContext(this.dialect, this.#codecs);
    const written = emitStatement(ctx, ast, operation, schema);
    const plan = finish(ctx, written.sql, written.output, written.rootSchema);
    this.#cache.set(ast, operation, schema, ast.shape, ast.listLengths, plan);
    return plan;
  }

  /**
   * Compiles the statement that asks the database for the plan of a query
   * (`EXPLAIN …`). Its slots are the query's; `output` is `undefined`.
   *
   * @example
   * ```ts
   * compiler.compileExplain(query.ast, "all", undefined, { analyze: true, format: "json" });
   * ```
   *
   * @throws QueryError for an option the dialect lacks, or as {@link Compiler.compile} does.
   */
  compileExplain(
    ast: QueryAst,
    operation: QueryOperation,
    schema: string | undefined,
    options: ExplainOptions,
  ): CompiledQuery {
    const analyze = own(options, "analyze") ?? false;
    const format = own(options, "format");
    if (typeof analyze !== "boolean")
      throw new QueryError("query.explainAnalyze", "explain's analyze option is true or false.");
    if (format !== undefined && format !== "text" && format !== "json") {
      throw new QueryError("query.explainFormat", 'explain\'s format option is "text" or "json".');
    }
    const key = `${analyze ? "a" : ""}:${format ?? ""}`;
    const base = this.compile(ast, operation, schema);
    let byOptions = this.#explained.get(base);
    const found = byOptions?.get(key);
    if (found !== undefined) return found;
    const parts: string[] = [];
    if (analyze) {
      if (!this.dialect.capabilities.explainOptions)
        throw new QueryError(
          "query.explainAnalyzeUnsupported",
          `explain's analyze option is not supported by ${this.dialect.name}.`,
          { params: { dialect: this.dialect.name } },
        );
      parts.push("analyze");
    }
    if (format !== undefined) {
      if (!this.dialect.capabilities.explainOptions)
        throw new QueryError(
          "query.explainFormatUnsupported",
          `explain's format option is not supported by ${this.dialect.name}.`,
          { params: { dialect: this.dialect.name } },
        );
      parts.push(`format ${format}`);
    }
    let prefix: string;
    switch (this.dialect.explain) {
      case "keywords":
        // MySQL: `explain format=json …` and `explain analyze …`; its text format is the
        // tree. MySQL 8.4 runs `explain analyze` in the tree format only.
        if (analyze && format === "json") {
          throw new QueryError(
            "query.explainAnalyzeJson",
            `explain with both analyze and format "json" is not supported by ${this.dialect.name}.`,
            { params: { dialect: this.dialect.name } },
          );
        }
        prefix = `explain ${analyze ? "analyze " : ""}${format === undefined ? "" : `format=${format === "json" ? "json" : "tree"} `}`;
        break;
      case "queryPlan":
        prefix = "explain query plan ";
        break;
      default:
        prefix = `explain ${parts.length === 0 ? "" : `(${parts.join(", ")}) `}`;
    }
    const plan: CompiledQuery = {
      sql: `${prefix}${base.sql}`,
      slots: base.slots,
      output: undefined,
      schema: base.schema,
      decoder: undefined,
    };
    if (byOptions === undefined) {
      byOptions = new Map();
      this.#explained.set(base, byOptions);
    }
    byOptions.set(key, plan);
    return plan;
  }

  /**
   * Compiles a bare fragment as a whole statement (what `repo.raw` runs). Slots refer to
   * the values of its parameter nodes in canonical order (`collectParams(fragment)`).
   *
   * @example
   * ```ts
   * compiler.compileFragment(fragment`select now() as now`.node);
   * ```
   *
   * @throws QueryError when the node is not a fragment or refers to a binding.
   */
  compileFragment(node: FragmentNode): CompiledQuery {
    if (typeof node !== "object" || node === null || node.kind !== "fragment") {
      throw new QueryError("query.compileFragmentArgument", "compileFragment() takes a fragment.");
    }
    const shape = shapeOf(node);
    // A query nested in the fragment may hold lists; where they are expanded, their
    // lengths are part of the SQL and so of the key.
    const lengths = this.#expands ? listLengthsOf([node]) : LIST_LENGTHS_UNUSED;
    const cached = this.#cache.get(node, "fragment", undefined, shape, lengths);
    if (cached !== undefined) return cached;
    const ctx = newContext(this.dialect, this.#codecs);
    const plan = finish(ctx, emitFragmentStatement(ctx, node), undefined, undefined);
    this.#cache.set(node, "fragment", undefined, shape, lengths, plan);
    return plan;
  }

  /**
   * Compiles `INSERT INTO table (columns…) … [ON CONFLICT …] [RETURNING …]`; see
   * `Adapter.compileInsert` for the parameter array it is defined over. `schema` is the
   * table's database schema for this write (it wins over the schema's declared one).
   *
   * @example
   * ```ts
   * const plan = compiler.compileInsert(userMeta, [email, name], {
   *   source: { kind: "values", rows: 1 },
   *   returning: [id],
   *   onConflict: undefined,
   * }, undefined);
   * ```
   *
   * @throws QueryError for an invalid description or a form the dialect lacks.
   */
  compileInsert(
    meta: SchemaMeta,
    columns: readonly FieldMeta[],
    options: InsertPlanOptions,
    schema: string | undefined,
  ): CompiledQuery {
    // Checked on every call, hit or miss (see compileUpdate).
    checkInsertFields(meta, columns, options);
    const nodes: QueryNode[] = [];
    let key = `i${metaId(meta)}|${schemaKey(schema)}|${fieldsKey(columns)}|${fieldsKey(options.returning)}|`;
    const source = options.source;
    if (source?.kind === "values") key += `v${source.rows}`;
    else if (source?.kind === "cells") key += cellsKey(source.rows, nodes);
    else if (source?.kind === "query") {
      key += `q${source.query.shape}`;
      nodes.push(source.query);
    } else throw new QueryError("query.astInsertSource", "An insert's source is values, cells or a query.");
    key += `|${conflictKey(own(options, "onConflict"), nodes)}`;
    // Where lists are expanded, the lengths of the lists in the AST parts are part of the SQL.
    if (this.#expands && nodes.length > 0) key += `|l${listLengthsOf(nodes).join(",")}`;
    const cached = this.#cache.getWrite(key, nodes);
    if (cached !== undefined) return cached;
    const ctx = newContext(this.dialect, this.#codecs);
    return this.#store(key, nodes, ctx, emitInsert(ctx, meta, columns, options, schema));
  }

  /**
   * Compiles `UPDATE table SET set… WHERE where… [RETURNING …]`. Slots refer to the `set`
   * values followed by the `where` values.
   *
   * @example
   * ```ts
   * compiler.compileUpdate(userMeta, [name], [id], [], undefined);
   * ```
   *
   * @throws QueryError when `set` or `where` is empty, or a field does not belong to `meta`.
   */
  compileUpdate(
    meta: SchemaMeta,
    set: readonly FieldMeta[],
    where: readonly FieldMeta[],
    returning: readonly FieldMeta[],
    schema: string | undefined,
  ): CompiledQuery {
    // The fields are checked on every call, hit or miss: the key holds their positions,
    // and a field of another schema at the same position must not find this plan.
    checkFields(meta, set, "The update's set list");
    checkFields(meta, where, "The update's where list");
    checkFields(meta, returning, "The returning list");
    const key = `u${metaId(meta)}|${schemaKey(schema)}|${fieldsKey(set)}|${fieldsKey(where)}|${fieldsKey(returning)}`;
    const cached = this.#cache.getWrite(key, NO_NODES);
    if (cached !== undefined) return cached;
    const ctx = newContext(this.dialect, this.#codecs);
    return this.#store(key, NO_NODES, ctx, emitUpdate(ctx, meta, set, where, returning, schema));
  }

  /**
   * Compiles `DELETE FROM table WHERE where… [RETURNING …]`. Slots refer to the `where` values.
   *
   * @example
   * ```ts
   * compiler.compileDelete(userMeta, [id], [], undefined);
   * ```
   *
   * @throws QueryError when `where` is empty, or a field does not belong to `meta`.
   */
  compileDelete(
    meta: SchemaMeta,
    where: readonly FieldMeta[],
    returning: readonly FieldMeta[],
    schema: string | undefined,
  ): CompiledQuery {
    checkFields(meta, where, "The delete's where list");
    checkFields(meta, returning, "The returning list");
    const key = `d${metaId(meta)}|${schemaKey(schema)}|${fieldsKey(where)}|${fieldsKey(returning)}`;
    const cached = this.#cache.getWrite(key, NO_NODES);
    if (cached !== undefined) return cached;
    const ctx = newContext(this.dialect, this.#codecs);
    return this.#store(key, NO_NODES, ctx, emitDelete(ctx, meta, where, returning, schema));
  }

  /**
   * The plan cache's counters: hits, misses, collisions and size.
   *
   * @example
   * ```ts
   * compiler.stats().collisions; // 0
   * ```
   */
  stats(): PlanCacheStats {
    return this.#cache.stats();
  }

  /**
   * Drops every cached plan. The counters are kept.
   *
   * @example
   * ```ts
   * compiler.clearCache();
   * ```
   */
  clearCache(): void {
    this.#cache.clear();
  }

  #store(key: string, nodes: readonly QueryNode[], ctx: EmitContext, written: WrittenWrite): CompiledQuery {
    const plan = finish(ctx, written.sql, written.output, written.schema);
    this.#cache.setWrite(key, nodes, plan);
    return plan;
  }
}

/** The field lists of an insert, checked on every call (their positions are part of the key). */
function checkInsertFields(
  meta: SchemaMeta,
  columns: readonly FieldMeta[],
  options: InsertPlanOptions,
): void {
  checkFields(meta, columns, "The insert's column list");
  checkFields(meta, options.returning, "The returning list");
  const conflict = own(options, "onConflict");
  if (typeof conflict !== "object" || conflict === null) return;
  const target = own(conflict, "target");
  if (Array.isArray(target)) checkFields(meta, target as readonly FieldMeta[], "onConflict's target");
  const update = own(conflict, "update");
  if (Array.isArray(update)) checkFields(meta, update as readonly FieldMeta[], "onConflict's update list");
  const except = exceptOf(update);
  if (except !== undefined) checkFields(meta, except, "onConflict's except list");
}

function exceptOf(update: unknown): readonly FieldMeta[] | undefined {
  if (typeof update !== "object" || update === null || Array.isArray(update)) return undefined;
  const except = own(update as { readonly except?: unknown }, "except");
  return Array.isArray(except) ? (except as readonly FieldMeta[]) : undefined;
}

const LIST_LENGTHS_UNUSED: readonly number[] = /* @__PURE__ */ Object.freeze([]);

/** The lengths of every list in `nodes`, in canonical order. */
function listLengthsOf(nodes: readonly QueryNode[]): number[] {
  const lengths: number[] = [];
  for (const node of nodes) {
    if (node.kind === "query") for (const length of node.listLengths) lengths.push(length);
    else collectParams(node, [], lengths);
  }
  return lengths;
}
const NO_NODES: readonly QueryNode[] = /* @__PURE__ */ Object.freeze([]);

function schemaKey(schema: string | undefined): string {
  return schema === undefined ? "-" : JSON.stringify(schema);
}

function fieldsKey(fields: readonly FieldMeta[]): string {
  let key = "";
  for (let i = 0; i < fields.length; i++) key += `${i > 0 ? "," : ""}${(fields[i] as FieldMeta).index}`;
  return key;
}

function cellsKey(rows: readonly (readonly InsertCell[])[], nodes: QueryNode[]): string {
  if (!Array.isArray(rows))
    throw new QueryError("query.insertNoRows", "An insert of cells needs at least one row.");
  let key = "c";
  for (const row of rows) {
    key += "(";
    for (const cell of row) {
      switch (cell?.kind) {
        case "value":
          key += "v";
          break;
        case "default":
          key += "d";
          break;
        case "placeholder":
          key += `p${JSON.stringify(cell.name)}`;
          break;
        case "expr":
          key += `e${shapeOf(cell.expr)}`;
          nodes.push(cell.expr);
          break;
        default:
          key += "?";
      }
      key += ";";
    }
    key += ")";
  }
  return key;
}

function conflictKey(conflict: OnConflict | undefined, nodes: QueryNode[]): string {
  if (conflict === undefined) return "-";
  if (conflict === "nothing") return "n";
  if (typeof conflict !== "object" || conflict === null) return "?";
  let key = "u";
  const target = own(conflict, "target");
  if (target === undefined) key += "-";
  else if (Array.isArray(target)) key += `f${fieldsKey(target as readonly FieldMeta[])}`;
  else if (Object.hasOwn(target, "kind") && (target as FragmentNode).kind === "fragment") {
    key += `x${shapeOf(target as FragmentNode)}`;
    nodes.push(target as FragmentNode);
  } else if (Object.hasOwn(target, "constraint"))
    key += `c${JSON.stringify((target as { readonly constraint: string }).constraint)}`;
  else key += "?";
  const update = own(conflict, "update");
  if (update === "all") key += ":a";
  else if (Array.isArray(update)) key += `:f${fieldsKey(update as readonly FieldMeta[])}`;
  else {
    const except = exceptOf(update);
    key += except === undefined ? ":?" : `:e${fieldsKey(except)}`;
  }
  return key;
}

/**
 * A compiler for `dialect`.
 *
 * @example
 * ```ts
 * const compiler = createCompiler(postgresDialect, { planCacheSize: 1000, codecs: adapter });
 * ```
 *
 * @throws RangeError when `planCacheSize` is not a positive integer.
 */
export function createCompiler(dialect: SqlDialect, options?: CompilerOptions): Compiler {
  return new Compiler(dialect, options);
}
