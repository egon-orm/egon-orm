/**
 * The plan cache: compiled plans kept per adapter instance, so that compiling a query a
 * second time costs a lookup instead of an emission.
 *
 * Two levels for queries and fragments:
 *
 * 1. **L1, by identity.** A `WeakMap` from the AST object to its plans (one per operation
 *    and database schema). A query defined once at module level compiles once per database
 *    schema, ever, and is found again without hashing anything.
 * 2. **L2, by shape.** A bounded LRU keyed by the AST's structural hash (`QueryAst.shape`),
 *    mixed with the operation, the database schema and, where the dialect expands lists,
 *    the list lengths. A hash can collide, so a hit is confirmed with {@link sameShape}; a
 *    mismatch is a miss and is counted in `collisions`. A query rebuilt per request with
 *    other values pays its build and this lookup, not an emission.
 *
 * Row-level writes have a third, keyed by a string that spells out the schema, the
 * operation, the columns and the options (`compiler.ts`).
 *
 * @module
 */
import type { CompiledQuery } from "../contracts/adapter.js";
import type { QueryNode, QueryOperation } from "../contracts/query.js";
import { hashInt, hashString } from "../internal/hash.js";
import { LruCache } from "../internal/lru.js";
import { own } from "../internal/own.js";
import { sameShape } from "./same-shape.js";

/**
 * Counters of a plan cache, for telemetry and tests.
 *
 * - `hits`: lookups answered from the cache (either level, and row-level writes).
 * - `misses`: lookups that compiled a new plan.
 * - `collisions`: L2 lookups whose key matched a plan of another shape (also counted in
 *   `misses`). It should stay 0; anything else means two shapes keep evicting each other.
 * - `size`: plans held by the bounded levels (L2 and the row-level write cache).
 *
 * @example
 * ```ts
 * const { hits, misses, collisions, size }: PlanCacheStats = repo.planCacheStats();
 * ```
 */
export interface PlanCacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly collisions: number;
  readonly size: number;
}

/**
 * The plans compiled for one AST object: one per (operation, database schema).
 */
interface IdentityEntry {
  readonly operation: CacheOperation;
  readonly schema: string | undefined;
  readonly plan: CompiledQuery;
}

interface ShapeEntry {
  readonly node: QueryNode;
  readonly lengths: readonly number[];
  readonly operation: CacheOperation;
  readonly schema: string | undefined;
  readonly plan: CompiledQuery;
}

interface WriteEntry {
  /** The AST parts of the description (an expression cell, a query source, a fragment target), compared structurally on a hit. */
  readonly nodes: readonly QueryNode[];
  readonly plan: CompiledQuery;
}

/**
 * Options of a {@link PlanCache}.
 *
 * @example
 * ```ts
 * const options: PlanCacheOptions = { capacity: 1000, keyLists: false, keyOf: undefined };
 * ```
 */
export interface PlanCacheOptions {
  /** How many plans each bounded level keeps (default 1,000). */
  readonly capacity: number;
  /** Whether list lengths are part of the key (dialects that expand lists to `IN (?, ?, …)`). */
  readonly keyLists: boolean;
  /**
   * The L2 key of a lookup; `undefined` mixes the node's structural hash with the
   * operation, the database schema and (with `keyLists`) the list lengths. Tests replace
   * it with a constant to force collisions.
   */
  readonly keyOf: ((node: QueryNode) => number) | undefined;
}

/**
 * What a cached plan was compiled as: a query operation, or a bare fragment.
 *
 * @example
 * ```ts
 * const operation: CacheOperation = "fragment";
 * ```
 */
export type CacheOperation = QueryOperation | "fragment";

/** A per-operation code mixed into the L2 key. */
const OPERATION_CODES: Readonly<Record<CacheOperation, number>> = /* @__PURE__ */ Object.freeze({
  all: 1,
  updateAll: 2,
  deleteAll: 3,
  fragment: 4,
});

const NO_LENGTHS: readonly number[] = /* @__PURE__ */ Object.freeze([]);

/**
 * The two-level cache of compiled queries (and the cache of row-level write plans).
 *
 * @example
 * ```ts
 * const cache = new PlanCache({ capacity: 1000, keyLists: false, keyOf: undefined });
 * const plan = cache.get(ast, "all", undefined, ast.shape, ast.listLengths) ?? compileAndStore();
 * ```
 */
export class PlanCache {
  #identity = new WeakMap<object, IdentityEntry[]>();
  readonly #shapes: LruCache<number, ShapeEntry>;
  readonly #writes: LruCache<string, WriteEntry>;
  readonly #keyLists: boolean;
  readonly #keyOf: ((node: QueryNode) => number) | undefined;
  #hits = 0;
  #misses = 0;
  #collisions = 0;

  constructor(options: PlanCacheOptions) {
    this.#shapes = new LruCache(options.capacity);
    this.#writes = new LruCache(options.capacity);
    this.#keyLists = options.keyLists;
    this.#keyOf = own(options, "keyOf");
  }

  /**
   * The plan of `node` compiled as `operation` for `schema`, or `undefined` (counted as a
   * miss). `shape` is the node's structural hash and `lengths` its list lengths.
   */
  get(
    node: QueryNode,
    operation: CacheOperation,
    schema: string | undefined,
    shape: number,
    lengths: readonly number[],
  ): CompiledQuery | undefined {
    const entries = this.#identity.get(node);
    if (entries !== undefined) {
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i] as IdentityEntry;
        if (entry.operation === operation && entry.schema === schema) {
          this.#hits++;
          return entry.plan;
        }
      }
    }
    const found = this.#shapes.get(this.#key(node, operation, schema, shape, lengths));
    if (found !== undefined) {
      if (
        found.operation === operation &&
        found.schema === schema &&
        (!this.#keyLists || sameLengths(found.lengths, lengths)) &&
        sameShape(found.node, node)
      ) {
        this.#hits++;
        this.#remember(node, operation, schema, found.plan);
        return found.plan;
      }
      this.#collisions++;
    }
    this.#misses++;
    return undefined;
  }

  /** Stores the plan `get` missed, in both levels. */
  set(
    node: QueryNode,
    operation: CacheOperation,
    schema: string | undefined,
    shape: number,
    lengths: readonly number[],
    plan: CompiledQuery,
  ): void {
    this.#remember(node, operation, schema, plan);
    this.#shapes.set(this.#key(node, operation, schema, shape, lengths), {
      node,
      lengths: this.#keyLists ? lengths : NO_LENGTHS,
      operation,
      schema,
      plan,
    });
  }

  /** The row-level write plan stored under `key`, confirmed against `nodes`; `undefined` is a miss. */
  getWrite(key: string, nodes: readonly QueryNode[]): CompiledQuery | undefined {
    const found = this.#writes.get(key);
    if (found !== undefined) {
      if (sameNodes(found.nodes, nodes)) {
        this.#hits++;
        return found.plan;
      }
      this.#collisions++;
    }
    this.#misses++;
    return undefined;
  }

  /** Stores a row-level write plan under `key`. */
  setWrite(key: string, nodes: readonly QueryNode[], plan: CompiledQuery): void {
    this.#writes.set(key, { nodes, plan });
  }

  /** The counters. */
  stats(): PlanCacheStats {
    return {
      hits: this.#hits,
      misses: this.#misses,
      collisions: this.#collisions,
      size: this.#shapes.size + this.#writes.size,
    };
  }

  /** Drops every plan, at both levels and for writes. The counters are kept. */
  clear(): void {
    this.#identity = new WeakMap();
    this.#shapes.clear();
    this.#writes.clear();
  }

  #remember(
    node: QueryNode,
    operation: CacheOperation,
    schema: string | undefined,
    plan: CompiledQuery,
  ): void {
    const entry: IdentityEntry = { operation, schema, plan };
    const entries = this.#identity.get(node);
    if (entries === undefined) this.#identity.set(node, [entry]);
    else entries.push(entry);
  }

  #key(
    node: QueryNode,
    operation: CacheOperation,
    schema: string | undefined,
    shape: number,
    lengths: readonly number[],
  ): number {
    if (this.#keyOf !== undefined) return this.#keyOf(node);
    let key = hashInt(shape, OPERATION_CODES[operation]);
    key = schema === undefined ? hashInt(key, 0) : hashString(hashInt(key, 1), schema);
    if (this.#keyLists) {
      key = hashInt(key, lengths.length);
      for (let i = 0; i < lengths.length; i++) key = hashInt(key, lengths[i] as number);
    }
    return key;
  }
}

function sameLengths(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameNodes(a: readonly QueryNode[], b: readonly QueryNode[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!sameShape(a[i] as QueryNode, b[i] as QueryNode)) return false;
  return true;
}
