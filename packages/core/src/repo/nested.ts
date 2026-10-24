/**
 * Nested writes: `repo.insert` and `repo.update` of a changeset that holds association
 * changes (`castAssoc`, `putAssoc`). Embed changes need none of this: they are written
 * with the row (`write.ts`).
 *
 * Everything runs atomically (`atomically` of step 16): in a transaction of its own on
 * the pool, in a savepoint inside a transaction. The parent's prepare functions run
 * first, inside it, with the transaction's repo. Then, in this order:
 *
 * 1. `belongsTo` targets, so that their keys can be written into the parent's foreign key;
 * 2. the parent row;
 * 3. `hasOne` / `hasMany` children, their foreign key set from the parent's key: rows
 *    leaving the association first (deleted, or their key set to `null`), then updates,
 *    then inserts; a replaced to-one child before its successor;
 * 4. `manyToMany` targets, and then their join rows: a link removed deletes its join row
 *    only, never the target row.
 *
 * Each child goes through the normal insert, update or delete, so its own nested changes,
 * prepare functions, constraints and optimistic lock apply (its nested writes join this
 * transaction). When a child fails (a declared constraint, a prepare function, a missing
 * field), everything is rolled back and the result is a failure of the parent changeset
 * with the failing child in its place. On success the returned row has each written
 * association loaded with the rows written (rows that left it removed).
 *
 * @module
 */
import { change, rebuild, withAction } from "../changeset/changeset.js";
import type { Relation } from "../changeset/nested/relation.js";
import { indexOfRow, leaves, relationOf } from "../changeset/nested/relation.js";
import { bindParams } from "../compiler/bind.js";
import type { Executor } from "../contracts/adapter.js";
import { failure, type Result, success } from "../contracts/result.js";
import {
  type AnySchema,
  type AssocMeta,
  type FieldMeta,
  ROW,
  type RowMeta,
  type SchemaMeta,
} from "../contracts/schema.js";
import { QueryError } from "../errors.js";
import { own } from "../internal/own.js";
import { t } from "../schema/field.js";
import { meta, Schema } from "../schema/schema.js";
import type { ReadOptions } from "./options.js";
import { keepPreloads } from "./preload.js";
import { ReadCore } from "./read.js";
import { atomically, Level, rootOf } from "./transaction.js";
import {
  type AnyChangeset,
  deadlineOf,
  insert,
  insertRow,
  loadedRow,
  overBudget,
  remaining,
  remove,
  runPrepare,
  runWrite,
  update,
  updateRow,
  type WriteSettings,
} from "./write.js";

type Values = Readonly<Record<string, unknown>>;
const hasOwn = Object.hasOwn;
const NONE: readonly never[] = /* @__PURE__ */ Object.freeze([]);

/** Carries a failed result out of `atomically`, which then rolls back. */
class NestedFailure {
  constructor(readonly result: Result<never, AnyChangeset>) {}
}

/** The executors nested writes opened (or joined): a nested write below one runs on it as it is. */
const joined = /* @__PURE__ */ new WeakSet<object>();

/** The repo the prepare functions of a nested write get: the repo of its transaction. */
function repoOver(repo: unknown, core: ReadCore, executor: Executor): unknown {
  if (!(executor instanceof Level)) return repo;
  const root = rootOf(repo) ?? executor.session.root;
  return root === undefined ? repo : root.makeRepo(core, executor);
}

/**
 * Writes a changeset with association changes, as the module comment describes.
 * `prepared` says whether its prepare functions already ran (they added the association
 * changes); otherwise they run inside the transaction.
 *
 * @throws QueryError for misuse (an upsert with nested changes, an unknown key);
 * StaleEntryError, ConstraintError and DatabaseError as the writes of the rows do.
 */
export async function writeNested(
  core: ReadCore,
  repo: unknown,
  changeset: AnyChangeset,
  schemaMeta: SchemaMeta,
  settings: WriteSettings,
  action: "insert" | "update",
  method: string,
  prepared: boolean,
): Promise<Result<object | null, AnyChangeset>> {
  if (settings.onConflict !== undefined) {
    throw new QueryError(
      "query.onConflictNested",
      `repo.${method}(): onConflict cannot be combined with changes of associations: a row that is not inserted has no children to write.`,
    );
  }
  const deadline = deadlineOf(settings.options);
  const run = new Run(repo, schemaMeta, settings, action, method, deadline);
  if (joined.has(core.executor)) return run.write(core, repo, changeset, prepared);
  try {
    return await atomically(core, settings.options, deadline, async (executor) => {
      const inner =
        executor === core.executor
          ? core
          : new ReadCore(core.adapter, executor, core.schema, core.codegen, core.hub);
      joined.add(executor);
      const result = await run.write(inner, repoOver(repo, inner, executor), changeset, prepared);
      if (!result.success) throw new NestedFailure(result as Result<never, AnyChangeset>);
      return result;
    });
  } catch (error) {
    if (error instanceof NestedFailure) return error.result;
    throw deadline === undefined ? error : overBudget(error, settings.options);
  }
}

/** One nested write: the parent's settings and the call's budget. */
class Run {
  constructor(
    readonly repo: unknown,
    readonly schemaMeta: SchemaMeta,
    readonly settings: WriteSettings,
    readonly action: "insert" | "update",
    readonly method: string,
    readonly deadline: number | undefined,
  ) {}

  /** The options of a child's write: what is left of the budget, the signal, the context, and a database schema for an insert. */
  options(schema: string | undefined): ReadOptions {
    const given = this.settings.options;
    const out: { -readonly [K in keyof ReadOptions]: ReadOptions[K] } = {};
    const timeoutMs = remaining(given, this.deadline);
    if (timeoutMs !== undefined) out.timeoutMs = timeoutMs;
    const signal = own(given, "signal");
    const context = own(given, "context");
    if (signal !== undefined) out.signal = signal;
    if (context !== undefined) out.context = context;
    if (schema !== undefined) out.schema = schema;
    return out;
  }

  /** The settings of the parent's own write, with what is left of the budget. */
  parentSettings(): WriteSettings {
    const given = this.settings.options;
    if (own(given, "timeoutMs") === undefined) return this.settings;
    return { ...this.settings, options: { ...given, timeoutMs: remaining(given, this.deadline) } };
  }

  async write(
    core: ReadCore,
    repo: unknown,
    given: AnyChangeset,
    prepared: boolean,
  ): Promise<Result<object | null, AnyChangeset>> {
    const { schemaMeta, action, method } = this;
    const changeset = prepared ? given : runPrepare(given, action, repo);
    if (!changeset.valid) return failure(changeset);
    const before = action === "update" ? loadedRow(changeset, schemaMeta, method) : null;
    const assocs = schemaMeta.assocs();
    const changes = changeset.changes as Values;
    const fields: Record<string, unknown> = {};
    const nested: [Relation, unknown][] = [];
    for (const key of Object.keys(changes)) {
      if (schemaMeta.fieldsByName.has(key)) {
        fields[key] = changes[key];
        continue;
      }
      if (!assocs.has(key)) {
        throw new QueryError(
          "query.writeUnknownChange",
          `repo.${method}(): the changeset holds a change of "${key}", which is neither a field nor an association of ${schemaMeta.name}.`,
        );
      }
      nested.push([relationOf(changeset, key, "putAssoc", "assoc"), changes[key]]);
    }
    const failWith = (name: string, value: unknown): Result<never, AnyChangeset> =>
      failure(
        rebuild(withAction(changeset, action), { changes: { ...changes, [name]: value }, valid: false }),
      );
    // Where children are inserted: their class's own schema, else the parent's.
    const parentSchema =
      before === null
        ? (own(this.settings.options, "schema") ?? schemaMeta.schema ?? core.schema)
        : (own(this.settings.options, "schema") ??
          (before as unknown as { readonly [ROW]: RowMeta })[ROW].schema);
    const childSchema = (target: SchemaMeta): string | undefined =>
      target.schema !== undefined
        ? undefined
        : schemaMeta.schema === undefined
          ? parentSchema
          : own(this.settings.options, "schema");
    const written = new Map<string, unknown>();

    // 1. belongsTo targets.
    let parent = rebuild(changeset, { changes: fields });
    for (const [relation, value] of nested) {
      if (relation.kind !== "belongsTo") continue;
      const assoc = relation.assoc as AssocMeta;
      if (value === null) {
        for (const name of assoc.ownerKey)
          parent = parent.putChange(name as never, null as never) as AnyChangeset;
        written.set(relation.name, null);
        continue;
      }
      const child = value as AnyChangeset;
      const result = await this.child(core, repo, child, relation, childSchema(relation.targetMeta));
      if (!result.success) return failWith(relation.name, result.error);
      const row = result.data as Values;
      assoc.ownerKey.forEach((name, i) => {
        parent = parent.putChange(name as never, row[assoc.relatedKey[i] as string] as never) as AnyChangeset;
      });
      written.set(relation.name, row);
    }

    // 2. The parent row.
    const result =
      before === null
        ? await insertRow(core, schemaMeta, parent, this.parentSettings())
        : await updateRow(core, schemaMeta, before, parent, this.parentSettings(), method);
    if (!result.success) {
      // The parent's own changes as its write left them (embed children marked can't be
      // blank, say), with the association changes it was written without.
      return failure(
        rebuild(withAction(changeset, action), {
          changes: { ...changes, ...(result.error.changes as Values) },
          errors: result.error.errors,
          valid: false,
        }),
      );
    }
    const row = result.data as Record<string, unknown>;

    // A belongsTo target that was replaced, deleted when onReplace says so.
    for (const [relation, value] of nested) {
      if (relation.kind !== "belongsTo") continue;
      const old = oldOne(changeset, relation);
      if (old === undefined || !replacedBy(relation, old, value)) continue;
      if (relation.onReplace !== "delete" && relation.onReplace !== "deleteIfExists") continue;
      const result = await this.child(
        core,
        repo,
        withAction(change(old as never) as AnyChangeset, "delete"),
        relation,
        undefined,
      );
      if (!result.success) return failWith(relation.name, result.error);
    }

    // 3. hasOne / hasMany children; 4. manyToMany targets and links.
    for (const [relation, value] of nested) {
      if (relation.kind === "belongsTo") continue;
      const assoc = relation.assoc as AssocMeta;
      if (relation.kind === "manyToMany") {
        const outcome = await this.links(
          core,
          repo,
          changeset,
          relation,
          value as readonly AnyChangeset[],
          row,
          childSchema(relation.targetMeta),
        );
        if (!outcome.success) return failWith(relation.name, outcome.error);
        written.set(relation.name, outcome.data);
        continue;
      }
      if (!relation.many) {
        const old = oldOne(changeset, relation);
        if (old !== undefined && replacedBy(relation, old, value)) {
          const leaving =
            relation.onReplace === "setNull"
              ? withAction(nullKeys(change(old as never) as AnyChangeset, assoc), "update")
              : withAction(change(old as never) as AnyChangeset, "delete");
          const result = await this.child(core, repo, leaving, relation, undefined);
          if (!result.success) return failWith(relation.name, result.error);
        }
        if (value === null) {
          written.set(relation.name, null);
          continue;
        }
        const child = withKeys(value as AnyChangeset, assoc, row);
        const result = await this.child(core, repo, child, relation, childSchema(relation.targetMeta));
        if (!result.success) return failWith(relation.name, result.error);
        written.set(relation.name, result.data);
        continue;
      }
      const list = value as readonly AnyChangeset[];
      const rows = new Array<unknown>(list.length);
      for (const phase of PHASES) {
        for (let i = 0; i < list.length; i++) {
          const given = list[i] as AnyChangeset;
          const out = leaves(relation, given);
          if (phaseOf(given, out) !== phase) continue;
          const child = out ? given : withKeys(given, assoc, row);
          const result = await this.child(core, repo, child, relation, childSchema(relation.targetMeta));
          if (!result.success) {
            const failed = list.slice();
            failed[i] = result.error;
            return failWith(relation.name, failed);
          }
          rows[i] = result.data;
        }
      }
      written.set(
        relation.name,
        rows.filter((_, i) => !leaves(relation, list[i] as AnyChangeset)),
      );
    }
    return success(withLoaded(schemaMeta, row, written));
  }

  /** Writes one child by its action (a timeout is reported with the call's budget by {@link writeNested}). */
  async child(
    core: ReadCore,
    repo: unknown,
    child: AnyChangeset,
    relation: Relation,
    schema: string | undefined,
  ): Promise<Result<object | null, AnyChangeset>> {
    switch (child.action) {
      case "insert":
        return insert(core, repo, child, this.options(schema));
      case "delete":
        return remove(core, repo, child, {
          ...this.options(undefined),
          ...(relation.onReplace === "deleteIfExists" ? { allowStale: true } : {}),
        });
      default:
        return update(core, repo, child, this.options(undefined));
    }
  }

  /** The targets of a manyToMany change written, then their join rows added and removed. */
  async links(
    core: ReadCore,
    repo: unknown,
    changeset: AnyChangeset,
    relation: Relation,
    list: readonly AnyChangeset[],
    row: Values,
    schema: string | undefined,
  ): Promise<Result<unknown[], unknown>> {
    const assoc = relation.assoc as AssocMeta;
    const current =
      changeset.data === null
        ? NONE
        : (((changeset.data as Values)[relation.name] as readonly object[]) ?? NONE);
    const join = joinSchemaOf(assoc);
    const ownerValue = row[(assoc.joinKeys as NonNullable<AssocMeta["joinKeys"]>)[0].field];
    const parentSchema = (row as { readonly [ROW]?: RowMeta })[ROW]?.schema;
    const joinSchema = join.meta.schema === undefined ? parentSchema : undefined;
    const rows: unknown[] = [];
    // Links removed first, then targets written and linked.
    for (let i = 0; i < list.length; i++) {
      const child = list[i] as AnyChangeset;
      if (child.action !== "delete") continue;
      await this.unlink(core, join, ownerValue, (child.data as Values)[join.targetKey], joinSchema);
    }
    for (let i = 0; i < list.length; i++) {
      const child = list[i] as AnyChangeset;
      if (child.action === "delete") continue;
      const result = await this.child(core, repo, child, relation, schema);
      if (!result.success) {
        const failed = list.slice();
        failed[i] = result.error;
        return failure(failed);
      }
      const target = result.data as Values;
      if (child.action === "insert" || indexOfRow(current, relation.key, target) < 0) {
        const link = change(
          join.schema as never,
          { [join.ownerField]: ownerValue, [join.targetField]: target[join.targetKey] } as never,
        ) as AnyChangeset;
        const linked = await this.child(core, repo, withAction(link, "insert"), relation, joinSchema);
        if (!linked.success) {
          const failed = list.slice();
          failed[i] = rebuild(child, { errors: linked.error.errors, valid: false });
          return failure(failed);
        }
      }
      rows.push(target);
    }
    return success(rows);
  }

  /** Deletes the join row of one link. */
  async unlink(
    core: ReadCore,
    join: JoinTable,
    owner: unknown,
    target: unknown,
    schema: string | undefined,
  ): Promise<void> {
    const fields = [
      join.meta.fieldsByName.get(join.ownerField) as FieldMeta,
      join.meta.fieldsByName.get(join.targetField) as FieldMeta,
    ];
    const plan = core.adapter.compileDelete(join.meta, fields, NONE, schema);
    const options = this.options(undefined);
    await runWrite(
      core,
      core.executor,
      "delete",
      join.meta.source as string,
      plan,
      bindParams(plan.slots, [owner, target]),
      options,
      undefined,
      countRows,
      undefined,
    );
  }
}

function countRows(result: { readonly rowCount: number }): number {
  return result.rowCount;
}

/** The order children of a to-many association are written in: rows leaving it, updates, inserts. */
const PHASES = ["leave", "update", "insert"] as const;

function phaseOf(child: AnyChangeset, out: boolean): (typeof PHASES)[number] {
  if (out) return "leave";
  return child.action === "insert" ? "insert" : "update";
}

/** The to-one row the parent had for `relation`, when it was loaded. */
function oldOne(changeset: AnyChangeset, relation: Relation): object | undefined {
  const data = changeset.data as Values | null;
  if (data === null || !hasOwn(data, relation.name)) return undefined;
  const value = data[relation.name];
  return value === null || typeof value !== "object" ? undefined : value;
}

/** Whether `value` (the new to-one change) replaces the row `old`. */
function replacedBy(relation: Relation, old: object, value: unknown): boolean {
  if (value === null) return true;
  const data = (value as AnyChangeset).data;
  if (data === old) return false;
  return data === null || indexOfRow([old], relation.key, data as object) !== 0;
}

/** The child with its foreign key set from the parent's key. */
function withKeys(child: AnyChangeset, assoc: AssocMeta, parent: Values): AnyChangeset {
  let out = child;
  assoc.relatedKey.forEach((name, i) => {
    out = out.putChange(name as never, parent[assoc.ownerKey[i] as string] as never) as AnyChangeset;
  });
  return out;
}

function nullKeys(child: AnyChangeset, assoc: AssocMeta): AnyChangeset {
  let out = child;
  for (const name of assoc.relatedKey) out = out.putChange(name as never, null as never) as AnyChangeset;
  return out;
}

/** The parent row with the written associations loaded, in the order the schema declares its associations. */
function withLoaded(
  schemaMeta: SchemaMeta,
  row: Record<string, unknown>,
  written: ReadonlyMap<string, unknown>,
): object {
  const names: string[] = [];
  for (const name of schemaMeta.assocs().keys()) if (written.has(name) || hasOwn(row, name)) names.push(name);
  const values: unknown[] = [];
  for (const field of schemaMeta.persisted) values.push(row[field.name]);
  const out = schemaMeta.createWith(names)(
    values,
    names.map((name) => (written.has(name) ? written.get(name) : row[name])),
    (row as unknown as { readonly [ROW]: RowMeta })[ROW],
  ) as Record<string, unknown>;
  for (const field of schemaMeta.fields) if (field.virtual) out[field.name] = row[field.name];
  // A written association was loaded on the row it was written from (cast and put need
  // it), so the row's preload record already names it.
  keepPreloads(row, out);
  return out;
}

// ---------------------------------------------------------------------------
// Join tables
// ---------------------------------------------------------------------------

/** The schema a manyToMany's join rows are written with: its join schema, or one made for its table. */
interface JoinTable {
  readonly schema: AnySchema;
  readonly meta: SchemaMeta;
  /** The join schema's field that points at the owner, and the one that points at the target. */
  readonly ownerField: string;
  readonly targetField: string;
  /** The target's field the join row's target column holds. */
  readonly targetKey: string;
}

const joinTables = /* @__PURE__ */ new WeakMap<AssocMeta, JoinTable>();

function joinSchemaOf(assoc: AssocMeta): JoinTable {
  let join = joinTables.get(assoc);
  if (join !== undefined) return join;
  const [ownerSide, targetSide] = assoc.joinKeys as NonNullable<AssocMeta["joinKeys"]>;
  const through = assoc.joinThrough as NonNullable<AssocMeta["joinThrough"]>;
  const ownerKey = meta(assoc.owner).fieldsByName.get(ownerSide.field) as FieldMeta;
  const targetKey = meta(assoc.target()).fieldsByName.get(targetSide.field) as FieldMeta;
  let schema: AnySchema;
  let ownerField: string;
  let targetField: string;
  if (through.model !== undefined) {
    schema = through.model();
    const joinMeta = meta(schema);
    ownerField = (joinMeta.persisted.find((field) => field.column === ownerSide.column) as FieldMeta).name;
    targetField = (joinMeta.persisted.find((field) => field.column === targetSide.column) as FieldMeta).name;
  } else {
    const redact = ownerKey.redact || targetKey.redact;
    const side = (key: FieldMeta, column: string) => {
      const field = t.type(key.type).primaryKey().column(column);
      return redact ? field.redact() : field;
    };
    ownerField = "owner";
    targetField = "target";
    schema = Schema(
      through.source,
      { owner: side(ownerKey, ownerSide.column), target: side(targetKey, targetSide.column) },
      through.schema === undefined ? undefined : { schema: through.schema },
    );
  }
  join = { schema, meta: meta(schema), ownerField, targetField, targetKey: targetKey.name };
  joinTables.set(assoc, join);
  return join;
}
