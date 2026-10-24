/**
 * Reading an option the caller gave. Options objects come from the caller, so they are
 * read as own properties only: a key planted on `Object.prototype` is never an option.
 * Internal: not exported from the package.
 *
 * @module
 */

const hasOwn = Object.hasOwn;

/**
 * The value of `options[key]` when `options` has it as an own property; `undefined`
 * otherwise, and when `options` is `undefined` or `null`.
 *
 * @example
 * ```ts
 * own({ directory: "db" }, "directory"); // "db"
 * own(Object.create({ directory: "db" }), "directory"); // undefined
 * ```
 */
export function own<O extends object, K extends keyof O>(
  options: O | null | undefined,
  key: K,
): O[K] | undefined {
  return options !== undefined && options !== null && hasOwn(options, key) ? options[key] : undefined;
}
