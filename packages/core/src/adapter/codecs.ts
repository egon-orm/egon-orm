/**
 * Type overrides from a dialect's driver fixes.
 *
 * Every type converts between its application value and one **canonical driver value**
 * per column kind (a `bigint` for `bigint`, a `Uint8Array` for `binary`, the parsed value
 * for `json`, ...). A driver that gives or takes something else for a kind declares a
 * {@link DriverCodec} for it, and the adapter composes that fix with each type's own
 * conversions. The composition happens here, once per type, so that a dialect package
 * never has to know which type it is looking at: `t.bigint()` and
 * `t.bigint({ mode: "number" })` share a kind and both get the fix before their own
 * `fromDb`.
 *
 * @module
 */
import type { AnyFieldType, Codec, DbTypeKind } from "../contracts/type.js";
import { IDENTITY } from "../contracts/type.js";
import { own } from "../internal/own.js";
import { elementTypeOf, mapElements } from "../types/composite.js";
import { detached } from "../types/define.js";

/**
 * How one driver's values for a column kind differ from the canonical driver values the
 * types expect. Either member may be left out when that direction needs nothing.
 *
 * @example
 * ```ts
 * // The driver sends int8 as text; the types expect a bigint.
 * const int8: DriverCodec = { fromDb: (value) => (typeof value === "string" ? BigInt(value) : value) };
 * ```
 */
export interface DriverCodec {
  /** The driver's value to the canonical value. Never called with `null`. */
  readonly fromDb?: (value: unknown) => unknown;
  /** The canonical value to what the driver takes. Never called with `null`. */
  readonly toDb?: (value: unknown) => unknown;
}

/**
 * The fixes of one driver, by column kind. Kinds that are not listed (and `custom` always)
 * need none. An array's elements are fixed by their own kind; a fix for `array` itself is
 * for a database without array columns, which stores the array as one value (as JSON text,
 * say): it is applied to the whole array after its elements were converted for the driver
 * (`toDb`), and before they are converted back (`fromDb`).
 *
 * @example
 * ```ts
 * const fixes: DriverCodecs = { json: { toDb: (value) => JSON.stringify(value) } };
 * ```
 */
export type DriverCodecs = Readonly<Partial<Record<Exclude<DbTypeKind, "custom">, DriverCodec>>>;

function composeFromDb(
  fix: ((value: unknown) => unknown) | undefined,
  own: (value: unknown) => unknown,
): (value: unknown) => unknown {
  if (fix === undefined) return own;
  if (own === IDENTITY) return fix;
  return (value) => own(fix(value));
}

function composeToDb(
  fix: ((value: unknown) => unknown) | undefined,
  own: (value: unknown) => unknown,
): (value: unknown) => unknown {
  if (fix === undefined) return own;
  if (own === IDENTITY) return fix;
  return (value) => fix(own(value));
}

/**
 * The `typeOverrides` function of an adapter whose driver needs `fixes`: for a type of a
 * listed kind, the type's own conversions wrapped by the fix; `undefined` otherwise, so
 * that the type's own conversions are used as they are (and `resolveCodec` applies the
 * element's override to each element of an array).
 */
export function typeOverridesFrom(fixes: DriverCodecs): (type: AnyFieldType) => Codec | undefined {
  const scalar = (type: AnyFieldType): Codec | undefined => {
    const kind = type.db.kind;
    if (kind === "array" || kind === "custom") return undefined;
    // The driver's table and its fixes are read as own keys: a key planted on
    // Object.prototype is no fix.
    const fix = own(fixes, kind);
    if (fix === undefined) return undefined;
    return Object.freeze({
      fromDb: composeFromDb(own(fix, "fromDb"), detached(type, "fromDb") as (value: unknown) => unknown),
      toDb: composeToDb(own(fix, "toDb"), detached(type, "toDb") as (value: unknown) => unknown),
    });
  };
  const arrayFix = own(fixes, "array");
  if (arrayFix === undefined) return scalar;
  /**
   * The conversions of one element: its own fix composed with its type's, nested arrays
   * element-wise. A JSON element is a value of the array's own JSON, so the JSON fix (which
   * makes text of a whole column's value) is not applied to it.
   */
  const element = (type: AnyFieldType): Codec => {
    const inner = elementTypeOf(type);
    if (inner === undefined) {
      const kind = type.db.kind;
      const fixed = kind === "json" || kind === "jsonb" ? undefined : scalar(type);
      return fixed ?? { fromDb: detached(type, "fromDb"), toDb: detached(type, "toDb") };
    }
    const codec = element(inner);
    return {
      fromDb: codec.fromDb === IDENTITY ? IDENTITY : mapElements(codec.fromDb),
      toDb: codec.toDb === IDENTITY ? IDENTITY : mapElements(codec.toDb),
    };
  };
  return (type) => {
    const inner = type.db.kind === "array" ? elementTypeOf(type) : undefined;
    if (inner === undefined) return scalar(type);
    // The whole array is one value of the database's: its elements are converted for the
    // driver, then the array is (`toDb`); the other way round when it is read.
    const codec = element(type);
    return Object.freeze({
      fromDb: composeFromDb(own(arrayFix, "fromDb"), codec.fromDb as (value: unknown) => unknown),
      toDb: composeToDb(own(arrayFix, "toDb"), codec.toDb as (value: unknown) => unknown),
    });
  };
}
