/**
 * Set operations (`union`, `unionAll`, `intersect`, `intersectAll`, `except`,
 * `exceptAll`): the combination nodes the builder adds, and the checks that the two sides
 * can be combined.
 *
 * The query a set operation is called on is the left side, and the combined query. Its
 * `orderBy`, `limit` and `offset` apply to the combined rows, so the left side must have
 * none when it is combined (they would silently change meaning), and after a set operation
 * only those clauses (and more set operations, `withCte` and `schema`) may be added. A
 * clause on one branch only belongs on that branch before it is combined.
 *
 * This module is imported by the query builder, so it does not import the builder.
 *
 * @module
 */
import type { CombinationNode, QueryAst, SelectShape } from "../../contracts/query.js";
import type { SchemaMeta } from "../../contracts/schema.js";
import { QueryError } from "../../errors.js";
import { HASH_SEED, hashInt, hashString } from "../../internal/hash.js";
import { own } from "../../internal/own.js";

/**
 * The SQL set operations.
 *
 * @example
 * ```ts
 * const op: SetOperation = "except";
 * ```
 */
export type SetOperation = "union" | "intersect" | "except";

const COMBINATION_SEED = /* @__PURE__ */ hashString(HASH_SEED, "combination");

/**
 * A combination node, its properties in contract order.
 *
 * @example
 * ```ts
 * combinationNode("union", true, other.ast);
 * ```
 */
export function combinationNode(op: SetOperation, all: boolean, query: QueryAst): CombinationNode {
  return { kind: "combination", op, all, query };
}

/**
 * The shape of a combination node, from the shape its query already carries (as
 * `shapeOf` defines it, without walking the query again).
 *
 * @example
 * ```ts
 * combinationShape("union", false, other.ast.shape);
 * ```
 */
export function combinationShape(op: SetOperation, all: boolean, queryShape: number): number {
  return hashInt(hashInt(hashString(COMBINATION_SEED, op), all ? 1 : 0), queryShape);
}

/**
 * Checks that `right` can be combined with `left` by `method`: neither side holds what a
 * set operation cannot carry, and both return rows of the same shape.
 *
 * @example
 * ```ts
 * checkCombination("union", left.ast, right.ast);
 * ```
 *
 * @throws QueryError naming the method and what is wrong.
 */
export function checkCombination(method: string, left: QueryAst, right: QueryAst): void {
  if (left.orderBys.length > 0 || left.limit !== undefined || left.offset !== undefined) {
    const clause =
      left.orderBys.length > 0 ? "an orderBy()" : left.limit !== undefined ? "a limit()" : "an offset()";
    throw new QueryError("query.setOperationClause", `${method}() was called on a query with ${clause}.`, {
      params: { method },
    });
  }
  if (left.lock !== undefined || right.lock !== undefined) {
    throw new QueryError(
      "query.setOperationLock",
      `${method}(): a query with a row lock cannot be combined with another.`,
    );
  }
  for (const [side, ast] of [
    ["this query", left],
    ["the other query", right],
  ] as const) {
    if (ast.preloads.length > 0) {
      throw new QueryError(
        "query.setOperationPreloads",
        `${method}(): ${side} has preloads, which a set operation cannot carry.`,
      );
    }
    if (ast.updates.length > 0) {
      throw new QueryError("query.setOperationUpdate", `${method}(): ${side} has set(…) assignments.`);
    }
  }
  const a = skeleton(left, method);
  const b = skeleton(right, method);
  if (a !== undefined && b !== undefined) compare(method, a, b, "");
}

/** What a query returns, as far as the database's columns go. */
type Skeleton =
  | { readonly kind: "value" }
  | { readonly kind: "row"; readonly meta: SchemaMeta }
  | { readonly kind: "object"; readonly keys: readonly string[]; readonly values: readonly Skeleton[] }
  | { readonly kind: "tuple"; readonly items: readonly Skeleton[] };

/** The skeleton of what `ast` returns; `undefined` where it cannot be told (a source with no schema). */
function skeleton(ast: QueryAst, method: string): Skeleton | undefined {
  const select = ast.select;
  if (select !== undefined) return skeletonOf(select.shape, method, "");
  const root = ast.from;
  if (root.kind === "subquerySource") return skeleton(root.query, method);
  // A table or a CTE typed by a schema; a values list or a fragment has no `meta`.
  const rows = own(root as { readonly meta?: SchemaMeta | undefined }, "meta");
  return rows === undefined ? undefined : { kind: "row", meta: rows };
}

/** The skeleton of a select's output tree; a plain value in it is refused. */
function skeletonOf(shape: SelectShape, method: string, path: string): Skeleton {
  switch (shape.kind) {
    case "expr":
      return { kind: "value" };
    case "binding":
      return { kind: "row", meta: shape.meta };
    case "constant":
      throw new QueryError(
        "query.setOperationPlainValue",
        `${method}(): a side selects a plain value${at(path)}, which is returned as it is and never sent to the database, so the rows of the other side would get it too.`,
      );
    case "object":
      return {
        kind: "object",
        keys: shape.keys,
        values: shape.values.map((value, i) =>
          skeletonOf(value, method, joinPath(path, shape.keys[i] as string)),
        ),
      };
    case "tuple":
      return {
        kind: "tuple",
        items: shape.items.map((item, i) => skeletonOf(item, method, joinPath(path, String(i)))),
      };
  }
}

function joinPath(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

function at(path: string): string {
  return path === "" ? "" : ` at "${path}"`;
}

function describe(node: Skeleton): string {
  switch (node.kind) {
    case "value":
      return "one value";
    case "row":
      return `rows of ${node.meta.name}`;
    case "object":
      return `an object with the keys ${node.keys.join(", ")}`;
    case "tuple":
      return `an array of ${node.items.length}`;
  }
}

function mismatch(method: string, a: Skeleton, b: Skeleton, path: string): QueryError {
  return new QueryError(
    "query.setOperationShapes",
    `${method}(): the two sides return different shapes${at(path)}: this query returns ${describe(a)}, the other ${describe(b)}.`,
  );
}

function compare(method: string, a: Skeleton, b: Skeleton, path: string): void {
  switch (a.kind) {
    case "value":
      if (b.kind !== "value") throw mismatch(method, a, b, path);
      return;
    case "row":
      if (b.kind !== "row" || b.meta !== a.meta) throw mismatch(method, a, b, path);
      return;
    case "object":
      if (b.kind !== "object" || b.keys.length !== a.keys.length) throw mismatch(method, a, b, path);
      for (let i = 0; i < a.keys.length; i++) {
        const key = a.keys[i] as string;
        if (b.keys[i] !== key) throw mismatch(method, a, b, path);
        compare(method, a.values[i] as Skeleton, b.values[i] as Skeleton, joinPath(path, key));
      }
      return;
    case "tuple":
      if (b.kind !== "tuple" || b.items.length !== a.items.length) throw mismatch(method, a, b, path);
      for (let i = 0; i < a.items.length; i++) {
        compare(method, a.items[i] as Skeleton, b.items[i] as Skeleton, joinPath(path, String(i)));
      }
      return;
  }
}
