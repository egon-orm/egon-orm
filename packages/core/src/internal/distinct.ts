/**
 * Lists without repeats: a field name listed twice is processed once (owner decision,
 * 2026-10-24).
 *
 * @module
 */

/**
 * `items` without repeats (compared with `===`; meant for names and metadata objects), in
 * the order of their first appearance. The list itself when it has no repeats, which is the usual case: nothing is
 * allocated then.
 *
 * @example
 * ```ts
 * distinct(["email", "name", "email"]); // ["email", "name"]
 * const names = ["email", "name"];
 * distinct(names) === names; // true
 * ```
 */
export function distinct<T>(items: readonly T[]): readonly T[] {
  for (let i = 1; i < items.length; i++) {
    if (items.lastIndexOf(items[i] as T, i - 1) !== -1) return [...new Set(items)];
  }
  return items;
}
