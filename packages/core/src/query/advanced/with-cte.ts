/**
 * Common table expressions attached with `.withCte(name, query, options)`: the CTE node,
 * its shape, and the checks of its arguments. `cte(name, shape)` (`cte.ts`) refers to one
 * as a source.
 *
 * This module is imported by the query builder, so it does not import the builder.
 *
 * @module
 */
import type { CteNode, QueryAst } from "../../contracts/query.js";
import { QueryError } from "../../errors.js";
import { HASH_SEED, hashInt, hashString } from "../../internal/hash.js";
import { own } from "../../internal/own.js";
import { isPlainObject } from "../../internal/plain-object.js";

/**
 * Options of `withCte`. `recursive` lets the CTE's query read the CTE itself (`WITH
 * RECURSIVE`); `materialized` asks the database to compute it once (`true`) or to inline
 * it into the query (`false`); left out, the database decides.
 *
 * @example
 * ```ts
 * const options: CteOptions = { recursive: true };
 * ```
 */
export interface CteOptions {
  readonly recursive?: boolean;
  readonly materialized?: boolean;
}

const CTE_SEED = /* @__PURE__ */ hashString(HASH_SEED, "cte");

/**
 * The CTE node for `withCte(name, query, options)`, its arguments checked.
 *
 * @example
 * ```ts
 * withCteNode("tree", body.ast, { recursive: true }, []);
 * ```
 *
 * @throws QueryError when the name is empty or taken, the options are not
 * `{ recursive?, materialized? }`, or the query cannot be a CTE (it has preloads or
 * `set(…)` assignments).
 */
export function withCteNode(
  name: unknown,
  query: QueryAst,
  options: unknown,
  existing: readonly CteNode[],
): CteNode {
  if (typeof name !== "string" || name === "") {
    throw new QueryError("query.cteName", "withCte() takes a name first, a non-empty string.");
  }
  if (existing.some((node) => node.name === name)) {
    throw new QueryError(
      "query.cteTwice",
      `withCte("${name}", …): this query already has a CTE named "${name}".`,
    );
  }
  if (query.preloads.length > 0) {
    throw new QueryError(
      "query.cteWithPreloads",
      `withCte("${name}", …): the query has preloads, which a CTE cannot run.`,
    );
  }
  if (query.updates.length > 0) {
    throw new QueryError("query.cteWithUpdate", `withCte("${name}", …): the query has set(…) assignments.`);
  }
  let recursive = false;
  let materialized: boolean | undefined;
  if (options !== undefined) {
    if (typeof options !== "object" || options === null || !isPlainObject(options)) {
      throw new QueryError(
        "query.cteOptions",
        `withCte("${name}", query, options) takes its options as an object.`,
      );
    }
    for (const key of Object.keys(options)) {
      if (key !== "recursive" && key !== "materialized") {
        throw new QueryError("query.cteUnknownOption", `withCte("${name}", …) has no option "${key}".`);
      }
    }
    const given = options as { readonly recursive?: unknown; readonly materialized?: unknown };
    const recursiveOption = own(given, "recursive");
    const materializedOption = own(given, "materialized");
    if (recursiveOption !== undefined && typeof recursiveOption !== "boolean") {
      throw new QueryError("query.cteRecursive", `withCte("${name}", …): recursive is true or false.`);
    }
    if (materializedOption !== undefined && typeof materializedOption !== "boolean") {
      throw new QueryError(
        "query.cteMaterialized",
        `withCte("${name}", …): materialized is true or false, or left out to let the database decide.`,
      );
    }
    recursive = recursiveOption === true;
    materialized = materializedOption;
  }
  return { kind: "cte", name, query, operation: "all", recursive, materialized };
}

/**
 * The shape of a CTE node whose query has shape `queryShape` (as `shapeOf` defines it,
 * without walking the query again).
 *
 * @example
 * ```ts
 * cteShape(node, body.ast.shape);
 * ```
 */
export function cteShape(node: CteNode, queryShape: number): number {
  return hashInt(
    hashInt(
      hashString(hashInt(hashString(CTE_SEED, node.name), queryShape), node.operation),
      node.recursive ? 1 : 0,
    ),
    node.materialized === undefined ? 0 : node.materialized ? 2 : 1,
  );
}
