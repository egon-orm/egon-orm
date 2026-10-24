/**
 * Every error Egon throws. Each class has a stable `code`, so callers can branch on
 * `error.code` (or use {@link isEgonError}) without depending on `instanceof`, which
 * fails when two copies of the package are loaded. Each message has a stable identifier
 * of its own, `error.id` (ADR 0007).
 *
 * A message is `<id>: <short sentence> See <docs link>`. The short sentence names what
 * failed (the schema, field, clause, parameter or SQL state); what to do about it is in
 * the docs, and in the message as well after `useFullErrorMessages(messages)` with the
 * catalog of `egon-orm/messages`. Messages never contain the value of a parameter or of a
 * redacted field.
 *
 * @module
 */
import type { ChangesetLike } from "./contracts/changeset.js";
import { own } from "./internal/own.js";
import type { messages } from "./messages/catalog.js";

/**
 * The stable codes of the error classes. {@link DatabaseError} has several, one per kind
 * of failure.
 *
 * @example
 * ```ts
 * const code: ErrorCode = "staleEntry";
 * ```
 */
export type ErrorCode =
  | "noResults"
  | "multipleResults"
  | "invalidChangeset"
  | "staleEntry"
  | "constraint"
  | "query"
  | "cast"
  | "notLoaded"
  | "rollback"
  | DatabaseErrorCode
  | "schemaDefinition"
  | "migration";

/**
 * The codes of a {@link DatabaseError}.
 *
 * - `"database"`: a driver error with no more specific code.
 * - `"connection"`: the database could not be reached, or the connection was lost.
 * - `"serializationFailure"`, `"deadlock"`: the transaction lost a conflict; retrying it is safe.
 * - `"aborted"`: the caller's `AbortSignal` fired.
 * - `"timeout"`: the statement ran longer than its `timeoutMs`.
 *
 * @example
 * ```ts
 * const code: DatabaseErrorCode = "deadlock";
 * ```
 */
export type DatabaseErrorCode =
  | "database"
  | "connection"
  | "serializationFailure"
  | "deadlock"
  | "aborted"
  | "timeout";

/**
 * The identifier of every message Egon throws, such as `"query.aliasTaken"`: a namespace
 * for the error class and a name, or the class's `code` alone for a class with one
 * message (`"noResults"`). It never changes between releases. Each has an entry in the
 * docs (the link at the end of the message).
 *
 * @example
 * ```ts
 * if (isEgonError(error) && error.id === "query.aliasTaken") renameAlias();
 * ```
 */
export type ErrorId = keyof typeof messages;

/**
 * A catalog of full messages: for an identifier, the advice that follows the short
 * sentence. `{{name}}` in an entry is replaced by the error's parameter of that name.
 * `egon-orm/messages` exports the catalog in English; a translated or shortened one has
 * the same shape, and an identifier it leaves out keeps its short message.
 *
 * @example
 * ```ts
 * const mine: ErrorCatalog = { noResults: "Check the id the client sent." };
 * ```
 */
export type ErrorCatalog = Readonly<Partial<Record<ErrorId, string>>>;

/**
 * The values named by `{{name}}` in an identifier's catalog entry. They are values the
 * short sentence shows already (a clause, a field, an association), never the value of a
 * query parameter.
 *
 * @example
 * ```ts
 * const params: ErrorParams = { association: "posts" };
 * ```
 */
export type ErrorParams = Readonly<Record<string, string | number>>;

/**
 * What an error's constructor takes besides the identifier and the short sentence.
 *
 * @example
 * ```ts
 * const details: ErrorDetails = { params: { association: "posts" }, cause: driverError };
 * ```
 */
export interface ErrorDetails {
  /** The values the catalog entry names with `{{name}}`. */
  readonly params?: ErrorParams | undefined;
  /** The underlying error, kept as `error.cause`. */
  readonly cause?: unknown;
}

/**
 * The identifiers of one namespace. Internal: for helpers that throw on behalf of their
 * callers.
 *
 * @example
 * ```ts
 * function fail(id: IdsOf<"schema">, message: string): never {
 *   throw new SchemaDefinitionError(id, message);
 * }
 * ```
 */
export type IdsOf<N extends string> = Extract<ErrorId, `${N}.${string}`>;

/** Where the docs of the identifiers are; the namespace's page and the anchor are appended. */
const DOCS = "https://egon-orm.github.io/egon-orm/reference/errors/";

/**
 * The link to an identifier's entry in the docs: one page per namespace (`general` for
 * the identifiers without one), one anchor per identifier.
 *
 * @example
 * ```ts
 * docsLink("query.aliasTaken");
 * // "https://egon-orm.github.io/egon-orm/reference/errors/query#query-aliastaken"
 * ```
 */
export function docsLink(id: ErrorId): string {
  const dot = id.indexOf(".");
  return `${DOCS}${dot < 0 ? "general" : id.slice(0, dot)}#${id.replace(".", "-").toLowerCase()}`;
}

/** The catalog set by {@link useFullErrorMessages}; `null` for short messages (the default). */
let catalog: ErrorCatalog | null = null;

/**
 * Makes every error constructed from now on carry its full message: the short sentence,
 * then the advice from `messages` (what to do about it), then the docs link. Pass the
 * catalog of `egon-orm/messages`, or one of your own with the same shape; `null` turns
 * short messages back on.
 *
 * Call it once, in the first module your application imports: an error constructed
 * before the call (a schema that fails while its module is imported) keeps its short
 * message. It applies to everything this copy of `egon-orm` throws, in every repo. It
 * needs nothing from the runtime (no `process`), so it works on Cloudflare Workers and
 * Vercel Edge too. The catalog adds its own size to the bundle of an application that
 * imports it, and nothing to one that does not.
 *
 * @example
 * ```ts
 * import { useFullErrorMessages } from "egon-orm";
 * import { messages } from "egon-orm/messages";
 *
 * useFullErrorMessages(messages);
 * ```
 *
 * @throws TypeError when `messages` is neither an object nor `null`.
 */
export function useFullErrorMessages(messages: ErrorCatalog | null): void {
  if (messages !== null && (typeof messages !== "object" || Array.isArray(messages))) {
    throw new TypeError(
      "useFullErrorMessages() takes a catalog of messages, such as the one of egon-orm/messages, or null.",
    );
  }
  catalog = messages;
}

/** Replaces each `{{name}}` of a catalog entry with the parameter of that name. */
function fill(advice: string, params: ErrorParams | undefined): string {
  return advice.replace(/\{\{(\w+)\}\}/g, (placeholder, key: string) =>
    params !== undefined && Object.hasOwn(params, key) ? String(params[key]) : placeholder,
  );
}

/** The message of an error: the identifier, the short sentence, the advice from `from` (when given), the link. */
function compose(
  id: ErrorId,
  short: string,
  params: ErrorParams | undefined,
  from: ErrorCatalog | null = catalog,
): string {
  const gap = short.includes("\n") ? "\n\n" : " ";
  const advice = from !== null && Object.hasOwn(from, id) ? from[id] : undefined;
  const text = typeof advice === "string" ? `${short}${gap}${fill(advice, params)}` : short;
  return `${id}: ${text}${gap}See ${docsLink(id)}`;
}

/** Marks an error as Egon's across copies of the package (`Symbol.for` is process-wide). */
const BRAND: unique symbol = /* @__PURE__ */ Symbol.for("egon.error");

/** The short sentence and parameters of each error, for {@link shortMessageOf} and {@link rewrap}. */
const parts = /* @__PURE__ */ new WeakMap<
  object,
  { readonly short: string; readonly params: ErrorParams | undefined }
>();

/**
 * The base class of every error Egon throws.
 *
 * `JSON.stringify(error)` gives `{ name, code, id }`: safe to send to a client, and
 * stable to switch on. The message, the cause and any SQL stay on the server.
 *
 * @example
 * ```ts
 * try {
 *   await work();
 * } catch (error) {
 *   if (error instanceof EgonError) console.error(error.id, error.message);
 *   else throw error;
 * }
 * ```
 */
export abstract class EgonError extends Error {
  /** A stable, machine-readable code of the error class. It never changes between releases. */
  abstract readonly code: ErrorCode;
  /** The stable identifier of this message. It never changes between releases. */
  readonly id: ErrorId;
  readonly [BRAND] = true;

  /**
   * @param id The message's identifier.
   * @param message The short sentence: what failed, without advice.
   * @param details The catalog entry's parameters, and the underlying error.
   */
  constructor(id: ErrorId, message: string, details?: ErrorDetails) {
    const cause = own(details, "cause");
    super(compose(id, message, own(details, "params")), cause === undefined ? undefined : { cause });
    this.id = id;
    parts.set(this, { short: message, params: own(details, "params") });
  }

  /**
   * What `JSON.stringify` writes: the class name, the code and the identifier, and
   * nothing else (no message, cause or SQL).
   *
   * @example
   * ```ts
   * JSON.stringify(new NotLoadedError({ schema: "User", association: "posts" }));
   * // '{"name":"NotLoadedError","code":"notLoaded","id":"notLoaded"}'
   * ```
   */
  toJSON(): { readonly name: string; readonly code: ErrorCode; readonly id: ErrorId } {
    return { name: this.name, code: this.code, id: this.id };
  }
}

/**
 * The short sentence of an error, without the identifier, the advice or the link.
 * Internal: for code that adds context to an error it caught.
 *
 * @example
 * ```ts
 * shortMessageOf(error); // 'join() was given the alias "u", which this query already uses.'
 * ```
 */
export function shortMessageOf(error: EgonError): string {
  return parts.get(error)?.short ?? error.message;
}

/**
 * The full message of an error with the advice of `messages`, whatever
 * {@link useFullErrorMessages} was told; `undefined` for an error this copy of the package
 * did not construct, or whose identifier `messages` has no entry for. Internal: what
 * `explain` of `egon-orm/messages` is built on.
 *
 * @example
 * ```ts
 * fullMessageOf(error, messages) ?? error.message;
 * ```
 */
export function fullMessageOf(error: EgonError, messages: ErrorCatalog): string | undefined {
  const own = parts.get(error);
  if (own === undefined || !Object.hasOwn(messages, error.id)) return undefined;
  return compose(error.id, own.short, own.params, messages);
}

/**
 * A new error of the same class as `error`, with the same identifier and parameters, a
 * changed short sentence, and `error` as its `cause`. Internal: for code that adds
 * context (the clause it was in) to an error it caught.
 *
 * @example
 * ```ts
 * throw rewrap(error, (short) => `where(): ${short}`);
 * ```
 */
export function rewrap<E extends QueryError | CastError | SchemaDefinitionError>(
  error: E,
  change: (short: string) => string,
): E {
  const Kind = error.constructor as new (id: ErrorId, message: string, details?: ErrorDetails) => E;
  return new Kind(error.id, change(shortMessageOf(error)), {
    params: parts.get(error)?.params,
    cause: error,
  });
}

/**
 * Whether `value` is an error thrown by Egon, optionally with a given code. Unlike
 * `instanceof`, it also recognises errors created by another copy of the package (for
 * example two versions installed side by side in one dependency tree).
 *
 * @example
 * ```ts
 * try {
 *   await repo.getOrThrow(User, id);
 * } catch (error) {
 *   if (isEgonError(error, "noResults")) return notFound();
 *   throw error;
 * }
 * ```
 */
export function isEgonError(value: unknown, code?: ErrorCode): value is EgonError {
  if (typeof value !== "object" || value === null || (value as { [BRAND]?: unknown })[BRAND] !== true) {
    return false;
  }
  return code === undefined || (value as EgonError).code === code;
}

/** Appends "in query: …" when the query's text is known. */
function inQuery(query: string | undefined): string {
  return query === undefined ? "" : ` in query: ${query}`;
}

/**
 * A query that had to return a row returned none (`oneOrThrow`, `getOrThrow`, …).
 *
 * @example
 * ```ts
 * throw new NoResultsError({ query: 'from(User, "u").where(u.id = $1)' });
 * ```
 */
export class NoResultsError extends EgonError {
  override readonly name = "NoResultsError" as const;
  readonly code = "noResults" as const;
  /** A rendering of the query, without parameter values. */
  readonly query: string | undefined;

  constructor(details: { readonly query?: string; readonly cause?: unknown } = {}) {
    const query = own(details, "query");
    super("noResults", `Expected at least one result but got none${inQuery(query)}.`, {
      cause: own(details, "cause"),
    });
    this.query = query;
  }
}

/**
 * A query that may return at most one row returned more (`one`, `getBy`, …).
 *
 * @example
 * ```ts
 * throw new MultipleResultsError({ count: 3, query: 'from(User, "u")' });
 * ```
 */
export class MultipleResultsError extends EgonError {
  override readonly name = "MultipleResultsError" as const;
  readonly code = "multipleResults" as const;
  /** How many rows came back. */
  readonly count: number;
  /** A rendering of the query, without parameter values. */
  readonly query: string | undefined;

  constructor(details: { readonly count: number; readonly query?: string; readonly cause?: unknown }) {
    const query = own(details, "query");
    super("multipleResults", `Expected at most one result but got ${details.count}${inQuery(query)}.`, {
      cause: own(details, "cause"),
    });
    this.count = details.count;
    this.query = query;
  }
}

/** Fills the `{key}` placeholders of a changeset error message from its metadata. */
function interpolate(message: string, meta: Readonly<Record<string, unknown>>): string {
  return message.replace(/\{(\w+)\}/g, (placeholder, key: string) =>
    Object.hasOwn(meta, key) ? String(meta[key]) : placeholder,
  );
}

/**
 * An `…OrThrow` write was given an invalid changeset. The changeset, with its errors, is
 * on the error.
 *
 * The message lists the errors by field. It contains no field values.
 *
 * @example
 * ```ts
 * try {
 *   await repo.insertOrThrow(User.changeset(User, params));
 * } catch (error) {
 *   if (error instanceof InvalidChangesetError) return render(error.changeset.errors);
 *   throw error;
 * }
 * ```
 */
export class InvalidChangesetError<C extends ChangesetLike = ChangesetLike> extends EgonError {
  override readonly name = "InvalidChangesetError" as const;
  readonly code = "invalidChangeset" as const;
  /** What was being attempted: `"insert"`, `"update"`, … */
  readonly action: string;
  readonly changeset: C;

  constructor(details: { readonly action: string; readonly changeset: C; readonly cause?: unknown }) {
    const lines: string[] = [];
    for (const [field, errors] of Object.entries(details.changeset.errors)) {
      for (const error of errors) lines.push(`  ${field}: ${interpolate(error.message, error.meta)}`);
    }
    const listing =
      lines.length === 0 ? "  (the changeset is marked invalid but lists no errors)" : lines.join("\n");
    super(
      "invalidChangeset",
      `Could not perform ${details.action} because the changeset is invalid.\n\nErrors:\n${listing}`,
      { cause: own(details, "cause") },
    );
    this.action = details.action;
    this.changeset = details.changeset;
  }
}

/**
 * An update or delete matched no row: the row was deleted, or changed since it was read
 * (optimistic locking).
 *
 * @example
 * ```ts
 * throw new StaleEntryError({ action: "update", schema: "User" });
 * ```
 */
export class StaleEntryError extends EgonError {
  override readonly name = "StaleEntryError" as const;
  readonly code = "staleEntry" as const;
  readonly action: string;
  /** The schema's name. */
  readonly schema: string;

  constructor(details: { readonly action: string; readonly schema: string; readonly cause?: unknown }) {
    super(
      "staleEntry",
      `Attempted to ${details.action} a stale ${details.schema} row: no row matched its primary key${
        details.action === "update" ? " and lock version" : ""
      }.`,
      { cause: own(details, "cause") },
    );
    this.action = details.action;
    this.schema = details.schema;
  }
}

/**
 * The kinds of constraint violation a database reports.
 *
 * @example
 * ```ts
 * const type: ConstraintViolationType = "foreignKey";
 * ```
 */
export type ConstraintViolationType = "unique" | "foreignKey" | "check" | "exclusion" | "notNull";

/**
 * The database rejected a write because of a constraint that the changeset did not
 * declare. Declared constraints become changeset errors instead (step 13).
 *
 * @example
 * ```ts
 * throw new ConstraintError({
 *   type: "unique",
 *   constraint: "users_email_key",
 *   table: "users",
 *   column: undefined,
 *   detail: undefined,
 *   cause: driverError,
 * });
 * ```
 */
export class ConstraintError extends EgonError {
  override readonly name = "ConstraintError" as const;
  readonly code = "constraint" as const;
  readonly type: ConstraintViolationType;
  /** The constraint's name, when the database reports it. */
  readonly constraint: string | undefined;
  readonly table: string | undefined;
  readonly column: string | undefined;
  /** The database's own detail line. It may quote row values, so it is not part of `message`. */
  readonly detail: string | undefined;
  /** The statement that failed, when the adapter knows it. Parameter values are never attached. */
  readonly sql: string | undefined;

  constructor(details: {
    readonly type: ConstraintViolationType;
    readonly constraint: string | undefined;
    readonly table: string | undefined;
    readonly column: string | undefined;
    readonly detail: string | undefined;
    /** Replaces the default identifier, short sentence and parameters (step 13 names the exact call to add). */
    readonly id?: IdsOf<"constraint">;
    readonly message?: string;
    readonly params?: ErrorParams;
    readonly sql?: string;
    readonly cause?: unknown;
  }) {
    const what =
      details.type === "notNull" ? "not-null" : details.type === "foreignKey" ? "foreign-key" : details.type;
    // Every key is read as the details' own: a key planted on Object.prototype is none.
    const constraint = own(details, "constraint");
    const table = own(details, "table");
    const column = own(details, "column");
    const message = own(details, "message");
    const cause = own(details, "cause");
    const name = constraint === undefined ? "" : ` "${constraint}"`;
    const where =
      table === undefined ? "" : ` on table "${table}"${column === undefined ? "" : `, column "${column}"`}`;
    if (message !== undefined) {
      super(own(details, "id") ?? "constraint.violated", message, { params: own(details, "params"), cause });
    } else {
      super(
        "constraint.violated",
        `The database rejected the write: ${what} constraint${name}${where} was violated.`,
        { cause },
      );
    }
    this.type = details.type;
    this.constraint = constraint;
    this.table = table;
    this.column = column;
    this.detail = own(details, "detail");
    this.sql = own(details, "sql");
  }
}

/**
 * A query is wrong: it was built incorrectly, uses a feature the dialect lacks, or was
 * executed with the wrong parameters. Detected when the query is built or compiled,
 * before anything is sent to the database.
 *
 * @example
 * ```ts
 * throw new QueryError("query.fullJoinUnsupported", "FULL JOIN is not supported by sqlite.");
 * ```
 */
export class QueryError extends EgonError {
  override readonly name = "QueryError" as const;
  readonly code = "query" as const;

  /**
   * @param id The message's identifier, in the `query` namespace.
   * @param message The short sentence: what failed, without advice.
   * @param details The catalog entry's parameters, and the underlying error.
   */
  constructor(id: IdsOf<"query">, message: string, details?: ErrorDetails) {
    super(id, message, details);
  }
}

/**
 * A value could not be converted to the type it was supposed to have, outside a
 * changeset (inside one, a failed cast is a changeset error, not an exception).
 *
 * @example
 * ```ts
 * throw new CastError("cast.paramsNotObject", 'Cannot cast params of type "string" to a changeset.');
 * ```
 */
export class CastError extends EgonError {
  override readonly name = "CastError" as const;
  readonly code = "cast" as const;

  /**
   * @param id The message's identifier, in the `cast` namespace.
   * @param message The short sentence: what failed, without advice.
   * @param details The catalog entry's parameters, and the underlying error.
   */
  constructor(id: IdsOf<"cast">, message: string, details?: ErrorDetails) {
    super(id, message, details);
  }
}

/**
 * An association was needed but had not been preloaded.
 *
 * @example
 * ```ts
 * throw new NotLoadedError({ schema: "User", association: "posts" });
 * ```
 */
export class NotLoadedError extends EgonError {
  override readonly name = "NotLoadedError" as const;
  readonly code = "notLoaded" as const;
  /** The owner schema's name. */
  readonly schema: string;
  readonly association: string;

  constructor(details: { readonly schema: string; readonly association: string; readonly cause?: unknown }) {
    super("notLoaded", `Association "${details.association}" of ${details.schema} is not loaded.`, {
      params: { association: details.association },
      cause: own(details, "cause"),
    });
    this.schema = details.schema;
    this.association = details.association;
  }
}

/**
 * The database or its driver failed. The driver's error is kept as `cause`.
 *
 * `sql` is the statement that failed; parameter values are never attached.
 *
 * @example
 * ```ts
 * try {
 *   await pool.query(sql, params);
 * } catch (cause) {
 *   throw new DatabaseError("database.connectionLost", "Lost the connection to the database while running a statement.", {
 *     code: "connection",
 *     sql,
 *     cause,
 *   });
 * }
 * ```
 */
export class DatabaseError extends EgonError {
  override readonly name = "DatabaseError" as const;
  readonly code: DatabaseErrorCode;
  /** Whether running the same transaction again can succeed. */
  readonly retryable: boolean;
  readonly sql: string | undefined;

  /**
   * @param id The message's identifier, in the `database` namespace.
   * @param message The short sentence: what failed, without advice.
   * @param details The code, whether a retry can succeed, the statement, the catalog
   * entry's parameters, and the driver's error.
   */
  constructor(
    id: IdsOf<"database">,
    message: string,
    details: ErrorDetails & {
      readonly code?: DatabaseErrorCode;
      /** Defaults to true for `"serializationFailure"` and `"deadlock"`, false otherwise. */
      readonly retryable?: boolean;
      readonly sql?: string;
    } = {},
  ) {
    super(id, message, details);
    this.code = own(details, "code") ?? "database";
    this.retryable =
      own(details, "retryable") ?? (this.code === "serializationFailure" || this.code === "deadlock");
    this.sql = own(details, "sql");
  }
}

/**
 * A transaction was rolled back where its caller expected a value: `transactionOrThrow`
 * throws it instead of returning `{ success: false, error: reason }`. `reason` is what
 * `repo.transaction` would have returned as `error`: the value given to
 * `tx.rollback(reason)`, a batch's `{ step, error, completed }`, or the error of a
 * statement that failed inside the transaction and was not handled.
 *
 * @example
 * ```ts
 * try {
 *   await repo.transactionOrThrow(async (tx) => {
 *     const order = await tx.insertOrThrow(change(Order, { total }));
 *     if (order.total > limit) tx.rollback("over the limit");
 *     return order;
 *   });
 * } catch (error) {
 *   if (error instanceof RollbackError) return error.reason; // "over the limit"
 *   throw error;
 * }
 * ```
 */
export class RollbackError<R = unknown> extends EgonError {
  override readonly name = "RollbackError" as const;
  readonly code = "rollback" as const;
  /** Why the transaction was rolled back. */
  readonly reason: R;

  constructor(details: {
    readonly reason: R;
    /** Replaces the default identifier and short sentence (`rollback.called`). */
    readonly id?: IdsOf<"rollback">;
    readonly message?: string;
    readonly params?: ErrorParams;
    readonly cause?: unknown;
  }) {
    super(
      own(details, "id") ?? "rollback.called",
      own(details, "message") ??
        "The transaction was rolled back: tx.rollback(reason) was called, and the reason is error.reason.",
      { params: own(details, "params"), cause: own(details, "cause") },
    );
    this.reason = details.reason;
  }
}

/**
 * A schema is declared wrongly: no primary key, a duplicate column, an association whose
 * foreign key does not exist. Thrown when the class is defined, or the first time its
 * associations are resolved.
 *
 * @example
 * ```ts
 * throw new SchemaDefinitionError(
 *   "schema.foreignKeyMissing",
 *   'Post.author: belongsTo expects the foreign key field "authorId" on Post, but Post has no such field.',
 * );
 * ```
 */
export class SchemaDefinitionError extends EgonError {
  override readonly name = "SchemaDefinitionError" as const;
  readonly code = "schemaDefinition" as const;

  /**
   * @param id The message's identifier, in the `schema` namespace.
   * @param message The short sentence: what failed, without advice.
   * @param details The catalog entry's parameters, and the underlying error.
   */
  constructor(id: IdsOf<"schema">, message: string, details?: ErrorDetails) {
    super(id, message, details);
  }
}

/**
 * A migration could not be defined, loaded or run: a migration without `up` or `down`, an
 * operation the database lacks, a recorded version whose file is missing, the migration
 * lock, or a statement that failed (the driver's error is kept as `cause`).
 *
 * `version` and `migration` name the migration when the error belongs to one; `sql` is
 * the statement that failed, without parameter values.
 *
 * @example
 * ```ts
 * throw new MigrationError(
 *   "migration.noDown",
 *   'Cannot load the migration file "20261012093000_drop_age.ts": defineMigration() was given no down().',
 *   { version: 20261012093000, migration: "drop_age" },
 * );
 * ```
 */
export class MigrationError extends EgonError {
  override readonly name = "MigrationError" as const;
  readonly code = "migration" as const;
  /** The version of the migration the error belongs to, when there is one. */
  readonly version: number | undefined;
  /** The name of that migration: its file name without the version and the extension. */
  readonly migration: string | undefined;
  /** The statement that failed, when a statement failed. Parameter values are never attached. */
  readonly sql: string | undefined;

  /**
   * @param id The message's identifier, in the `migration` namespace.
   * @param message The short sentence: what failed, without advice.
   * @param details The migration, the statement, the catalog entry's parameters, and the
   * underlying error.
   */
  constructor(
    id: IdsOf<"migration">,
    message: string,
    details: ErrorDetails & {
      readonly version?: number;
      readonly migration?: string;
      readonly sql?: string;
    } = {},
  ) {
    super(id, message, details);
    this.version = own(details, "version");
    this.migration = own(details, "migration");
    this.sql = own(details, "sql");
  }
}
