/**
 * `defineMigration`: what a migration file exports.
 *
 * @module
 */
import { MigrationError } from "../errors.js";
import { own } from "../internal/own.js";
import type { MigrationBuilder } from "./builder.js";

/** Marks a value made by {@link defineMigration} (`Symbol.for`, so two copies of the package agree). */
const MIGRATION: unique symbol = /* @__PURE__ */ Symbol.for("egon.migration");

/**
 * What a migration is written as: `up` makes the change, `down` undoes it. Both are
 * required. When there is nothing to undo, `down` is an empty function with a `// noop`
 * comment.
 *
 * @example
 * ```ts
 * const definition: MigrationDefinition = {
 *   up(m) {
 *     m.execute(fragment`update users set role = 'member' where role is null`);
 *   },
 *   down() {
 *     // noop: the backfill leaves nothing to undo
 *   },
 * };
 * ```
 */
export interface MigrationDefinition {
  up(m: MigrationBuilder): void | Promise<void>;
  down(m: MigrationBuilder): void | Promise<void>;
  /**
   * Runs the migration in a transaction (the default) where the database has
   * transactional DDL. `false` runs it without one, which `concurrently` index
   * operations need; a failure can then leave it half applied.
   */
  readonly transaction?: boolean;
}

/**
 * A migration, as {@link defineMigration} returns it.
 *
 * @example
 * ```ts
 * declare const migration: Migration;
 * const inTransaction = migration.transaction; // true unless the definition said false
 * ```
 */
export interface Migration {
  readonly [MIGRATION]: true;
  readonly up: (m: MigrationBuilder) => void | Promise<void>;
  readonly down: (m: MigrationBuilder) => void | Promise<void>;
  readonly transaction: boolean;
}

const KEYS = ["up", "down", "transaction"];

/**
 * Which of `up` and `down` `value` does not have as functions, for the refusals of
 * {@link defineMigration} and the loader.
 *
 * @example
 * ```ts
 * missingSteps({ up() {} }); // ["down"]
 * ```
 */
export function missingSteps(value: object): ("up" | "down")[] {
  const missing: ("up" | "down")[] = [];
  for (const key of ["up", "down"] as const) {
    if (typeof own(value as Record<string, unknown>, key) !== "function") missing.push(key);
  }
  return missing;
}

/**
 * The error that says which functions a migration lacks. A definition written with
 * `change`, which migrations do not take, gets its own identifier.
 *
 * @example
 * ```ts
 * missingStepsError("defineMigration() was given", ["down"], false).message;
 * // 'migration.missingSteps: defineMigration() was given no down(). See …'
 * ```
 */
export function missingStepsError(
  subject: string,
  missing: readonly ("up" | "down")[],
  hasChange: boolean,
  details?: { readonly version: number; readonly migration: string },
): MigrationError {
  const what = missing.map((key) => `no ${key}()`).join(" and ");
  return new MigrationError(
    hasChange ? "migration.changeNotSupported" : "migration.missingSteps",
    `${subject} ${what}.`,
    details,
  );
}

/**
 * Defines a migration: `up` makes the change and `down` undoes it; both are required.
 * Export it from the migration file as `migration` (the file `egon migrate create` writes
 * does), or as the default export.
 *
 * @example
 * ```ts
 * import { defineMigration } from "egon-orm/migration";
 *
 * export const migration = defineMigration({
 *   up(m) {
 *     m.createTable("users", (t) => {
 *       t.id();
 *       t.text("email").notNull();
 *       t.timestamps();
 *     });
 *     m.createIndex("users", ["email"], { unique: true });
 *   },
 *   down(m) {
 *     m.dropTable("users");
 *   },
 * });
 * ```
 *
 * @throws MigrationError when `up` or `down` is missing (the loader adds the file's name).
 * @throws TypeError when the definition is not an object, has an unknown key, or `up`,
 * `down` or `transaction` has the wrong type.
 */
export function defineMigration(definition: MigrationDefinition): Migration {
  if (typeof definition !== "object" || definition === null) {
    throw new TypeError(
      "defineMigration() takes an object: defineMigration({ up(m) { … }, down(m) { … } }).",
    );
  }
  // The definition is read like options: own properties only, so a key planted on
  // Object.prototype is never a step or a setting.
  const given = definition as {
    readonly up?: unknown;
    readonly down?: unknown;
    readonly transaction?: unknown;
  };
  const up = own(given, "up");
  const down = own(given, "down");
  const transaction = own(given, "transaction");
  for (const [key, value] of [
    ["up", up],
    ["down", down],
  ] as const) {
    if (value !== undefined && typeof value !== "function") {
      throw new TypeError(`defineMigration(): ${key} must be a function.`);
    }
  }
  const hasChange = Object.hasOwn(definition, "change");
  const missing = missingSteps(definition);
  if (missing.length > 0) {
    throw missingStepsError("defineMigration() was given", missing, hasChange);
  }
  for (const key of Object.keys(definition)) {
    if (!KEYS.includes(key)) {
      throw new TypeError(
        `defineMigration(): unknown key "${key}". The keys are up, down and transaction.${hasChange ? " change() is not supported: write the change in up(m) and what undoes it in down(m)." : ""}`,
      );
    }
  }
  if (transaction !== undefined && typeof transaction !== "boolean") {
    throw new TypeError("defineMigration(): transaction must be a boolean.");
  }
  type Step = (m: MigrationBuilder) => void | Promise<void>;
  return Object.freeze({
    [MIGRATION]: true as const,
    up: up as Step,
    down: down as Step,
    transaction: transaction ?? true,
  });
}

/**
 * Whether `value` was made by {@link defineMigration}.
 *
 * @example
 * ```ts
 * isMigration(defineMigration({ up() {}, down() {} })); // true
 * ```
 */
export function isMigration(value: unknown): value is Migration {
  return (
    typeof value === "object" && value !== null && (value as { [MIGRATION]?: unknown })[MIGRATION] === true
  );
}
