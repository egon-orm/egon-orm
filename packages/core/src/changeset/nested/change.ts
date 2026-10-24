/**
 * `castAssoc`, `castEmbed`, `putAssoc` and `putEmbed`: building the child changesets of
 * an association or embed field and recording them as the parent's change.
 *
 * The parent's change of a relation is a child changeset (one) or a list of them
 * (many), or `null` when a to-one value is removed. A child's `action` says what the
 * repo does with it: `"insert"` (a new record), `"update"` (an existing row, matched by
 * primary key, or a loaded row given to `putAssoc`) or `"delete"`. Rows the new data
 * leaves out are handled by `onReplace`; for a list, those it keeps track of (`"delete"`,
 * `"setNull"`) are appended after the new items, so that the new items keep the
 * positions they had in the params.
 *
 * @module
 */
import type { ChangesetError } from "../../contracts/changeset.js";
import type { AnySchema, FieldMeta } from "../../contracts/schema.js";
import { QueryError } from "../../errors.js";
import { frozenOptions, own } from "../../internal/own.js";
import { isRow } from "../../schema/guards.js";
import { meta } from "../../schema/schema.js";
import { Changeset, change, rebuild, withAction } from "../changeset.js";
import {
  type AnyChangeset,
  currentOf,
  describe,
  indexOfKey,
  indexOfRow,
  isItem,
  keyFinder,
  keyOf,
  leaves,
  type Relation,
  relationOf,
  type Values,
} from "./relation.js";

const hasOwn = Object.hasOwn;
const EMPTY: Values = /* @__PURE__ */ Object.freeze({});
/** The options of a cast without any: no prototype, so a key planted on `Object.prototype` is no option. */
const NO_OPTIONS: NestedOptions = /* @__PURE__ */ frozenOptions({});

const BLANK: ChangesetError = /* @__PURE__ */ Object.freeze({
  message: "can't be blank",
  validation: "required",
  meta: EMPTY,
});
const REPLACED: ChangesetError = /* @__PURE__ */ Object.freeze({
  message: "is invalid",
  validation: "replace",
  meta: EMPTY,
});

function invalidType(type: "list" | "object"): ChangesetError {
  return { message: "is invalid", validation: "cast", meta: { type } };
}

/** The function that makes a child changeset: `with(existing row or class, item, index)`. */
type WithFn = (target: unknown, item: Values, index: number) => unknown;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** The options of `castAssoc` and `castEmbed` as given, before they are checked. */
interface NestedOptions {
  readonly with?: unknown;
  readonly required?: unknown;
}

interface CastSettings {
  readonly with: WithFn;
  readonly required: boolean;
}

/** The target's static `changeset` function, when it has one. */
function defaultWith(target: AnySchema): WithFn | undefined {
  const fn: unknown = (target as unknown as { readonly changeset?: unknown }).changeset;
  return typeof fn === "function" ? (fn.bind(target) as WithFn) : undefined;
}

function castSettings(relation: Relation, options: unknown, fn: string): CastSettings {
  if (options !== undefined && (typeof options !== "object" || options === null || !isItem(options))) {
    throw new QueryError(
      "query.nestedOptions",
      `${fn}("${relation.name}", options): the options must be an object.`,
    );
  }
  const given = (options ?? NO_OPTIONS) as NestedOptions;
  for (const key of Object.keys(given)) {
    if (key !== "with" && key !== "required") {
      throw new QueryError("query.nestedUnknownOption", `${fn}(): unknown option "${key}".`);
    }
  }
  const required = own(given, "required");
  const withOption = own(given, "with");
  if (required !== undefined && typeof required !== "boolean") {
    throw new QueryError("query.nestedRequired", `${fn}(): required must be true or false.`);
  }
  if (withOption !== undefined && typeof withOption !== "function") {
    throw new QueryError(
      "query.nestedWith",
      `${fn}(): with must be the function that makes a child changeset.`,
    );
  }
  const withFn = (withOption as WithFn | undefined) ?? defaultWith(relation.target);
  if (withFn === undefined) {
    throw new QueryError(
      "query.nestedNoChangeset",
      `${fn}("${relation.name}"): ${relation.targetMeta.name} has no static changeset function.`,
    );
  }
  return { with: withFn, required: required === true };
}

// ---------------------------------------------------------------------------
// Making one child
// ---------------------------------------------------------------------------

/** Checks that `value` is a changeset of the relation's target, and gives it `action`. */
function childOf(relation: Relation, value: unknown, action: "insert" | "update", fn: string): AnyChangeset {
  if (!(value instanceof Changeset)) {
    throw new TypeError(
      `${fn}("${relation.name}"): the with function must return a changeset of ${relation.targetMeta.name}, but it returned ${describe(value)}.`,
    );
  }
  const child = value as AnyChangeset;
  if (child.model !== relation.target) {
    throw new QueryError(
      "query.nestedChildSchema",
      `${fn}("${relation.name}"): the child changesets must be of ${relation.targetMeta.name}, but one is of ${child.model === null ? "no schema class" : meta(child.model as AnySchema).name}.`,
      { params: { target: relation.targetMeta.name } },
    );
  }
  return withAction(child, action);
}

function call(
  relation: Relation,
  settings: CastSettings,
  target: unknown,
  item: Values,
  index: number,
  action: "insert" | "update",
  fn: string,
): AnyChangeset {
  return childOf(relation, settings.with(target, item, index), action, fn);
}

// ---------------------------------------------------------------------------
// Finishing: replaced rows, no change, validity, required
// ---------------------------------------------------------------------------

/**
 * Whether every changeset nested in `changes` is valid.
 *
 * @example
 * ```ts
 * const valid = noErrors && nestedValid(cs.changes);
 * ```
 */
export function nestedValid(changes: Values): boolean {
  for (const key in changes) {
    if (!hasOwn(changes, key)) continue;
    const value = changes[key];
    if (value instanceof Changeset) {
      if (!value.valid) return false;
    } else if (Array.isArray(value)) {
      for (const item of value) if (item instanceof Changeset && !item.valid) return false;
    }
  }
  return true;
}

function hasErrors(errors: Readonly<Record<string, readonly ChangesetError[]>>): boolean {
  for (const key in errors) if (hasOwn(errors, key)) return true;
  return false;
}

function addError(
  errors: Readonly<Record<string, readonly ChangesetError[]>>,
  key: string,
  error: ChangesetError,
): Readonly<Record<string, readonly ChangesetError[]>> {
  const existing = hasOwn(errors, key) ? (errors[key] as readonly ChangesetError[]) : undefined;
  return { ...errors, [key]: existing === undefined ? [error] : [...existing, error] };
}

/**
 * The parent with `value` as its change of the relation (or without one, for `undefined`)
 * and `extra` errors on the relation's name. Validity is worked out again: no errors of
 * its own and every nested changeset valid.
 */
function settle(
  parent: AnyChangeset,
  relation: Relation,
  value: unknown,
  extra: readonly ChangesetError[],
): AnyChangeset {
  const before = parent.changes as Values;
  let changes: Values;
  if (value === undefined) {
    if (!hasOwn(before, relation.name)) changes = before;
    else {
      const copy: Record<string, unknown> = {};
      for (const key of Object.keys(before)) if (key !== relation.name) copy[key] = before[key];
      changes = copy;
    }
  } else {
    changes = { ...before, [relation.name]: value };
  }
  let errors = parent.errors;
  for (const error of extra) errors = addError(errors, relation.name, error);
  if (changes === before && errors === parent.errors) return parent;
  return rebuild(parent, { changes, errors, valid: !hasErrors(errors) && nestedValid(changes) });
}

function onReplaceError(relation: Relation, fn: string): QueryError {
  const fix =
    relation.kind === "embed"
      ? `t.${relation.many ? "embedMany" : "embedOne"}(() => ${relation.targetMeta.name}, { onReplace: "delete" })`
      : `{ onReplace: "${relation.many ? "delete" : "update"}" } on the association`;
  return new QueryError(
    "query.onReplaceError",
    `${fn}("${relation.name}"): the new value leaves out ${relation.many ? "rows" : "the row"} that ${relation.ownerName}.${relation.name} has, and its onReplace is "error".`,
    {
      params: {
        them: relation.many ? "them" : "it",
        fix,
        assocModes: relation.kind === "embed" ? "" : ', "deleteIfExists", "setNull"',
        oneModes: relation.many ? "" : ' and "update"',
      },
    },
  );
}

/**
 * Refuses `onReplace: "setNull"` on a `hasOne`/`hasMany` whose foreign key cannot hold
 * `null` (a `belongsTo` keeps the old row as it is).
 *
 * @throws QueryError naming the field.
 */
function checkSetNull(relation: Relation, fn: string): void {
  const assoc = relation.assoc;
  if (assoc === undefined || (assoc.kind !== "hasOne" && assoc.kind !== "hasMany")) return;
  for (const name of assoc.relatedKey) {
    const field = relation.targetMeta.fieldsByName.get(name) as FieldMeta;
    if (!field.nullable) {
      throw new QueryError(
        "query.onReplaceSetNull",
        `${fn}("${relation.name}"): onReplace is "setNull", but ${relation.targetMeta.name}.${name} is not nullable.`,
      );
    }
  }
}

/** The change that takes `row` out of a to-many relation, by its `onReplace`. */
function replacement(relation: Relation, row: object, fn: string): AnyChangeset | undefined {
  switch (relation.onReplace) {
    case "invalid":
      return undefined;
    case "setNull": {
      const assoc = relation.assoc;
      checkSetNull(relation, fn);
      let child = change(row as never) as AnyChangeset;
      for (const name of assoc?.relatedKey ?? []) {
        child = child.putChange(name as never, null as never) as AnyChangeset;
      }
      return withAction(child, "update");
    }
    case "delete":
    case "deleteIfExists":
      return withAction(change(row as never) as AnyChangeset, "delete");
    default:
      throw onReplaceError(relation, fn);
  }
}

/**
 * Records a to-many change: `children` are the new items in order, `matched[i]` the
 * position in `current` of the row child `i` updates (or -1).
 */
function finishMany(
  parent: AnyChangeset,
  relation: Relation,
  current: readonly object[],
  children: readonly AnyChangeset[],
  matched: readonly number[],
  required: boolean,
  extra: ChangesetError[],
  fn: string,
): AnyChangeset {
  const kept = new Set(matched);
  const list = children.slice();
  // Without a key, an embedded list is replaced as a whole.
  const replaceAll = relation.kind === "embed" && relation.key.length === 0;
  let invalid = false;
  if (!replaceAll) {
    for (let i = 0; i < current.length; i++) {
      if (kept.has(i)) continue;
      const out = replacement(relation, current[i] as object, fn);
      if (out === undefined) invalid = true;
      else list.push(out);
    }
  }
  if (invalid) extra.push(REPLACED);
  if (required && children.length === 0) extra.push(BLANK);
  if (
    extra.length === 0 &&
    list.length === current.length &&
    unchangedList(list, matched, current, replaceAll)
  ) {
    return settle(parent, relation, undefined, extra);
  }
  return settle(parent, relation, list, extra);
}

function unchanged(child: AnyChangeset): boolean {
  if (!child.valid || child.action !== "update") return false;
  for (const key in child.changes as Values) if (hasOwn(child.changes, key)) return false;
  return true;
}

function unchangedList(
  list: readonly AnyChangeset[],
  matched: readonly number[],
  current: readonly object[],
  replaceAll: boolean,
): boolean {
  for (let i = 0; i < list.length; i++) {
    const child = list[i] as AnyChangeset;
    if (replaceAll) {
      // A keyless embedded list: each item is new; unchanged when it equals the row there.
      if (child.action !== "insert" || !child.valid || !sameValues(child, current[i] as object)) return false;
      continue;
    }
    if (matched[i] !== i || !unchanged(child)) return false;
  }
  return true;
}

/** Whether a new embedded row's changes give exactly `row`'s values. */
function sameValues(child: AnyChangeset, row: object): boolean {
  const changes = child.changes as Values;
  const schemaMeta = meta(child.model as AnySchema);
  for (const field of schemaMeta.persisted) {
    const value = hasOwn(changes, field.name) ? changes[field.name] : initial(field);
    if (value instanceof Changeset || Array.isArray(value)) return false;
    const stored = (row as Values)[field.name];
    if (value === stored) continue;
    if (value === null || value === undefined || stored === null || stored === undefined) return false;
    if (!field.type.equal(value, stored)) return false;
  }
  return true;
}

function initial(field: FieldMeta): unknown {
  const fallback = field.default;
  if (fallback !== undefined) return fallback.kind === "value" ? fallback.value : fallback.fn();
  return field.nullable ? null : undefined;
}

/** Whether `data` (a child changeset's data) is the row `current`: the same object, or the same key. */
function sameRow(relation: Relation, data: unknown, current: object): boolean {
  if (data === current) return true;
  if (data === null || typeof data !== "object" || relation.key.length === 0) return false;
  return indexOfRow([current], relation.key, data) === 0;
}

/** Records a to-one change: `next` is the new child (or `null`), `current` the row there (or none). */
function finishOne(
  parent: AnyChangeset,
  relation: Relation,
  current: object | undefined,
  next: AnyChangeset | null,
  required: boolean,
  extra: ChangesetError[],
  fn: string,
): AnyChangeset {
  const kept = current !== undefined && next !== null && sameRow(relation, next.data, current);
  if (current !== undefined && !kept) {
    switch (relation.onReplace) {
      case "error":
        throw onReplaceError(relation, fn);
      case "invalid":
        extra.push(REPLACED);
        break;
      case "update":
        // A new value reuses the row (the caller made it from the row); only removing it lands here.
        if (relation.kind !== "embed") {
          throw new QueryError(
            "query.onReplaceUpdateNull",
            `${fn}("${relation.name}"): onReplace "update" reuses the row of ${relation.ownerName}.${relation.name} for a new value, so it cannot remove it.`,
          );
        }
        break;
      case "setNull":
        // Done by the repo when the parent is written; the key must be able to hold null.
        checkSetNull(relation, fn);
        break;
      default:
        // delete, deleteIfExists: done by the repo when the parent is written.
        break;
    }
  }
  if (next === null && relation.kind === "belongsTo") {
    for (const name of relation.assoc?.ownerKey ?? []) {
      const field = (
        parent.model === null ? undefined : meta(parent.model as AnySchema).fieldsByName.get(name)
      ) as FieldMeta;
      if (!field.nullable) {
        extra.push(BLANK);
        break;
      }
    }
  }
  if (required && next === null && !extra.includes(BLANK)) extra.push(BLANK);
  if (
    extra.length === 0 &&
    ((next === null && current === undefined) || (next !== null && kept && unchanged(next)))
  ) {
    return settle(parent, relation, undefined, extra);
  }
  return settle(parent, relation, next, extra);
}

// ---------------------------------------------------------------------------
// cast
// ---------------------------------------------------------------------------

/**
 * `castAssoc(name, options)` and `castEmbed(name, options)`: the relation's value in
 * the params, cast item by item with `with`.
 *
 * @throws QueryError for a name that is not such a relation, wrong options, a changeset
 * that was not made by `cast`, or a removed row when `onReplace` is `"error"`.
 * @throws NotLoadedError when the association is not preloaded on a loaded parent.
 * @throws TypeError when `with` does not return a changeset.
 */
export function castRelation(
  parent: AnyChangeset,
  name: unknown,
  options: unknown,
  embed: boolean,
): AnyChangeset {
  const fn = embed ? "castEmbed" : "castAssoc";
  const relation = relationOf(parent, name, fn, embed ? "embed" : "assoc");
  const settings = castSettings(relation, options, fn);
  const params = parent.params;
  if (params === null) {
    throw new QueryError(
      "query.castNestedWithoutParams",
      `${fn}("${relation.name}") reads the params given to cast(), and this changeset was made with change().`,
      { params: { embed: embed ? "putEmbed" : "putAssoc" } },
    );
  }
  const current = currentOf(parent, relation);
  const raw = hasOwn(params, relation.name) ? params[relation.name] : undefined;
  if (raw === undefined) {
    return settings.required && current.length === 0 && !hasOwn(parent.changes, relation.name)
      ? settle(parent, relation, undefined, [BLANK])
      : parent;
  }
  const extra: ChangesetError[] = [];
  if (relation.many) {
    if (!Array.isArray(raw) || !raw.every(isItem)) {
      return settle(parent, relation, undefined, [invalidType(Array.isArray(raw) ? "object" : "list")]);
    }
    const children: AnyChangeset[] = [];
    const matched: number[] = [];
    const taken = new Set<number>();
    const find = keyFinder(current, relation.key);
    for (let i = 0; i < raw.length; i++) {
      const item = raw[i] as Values;
      const key = keyOf(relation.key, item, true);
      const at = key === undefined ? -1 : find(key);
      if (at >= 0 && taken.has(at)) {
        // The same row twice: the parent is invalid, and the item is kept in its place.
        extra.push({ message: "is invalid", validation: "duplicate", meta: { index: i } });
        children.push(call(relation, settings, relation.target, item, i, "insert", fn));
        matched.push(-1);
        continue;
      }
      if (at >= 0) taken.add(at);
      children.push(
        at >= 0
          ? call(relation, settings, current[at], item, i, "update", fn)
          : call(relation, settings, relation.target, item, i, "insert", fn),
      );
      matched.push(at);
    }
    return finishMany(parent, relation, current, children, matched, settings.required, extra, fn);
  }
  const existing = current[0];
  if (raw === null) return finishOne(parent, relation, existing, null, settings.required, extra, fn);
  if (!isItem(raw)) return settle(parent, relation, undefined, [invalidType("object")]);
  const key = keyOf(relation.key, raw, true);
  const reuse =
    existing !== undefined &&
    ((key !== undefined && indexOfKey([existing], relation.key, key) === 0) ||
      relation.onReplace === "update");
  const next = reuse
    ? call(relation, settings, existing, raw, 0, "update", fn)
    : call(relation, settings, relation.target, raw, 0, "insert", fn);
  return finishOne(parent, relation, existing, next, settings.required, extra, fn);
}

// ---------------------------------------------------------------------------
// put
// ---------------------------------------------------------------------------

/** One value given to `putAssoc`/`putEmbed`, as a child changeset and the position of the row it updates. */
function putItem(
  relation: Relation,
  current: readonly object[],
  find: (key: readonly unknown[]) => number,
  value: unknown,
  fn: string,
): { readonly child: AnyChangeset; readonly at: number } {
  if (value instanceof Changeset) {
    const given = childOf(relation, value, "update", fn);
    if (given.data === null) return { child: withAction(given, "insert"), at: -1 };
    return { child: given, at: indexOfRow(current, relation.key, given.data as object) };
  }
  if (isRow(value)) {
    if (Object.getPrototypeOf(value) !== relation.target.prototype) {
      throw new QueryError(
        "query.nestedRowSchema",
        `${fn}("${relation.name}"): a row given must be a ${relation.targetMeta.name}.`,
        { params: { target: relation.targetMeta.name } },
      );
    }
    return {
      child: withAction(change(value as never) as AnyChangeset, "update"),
      at: indexOfRow(current, relation.key, value),
    };
  }
  if (isItem(value)) {
    const key = keyOf(relation.key, value, false);
    const at = key === undefined ? -1 : find(key);
    const target = at >= 0 ? current[at] : relation.target;
    return { child: withAction(fromValues(relation, target, value, fn), at >= 0 ? "update" : "insert"), at };
  }
  throw new QueryError(
    "query.nestedValue",
    `${fn}("${relation.name}"): each value is a ${relation.targetMeta.name} row, a changeset of one, or a plain object of its fields, but one is ${describe(value)}.`,
    { params: { target: relation.targetMeta.name } },
  );
}

/**
 * A changeset of `target` (a row, or the class for a new record) from a plain object: its
 * fields with `change`, its associations and embeds with `putAssoc` / `putEmbed`.
 */
function fromValues(relation: Relation, target: unknown, values: Values, fn: string): AnyChangeset {
  const targetMeta = relation.targetMeta;
  const fields: Record<string, unknown> = {};
  let nested: string[] | undefined;
  for (const key of Object.keys(values)) {
    const field = targetMeta.fieldsByName.get(key);
    const isEmbed = field !== undefined && targetMeta.embeds.some((embed) => embed.name === key);
    if (field !== undefined && !isEmbed) fields[key] = values[key];
    else if (isEmbed || targetMeta.assocs().has(key)) {
      nested ??= [];
      nested.push(key);
    } else {
      throw new QueryError(
        "query.nestedUnknownKey",
        `${fn}("${relation.name}"): ${targetMeta.name} has no field or association "${key}".`,
        { params: { target: targetMeta.name } },
      );
    }
  }
  let child = change(target as never, fields as never) as AnyChangeset;
  for (const key of nested ?? []) {
    const value = values[key];
    if (value === undefined) continue;
    const isEmbed = targetMeta.embeds.some((embed) => embed.name === key);
    child = putRelation(child, key, value, isEmbed);
  }
  return child;
}

/**
 * `putAssoc(name, value)` and `putEmbed(name, value)`: the relation set from values you
 * trust: rows, changesets, or plain objects.
 *
 * @throws QueryError for a name that is not such a relation, a value of the wrong kind,
 * the same row twice, or a removed row when `onReplace` is `"error"`.
 * @throws NotLoadedError when the association is not preloaded on a loaded parent.
 */
export function putRelation(
  parent: AnyChangeset,
  name: unknown,
  value: unknown,
  embed: boolean,
): AnyChangeset {
  const fn = embed ? "putEmbed" : "putAssoc";
  const relation = relationOf(parent, name, fn, embed ? "embed" : "assoc");
  if (value === undefined) {
    throw new QueryError("query.nestedUndefined", `${fn}("${relation.name}", undefined).`, {
      params: { what: relation.many ? "a list" : "a value or null" },
    });
  }
  const current = currentOf(parent, relation);
  const extra: ChangesetError[] = [];
  if (relation.many) {
    if (!Array.isArray(value)) {
      throw new QueryError(
        "query.nestedNotArray",
        `${fn}("${relation.name}"): ${relation.ownerName}.${relation.name} holds a list.`,
      );
    }
    const children: AnyChangeset[] = [];
    const matched: number[] = [];
    const rows: object[] = [];
    const find = keyFinder(current, relation.key);
    for (const each of value) {
      const { child, at } = putItem(relation, current, find, each, fn);
      const data = child.data as object | null;
      if (data !== null) {
        // The same row twice, whether the parent has it or not.
        if (indexOfRow(rows, relation.key, data) >= 0) {
          throw new QueryError(
            "query.nestedDuplicate",
            `${fn}("${relation.name}"): the same ${relation.targetMeta.name} is given twice.`,
          );
        }
        rows.push(data);
      }
      children.push(child);
      matched.push(at);
    }
    return finishMany(parent, relation, current, children, matched, false, extra, fn);
  }
  const existing = current[0];
  if (value === null) return finishOne(parent, relation, existing, null, false, extra, fn);
  const { child, at } = putItem(relation, current, keyFinder(current, relation.key), value, fn);
  // "update" reuses the row there for a new value given as a plain object.
  const next =
    at < 0 && existing !== undefined && relation.onReplace === "update" && isItem(value)
      ? withAction(fromValues(relation, existing, value, fn), "update")
      : child;
  return finishOne(parent, relation, existing, next, false, extra, fn);
}

export { leaves };
