/**
 * Transactions: `repo.transaction(fn | batch, options?)`, `transactionOrThrow`, nesting
 * with savepoints, `tx.rollback(reason)`, `repo.checkout(fn)`, the multi-statement
 * primitive the bulk writes use, and the machinery of the test sandbox.
 *
 * ## The pieces
 *
 * - A {@link Session} is one checked-out connection. Every statement on it goes through
 *   its queue, one at a time: a statement issued while another runs waits for it (so a
 *   cancel request can only ever reach the statement it was meant for), and the wait
 *   counts against the statement's `timeoutMs`. The session also remembers the first
 *   statement that failed inside a transaction: on Postgres that aborts the transaction
 *   until it, or a savepoint, is rolled back, and the session refuses to commit it, on
 *   every dialect alike.
 * - A {@link Level} is one scope on a session, and the executor of the repo bound to it:
 *   a transaction (`BEGIN`), a savepoint inside one, a checkout (no transaction), or the
 *   sandbox's transaction. A level checks every statement before it reaches the queue:
 *   it refuses statements once its callback has ended (a promise that leaked out of the
 *   callback), after `tx.rollback()`, while a nested transaction is open on it (the outer
 *   `tx` used inside the inner callback) and while a stream is open on the connection.
 * - The root repo's {@link RootScope} knows whether a sandbox has taken the repo over.
 *
 * The transaction statements themselves (`BEGIN`, `SAVEPOINT`, `COMMIT`, ...) are the
 * adapter's `Connection` methods, which write each dialect's syntax. Each is sent with
 * what is left of the level's `timeoutMs` budget (a rollback with none: it must not be cut
 * short by the budget that may have caused it), and with a `Call` as its context, so that
 * it is one of the repo's `query` events (operation `"transaction"`). The sandbox's own
 * statements (its `BEGIN` and `ROLLBACK`, the savepoint around each of its statements)
 * are neither: they are not the application's.
 *
 * @module
 */
import type { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseAdapter } from "../adapter/adapter.js";
import { type Batch, firstInvalid, isBatch, runSteps } from "../batch/batch.js";

/** A batch of any results and failures. */
type AnyBatch = Batch<object, unknown>;

import type {
  BeginOptions,
  Connection,
  ExecuteOptions,
  Executor,
  IsolationLevel,
  RawResult,
  StreamOptions,
} from "../contracts/adapter.js";
import { failure, type Result, success } from "../contracts/result.js";
import { DatabaseError, isEgonError, QueryError, RollbackError } from "../errors.js";
import { own } from "../internal/own.js";
import { isPlainObject } from "../internal/plain-object.js";
import type { ReadOptions } from "./options.js";
import { Call, type QueryHub, ReadCore } from "./read.js";
import type { Repo } from "./repo.js";
import { acquireWithin, overBudget } from "./write.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * The options of `repo.transaction` and `repo.transactionOrThrow`.
 *
 * - `isolation`: the isolation level of the transaction. Not on a nested transaction.
 * - `readOnly`: begins a read-only transaction. Not on a nested transaction.
 * - `retries`: how many times to run the callback again after a serialisation failure or
 *   a deadlock (`DatabaseError.retryable`), with a randomised, growing pause in between.
 *   The callback must be safe to run again. Default 0. Not on a nested transaction.
 * - `timeoutMs`: the time budget of the whole call, in milliseconds: the wait for a
 *   connection, every statement (`BEGIN`, `SAVEPOINT` and `COMMIT` too) and every retry.
 *   When it runs out, the running statement is cancelled, the transaction is rolled back
 *   and the call rejects with `DatabaseError`, code `"timeout"`. The `ROLLBACK` is not cut
 *   short.
 *
 * @example
 * ```ts
 * const options: TransactionOptions = { isolation: "serializable", retries: 3, timeoutMs: 5_000 };
 * ```
 */
export interface TransactionOptions {
  readonly isolation?: IsolationLevel | undefined;
  readonly readOnly?: boolean | undefined;
  readonly retries?: number | undefined;
  readonly timeoutMs?: number | undefined;
}

const TRANSACTION_OPTION_KEYS: readonly string[] = /* @__PURE__ */ Object.freeze([
  "isolation",
  "readOnly",
  "retries",
  "timeoutMs",
]);

const ISOLATION_LEVELS: readonly string[] = /* @__PURE__ */ Object.freeze([
  "read committed",
  "repeatable read",
  "serializable",
]);

/** The checked options of one call. */
interface Settings {
  readonly begin: BeginOptions | undefined;
  readonly retries: number;
  readonly timeoutMs: number | undefined;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? "an object" : `${typeof value} ${String(value)}`;
}

/**
 * Checks the options of a transaction call.
 *
 * @throws TypeError when an option is unknown or has the wrong type.
 */
function settingsOf(method: string, options: unknown): Settings {
  if (options === undefined) return NO_SETTINGS;
  if (typeof options !== "object" || options === null || !isPlainObject(options)) {
    throw new TypeError(
      `repo.${method}(fn, options): options must be an object, but it is ${describe(options)}.`,
    );
  }
  const given = options as Record<string, unknown>;
  for (const key of Object.keys(given)) {
    if (!TRANSACTION_OPTION_KEYS.includes(key)) {
      throw new TypeError(
        `repo.${method}(fn, options): unknown option "${key}". The options are ${TRANSACTION_OPTION_KEYS.join(", ")}.`,
      );
    }
  }
  const isolation = own(given, "isolation");
  const readOnly = own(given, "readOnly");
  const retries = own(given, "retries");
  const timeoutMs = own(given, "timeoutMs");
  if (isolation !== undefined && (typeof isolation !== "string" || !ISOLATION_LEVELS.includes(isolation))) {
    throw new TypeError(
      `repo.${method}(fn, { isolation }): isolation must be "read committed", "repeatable read" or "serializable", but it is ${describe(isolation)}.`,
    );
  }
  if (readOnly !== undefined && typeof readOnly !== "boolean") {
    throw new TypeError(
      `repo.${method}(fn, { readOnly }): readOnly must be true or false, but it is ${describe(readOnly)}.`,
    );
  }
  if (
    retries !== undefined &&
    (typeof retries !== "number" || !Number.isSafeInteger(retries) || retries < 0)
  ) {
    throw new TypeError(
      `repo.${method}(fn, { retries }): retries must be a whole number of 0 or more, but it is ${describe(retries)}.`,
    );
  }
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 0)
  ) {
    throw new TypeError(
      `repo.${method}(fn, { timeoutMs }): timeoutMs must be a non-negative number of milliseconds, but it is ${describe(timeoutMs)}.`,
    );
  }
  let begin: BeginOptions | undefined;
  if (isolation !== undefined || readOnly !== undefined) {
    begin = {
      ...(isolation === undefined ? {} : { isolation: isolation as IsolationLevel }),
      ...(readOnly === undefined ? {} : { readOnly }),
    };
  }
  return { begin, retries: retries ?? 0, timeoutMs };
}

const NO_SETTINGS: Settings = /* @__PURE__ */ Object.freeze({
  begin: undefined,
  retries: 0,
  timeoutMs: undefined,
});

// ---------------------------------------------------------------------------
// Errors and signals
// ---------------------------------------------------------------------------

/** "Nothing here": no failure, no rollback reason. Distinct from every value a user can pass. */
const NONE: unique symbol = /* @__PURE__ */ Symbol("none");
type Maybe<T> = T | typeof NONE;

const now = (): number => performance.now();

/**
 * What `tx.rollback(reason)` throws: caught by the transaction it names, which rolls
 * back and returns `failure(reason)`. It is an `Error` so that, should it escape (a
 * rollback called from a callback that outlived the transaction's), it reads as one.
 */
class RollbackSignal extends Error {
  constructor(
    readonly level: Level,
    readonly reason: unknown,
  ) {
    super(
      "tx.rollback() was called. This error is caught by the transaction it belongs to; seeing it means the call happened outside that transaction's callback.",
    );
    this.name = "RollbackSignal";
  }
}

function completedError(level: Level): QueryError {
  switch (level.kind) {
    case "checkout":
      return new QueryError(
        "query.checkoutEnded",
        "This checkout already ended: the repo it gave was used after its callback returned or threw (a promise that outlived the callback?).",
      );
    case "sandbox":
      return new QueryError(
        "query.sandboxRolledBack",
        "This sandbox transaction was already rolled back: sandbox.rollback() ran before this call.",
      );
    default:
      return new QueryError(
        "query.transactionEnded",
        "transaction already completed: tx was used after its callback returned or threw (a promise that outlived the callback?).",
      );
  }
}

function rolledBackError(): QueryError {
  return new QueryError(
    "query.transactionRollingBack",
    "tx.rollback() was called on this transaction, so it takes no more statements: it is being rolled back.",
  );
}

function childOpenError(): QueryError {
  return new QueryError("query.nestedTransactionOpen", "A nested transaction is open on this tx.");
}

function streamOpenError(): QueryError {
  return new QueryError(
    "query.transactionStreamOpen",
    "A stream is still open on this transaction's connection.",
  );
}

function failedError(cause: unknown): QueryError {
  return new QueryError(
    "query.transactionFailed",
    "A statement in this transaction failed (see the cause), so the transaction can only be rolled back: Postgres refuses every further statement in it, and Egon does the same on every database.",
    { cause },
  );
}

function brokenError(cause: unknown): QueryError {
  return new QueryError(
    "query.savepointRollbackFailed",
    "This transaction could not roll back to one of its savepoints (see the cause), so its state is unknown: it can only be rolled back as a whole.",
    { cause },
  );
}

/** Whether a statement's error came from the database (so that, on Postgres, it aborted the transaction). */
function fromDatabase(error: unknown): boolean {
  return isEgonError(error) && DATABASE_CODES.includes(error.code);
}

/** The codes of `ConstraintError` and `DatabaseError`: errors the database reported for a statement it ran. */
const DATABASE_CODES: readonly string[] = /* @__PURE__ */ Object.freeze([
  "constraint",
  "database",
  "connection",
  "serializationFailure",
  "deadlock",
  "aborted",
  "timeout",
]);

function isRetryable(error: unknown): boolean {
  return isEgonError(error) && (error as { readonly retryable?: unknown }).retryable === true;
}

/** Keeps a failure of the cleanup on the error being rethrown, as `error.suppressed`. */
function attachSuppressed(error: unknown, suppressed: unknown): void {
  if (typeof error !== "object" || error === null || !Object.isExtensible(error)) return;
  if (Object.hasOwn(error, "suppressed")) return;
  Object.defineProperty(error, "suppressed", {
    value: suppressed,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

function transactionTimeout(level: Level, sql: string | undefined, cause: unknown): DatabaseError {
  return new DatabaseError(
    "database.transactionTimeout",
    `The transaction ran longer than its timeoutMs (${level.timeoutMs} ms), which covers every statement in it, so it was stopped and rolled back.`,
    { code: "timeout", ...(sql === undefined ? {} : { sql }), cause },
  );
}

// ---------------------------------------------------------------------------
// The session: one connection, one statement at a time
// ---------------------------------------------------------------------------

const NO_PARAMS: readonly unknown[] = /* @__PURE__ */ Object.freeze([]);

/** A statement (or a transaction statement, `work`) waiting for the connection. */
class Waiting {
  done = false;
  timer: ReturnType<typeof setTimeout> | undefined = undefined;
  onAbort: (() => void) | undefined = undefined;

  constructor(
    readonly level: Level | undefined,
    readonly sql: string,
    readonly params: readonly unknown[],
    readonly options: ExecuteOptions | undefined,
    readonly work: (() => Promise<unknown>) | undefined,
    readonly since: number,
    readonly resolve: (value: unknown) => void,
    readonly reject: (error: unknown) => void,
  ) {}

  stop(): void {
    this.done = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    if (this.onAbort !== undefined) own(this.options, "signal")?.removeEventListener("abort", this.onAbort);
  }
}

/** One checked-out connection and its queue. */
export class Session {
  /** Whether a statement is running on the connection now. */
  busy = false;
  readonly #queue: Waiting[] = [];
  /** Streams open on the connection: statements are refused meanwhile. */
  streams = 0;
  /** The first statement that failed inside a transaction since it, or the savepoint last rolled back to, began. */
  failure: Maybe<unknown> = NONE;
  /** A savepoint could not be released or rolled back to: only a full rollback ends this transaction now. */
  broken: Maybe<unknown> = NONE;
  /** How many transactions and savepoints are open: a failed statement aborts the transaction only then. */
  transactions = 0;
  /** Set when a `ROLLBACK` failed: the connection is closed instead of returned to the pool. */
  destroy = false;
  /** The failure the last transaction on this connection ended with, if any: a retry may follow it. */
  endedWith: Maybe<unknown> = NONE;

  constructor(
    readonly connection: Connection,
    /** The repo the session belongs to; `undefined` for a bulk write's own transaction. */
    readonly root: RootScope | undefined,
    /** The `query` listeners of the repo whose statements run on the session. */
    readonly hub: QueryHub,
  ) {}

  /** Runs a statement now, or when the statements before it are done. */
  execute(
    level: Level,
    sql: string,
    params: readonly unknown[],
    options: ExecuteOptions | undefined,
  ): Promise<RawResult> {
    if (this.busy) return this.#wait(level, sql, params, options, undefined) as Promise<RawResult>;
    // Refused here rather than by the adapter: a statement that was never sent must not
    // count as one that failed in the transaction.
    if (own(options, "signal")?.aborted === true) return Promise.reject(abortedBeforeRun(sql));
    return this.#send(sql, params, options);
  }

  /**
   * Runs one statement in a savepoint of its own (`egon_statement`), released when it
   * succeeds and rolled back to when it fails, so that its failure undoes only itself and
   * the transaction stays usable: how the sandbox runs the statements made on its own
   * level, which outside the sandbox would each run alone.
   */
  isolated(sql: string, params: readonly unknown[], options: ExecuteOptions | undefined): Promise<RawResult> {
    if (own(options, "signal")?.aborted === true) return Promise.reject(abortedBeforeRun(sql));
    const connection = this.connection;
    return this.control(async () => {
      await connection.savepoint(STATEMENT_SAVEPOINT);
      let result: RawResult;
      try {
        result = await connection.execute(sql, params, options);
      } catch (error) {
        try {
          await connection.rollbackTo(STATEMENT_SAVEPOINT);
        } catch (lost) {
          if (this.broken === NONE) this.broken = lost;
          attachSuppressed(error, lost);
        }
        throw error;
      }
      await connection.releaseSavepoint(STATEMENT_SAVEPOINT);
      return result;
    });
  }

  /**
   * Runs `work` (transaction statements) when the connection is free; nothing else runs
   * meanwhile. With `within`, the wait for the connection counts against that level's
   * budget (or that of the write that opened it): when the budget runs out first, `work`
   * never runs and the call rejects with the budget's timeout.
   */
  control<T>(work: () => Promise<T>, within?: Level): Promise<T> {
    if (!this.busy) return this.#control(work);
    return this.#wait(within, "", NO_PARAMS, undefined, work) as Promise<T>;
  }

  #control<T>(work: () => Promise<T>): Promise<T> {
    this.busy = true;
    let promise: Promise<T>;
    try {
      promise = work();
    } catch (error) {
      promise = Promise.reject(error);
    }
    promise.then(this.#free, this.#free);
    return promise;
  }

  #send(sql: string, params: readonly unknown[], options: ExecuteOptions | undefined): Promise<RawResult> {
    this.busy = true;
    const promise = this.connection.execute(sql, params, options);
    promise.then(this.#free, this.#failed);
    return promise;
  }

  readonly #free = (): void => {
    this.busy = false;
    this.#next();
  };

  readonly #failed = (error: unknown): void => {
    this.fail(error);
    this.busy = false;
    this.#next();
  };

  /** Records a statement's failure when it aborted (or, on other databases, would have aborted) the transaction. */
  fail(error: unknown): void {
    if (this.failure === NONE && this.transactions > 0 && fromDatabase(error)) this.failure = error;
  }

  #wait(
    level: Level | undefined,
    sql: string,
    params: readonly unknown[],
    options: ExecuteOptions | undefined,
    work: (() => Promise<unknown>) | undefined,
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const entry = new Waiting(level, sql, params, options, work, now(), resolve, reject);
      // `stop()` removes the listener and the timer once the entry runs or gives up, so
      // neither fires for an entry that is done.
      const signal = own(options, "signal");
      if (signal !== undefined) {
        entry.onAbort = () => {
          entry.stop();
          reject(
            new DatabaseError(
              "database.abortedQueued",
              "The statement was not run: its AbortSignal fired while it waited for the statements before it on this transaction's connection.",
              { code: "aborted", sql },
            ),
          );
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      const timeoutMs = own(options, "timeoutMs");
      if (timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          entry.stop();
          reject(waitedTooLong(sql, timeoutMs));
        }, timeoutMs);
      } else if (work !== undefined && level !== undefined) {
        // Transaction statements waiting for the connection: the level's budget (or its
        // owning call's) bounds the wait.
        const deadline = statementDeadline(level);
        if (deadline !== undefined) {
          entry.timer = setTimeout(
            () => {
              entry.stop();
              reject(budgetError(level, undefined, undefined));
            },
            Math.max(0, deadline - now()),
          );
        }
      }
      this.#queue.push(entry);
    });
  }

  #next(): void {
    while (!this.busy && this.#queue.length > 0) {
      const entry = this.#queue.shift() as Waiting;
      if (entry.done) continue;
      entry.stop();
      const work = entry.work;
      if (work !== undefined) {
        this.#control(work).then(entry.resolve, entry.reject);
        return;
      }
      const refused = (entry.level as Level).queuedRefusal();
      if (refused !== undefined) {
        entry.reject(refused);
        continue;
      }
      let options = entry.options;
      const timeoutMs = own(options, "timeoutMs");
      if (timeoutMs !== undefined) {
        const left = timeoutMs - (now() - entry.since);
        if (left <= 0) {
          entry.reject(waitedTooLong(entry.sql, timeoutMs));
          continue;
        }
        options = { ...options, timeoutMs: left };
      }
      if (own(options, "signal")?.aborted === true) {
        entry.reject(abortedBeforeRun(entry.sql));
        continue;
      }
      this.#send(entry.sql, entry.params, options).then(entry.resolve, entry.reject);
    }
  }
}

/** The name of the savepoint the sandbox runs each of its own statements in. */
const STATEMENT_SAVEPOINT = "egon_statement";

function abortedBeforeRun(sql: string): DatabaseError {
  return new DatabaseError(
    "database.abortedBefore",
    "The statement was not run: its AbortSignal had fired.",
    { code: "aborted", sql },
  );
}

function waitedTooLong(sql: string, timeoutMs: number): DatabaseError {
  return new DatabaseError(
    "database.timeoutQueued",
    `The statement was not run: it waited longer than its timeoutMs (${timeoutMs} ms) for the statements before it on this transaction's connection.`,
    { code: "timeout", sql },
  );
}

// ---------------------------------------------------------------------------
// Levels: the scopes on a session, and the executors of the repos bound to them
// ---------------------------------------------------------------------------

/**
 * - `transaction`: `BEGIN` … `COMMIT` / `ROLLBACK`.
 * - `savepoint`: a nested transaction, `SAVEPOINT` … `RELEASE` / `ROLLBACK TO`.
 * - `checkout`: one connection, no transaction.
 * - `sandbox`: the test sandbox's transaction, always rolled back.
 */
type LevelKind = "transaction" | "savepoint" | "checkout" | "sandbox";

/**
 * The repo call (a write of several statements) that a level was opened for: the
 * transaction statements of the level carry its signal and context, and stay within its
 * budget, as its other statements do.
 */
interface Owner {
  readonly options: ReadOptions;
  /** The call's deadline (`performance.now()` based); `undefined` without `timeoutMs`. */
  readonly deadline: number | undefined;
}

/** One scope on a session; the executor of the repo bound to it. */
export class Level implements Executor {
  /** `closing` once its callback ended: what it issued before still runs, nothing new is accepted. */
  state: "open" | "closing" | "ended" = "open";
  /** The reason given to `tx.rollback(reason)`; the level then ends with a rollback, whatever its callback does next. */
  rollbackReason: Maybe<unknown> = NONE;
  /** Set when the level ends with a rollback: its statements still waiting are not run. */
  discard = false;
  /** The nested transaction open on this level. */
  child: Level | undefined = undefined;
  /** Nested transactions waiting for {@link child} to end before they begin. */
  readonly #turns: { readonly resolve: () => void; readonly reject: (error: unknown) => void }[] = [];
  /** Whether the root-use warning was given for this transaction. */
  warned = false;
  /** Set when this level's budget ran out (a statement was stopped by it, or its timer fired): it then ends in a timeout. */
  timedOut = false;

  constructor(
    readonly session: Session,
    readonly parent: Level | undefined,
    readonly kind: LevelKind,
    /** 0 for a transaction, a checkout and the sandbox; 1, 2, … for savepoints, which are named `egon_<depth>`. */
    readonly depth: number,
    /** The `performance.now()` time by which the level must end, its own or its parent's, whichever is first. */
    readonly deadline: number | undefined,
    /** The `timeoutMs` that set {@link deadline}, for the messages. */
    readonly timeoutMs: number | undefined,
    /** The write of several statements this level was opened for, if any (`atomically`). */
    readonly owner: Owner | undefined = undefined,
  ) {}

  /** Whether the repo bound to this level is inside a transaction. */
  get inTransaction(): boolean {
    return this.kind !== "checkout";
  }

  /** Why a statement issued on this level now cannot run; `undefined` when it can. */
  refusal(): unknown {
    if (this.state !== "open") return completedError(this);
    if (this.rollbackReason !== NONE) return rolledBackError();
    if (this.child !== undefined && this.kind !== "sandbox") return childOpenError();
    // The budget is spent (perhaps before its timer fired): that, not what it caused, is the reason.
    if (this.timedOut || (this.deadline !== undefined && now() >= this.deadline)) {
      return transactionTimeout(this, undefined, undefined);
    }
    return this.sessionRefusal();
  }

  /** Records that the budget ran out, here and on the enclosing levels whose budget it was. */
  expire(): void {
    let level: Level | undefined = this;
    while (level !== undefined && level.deadline === this.deadline) {
      level.timedOut = true;
      level = level.parent;
    }
  }

  /** Why nothing new can run on the connection now. */
  sessionRefusal(): unknown {
    const session = this.session;
    if (session.broken !== NONE) return brokenError(session.broken);
    if (session.failure !== NONE) return failedError(session.failure);
    if (session.streams > 0) return streamOpenError();
    return undefined;
  }

  /** Why a statement that waited in the queue must not run after all. */
  queuedRefusal(): unknown {
    if (this.discard || this.state === "ended") return completedError(this);
    return this.sessionRefusal();
  }

  execute(sql: string, params: readonly unknown[], options?: ExecuteOptions): Promise<RawResult> {
    const refused = this.refusal();
    if (refused !== undefined) return Promise.reject(refused);
    // Outside the sandbox, each of these statements would run alone: a failure would undo
    // only itself. A savepoint per statement keeps it so inside the sandbox's transaction.
    if (this.kind === "sandbox") {
      const inside = insideCallback(this);
      if (inside !== undefined) return Promise.reject(inside);
      // Outside the repo's open transaction, as in production: after it, not inside it.
      if (this.child !== undefined) return this.#afterChild(sql, params, options);
      return this.session.isolated(sql, params, options);
    }
    if (this.deadline === undefined) return this.session.execute(this, sql, params, options);
    return this.#withinDeadline(sql, params, options, this.deadline);
  }

  /**
   * The sandbox: a statement of the repo itself, made from outside the transaction the repo
   * has open (a concurrent request in the test), waits for that transaction to end, so that
   * its rollback cannot take the statement with it. Outside the sandbox it would run on
   * another connection.
   */
  async #afterChild(
    sql: string,
    params: readonly unknown[],
    options: ExecuteOptions | undefined,
  ): Promise<RawResult> {
    while (this.child !== undefined) await this.turn();
    const refused = this.refusal();
    if (refused !== undefined) throw refused;
    // Checked and sent in one step: a transaction that begins now queues its SAVEPOINT after it.
    return this.session.isolated(sql, params, options);
  }

  async #withinDeadline(
    sql: string,
    params: readonly unknown[],
    options: ExecuteOptions | undefined,
    deadline: number,
  ): Promise<RawResult> {
    // Positive: `refusal()` has just checked that the deadline is still ahead.
    const left = Math.max(0, deadline - now());
    const given = own(options, "timeoutMs");
    if (given !== undefined && given <= left) return this.session.execute(this, sql, params, options);
    try {
      return await this.session.execute(this, sql, params, { ...options, timeoutMs: left });
    } catch (error) {
      if (!isEgonError(error, "timeout")) throw error;
      this.expire();
      throw transactionTimeout(this, sql, error);
    }
  }

  stream(
    sql: string,
    params: readonly unknown[],
    options?: StreamOptions,
  ): AsyncIterable<Record<string, unknown>> {
    return this.#streamRows(sql, params, options);
  }

  async *#streamRows(
    sql: string,
    params: readonly unknown[],
    options: StreamOptions | undefined,
  ): AsyncGenerator<Record<string, unknown>, void, undefined> {
    const refused = this.refusal();
    if (refused !== undefined) throw refused;
    if (this.kind === "sandbox") {
      const inside = insideCallback(this);
      if (inside !== undefined) throw inside;
      while (this.child !== undefined) await this.turn();
    }
    const session = this.session;
    // Wait for the statements before it; from then on, other statements are refused.
    await session.control(async () => {
      session.streams++;
    });
    let given = options;
    if (this.deadline !== undefined) {
      const left = Math.max(0, this.deadline - now());
      const timeoutMs = own(given, "timeoutMs");
      if (timeoutMs === undefined || timeoutMs > left) given = { ...given, timeoutMs: left };
    }
    try {
      yield* session.connection.stream(sql, params, given);
    } catch (error) {
      session.fail(error);
      throw error;
    } finally {
      session.streams--;
    }
  }

  /** Resolves when the nested transaction open on this level ends; rejects when this level ends first. */
  turn(): Promise<void> {
    return new Promise<void>((resolve, reject) => this.#turns.push({ resolve, reject }));
  }

  /**
   * Wakes everything waiting for the nested transaction to end: the next nested transaction
   * takes the level (synchronously, when it wakes), the others wait again.
   */
  nextTurn(): void {
    for (const turn of this.#turns.splice(0)) turn.resolve();
  }

  /** Ends this level and every level nested in it, without statements: an enclosing level is ending. */
  abandon(): void {
    this.state = "ended";
    this.discard = true;
    this.refuseTurns();
    this.child?.abandon();
  }

  /** Rejects the nested transactions waiting to begin on this level. */
  refuseTurns(): void {
    for (const turn of this.#turns.splice(0)) turn.reject(completedError(this));
  }
}

// ---------------------------------------------------------------------------
// The root repo's scope, and the development-mode warning
// ---------------------------------------------------------------------------

/** Makes a repo over a core, bound to a scope (repo.ts passes its `DatabaseRepo` constructor). */
export type RepoFactory = (core: ReadCore, scope: Scope) => Repo;

/** The state of a repo made by `createRepo`. */
export class RootScope {
  /** The sandbox's transaction while a sandbox has taken the repo over. */
  sandbox: Level | undefined = undefined;

  constructor(
    readonly core: ReadCore,
    readonly makeRepo: RepoFactory,
    /** Whether the development-mode root-use warning is on. */
    readonly watch: boolean,
  ) {}
}

/** What a repo is bound to: the root (the pool), or a level on one connection. */
export type Scope = RootScope | Level;

const roots = /* @__PURE__ */ new WeakMap<object, RootScope>();

let storage: AsyncLocalStorage<Level> | undefined;

/** The store that tells the root repo it is being used inside one of its transactions' callbacks. */
function watchStorage(): AsyncLocalStorage<Level> {
  if (storage === undefined) {
    const hooks = process.getBuiltinModule("node:async_hooks");
    storage = new hooks.AsyncLocalStorage<Level>();
  }
  return storage;
}

/**
 * The root repo's executor when the root-use warning is on: the adapter, with a check of
 * whether the call comes from inside one of the repo's transaction callbacks.
 */
class RootWatch implements Executor {
  constructor(
    readonly adapter: DatabaseAdapter,
    readonly root: RootScope,
  ) {}

  execute(sql: string, params: readonly unknown[], options?: ExecuteOptions): Promise<RawResult> {
    this.check();
    return this.adapter.execute(sql, params, options);
  }

  stream(
    sql: string,
    params: readonly unknown[],
    options?: StreamOptions,
  ): AsyncIterable<Record<string, unknown>> {
    this.check();
    return this.adapter.stream(sql, params, options);
  }

  check(): void {
    warnIfInside(this.root);
  }
}

function warnIfInside(root: RootScope): void {
  if (!root.watch) return;
  const level = watchStorage().getStore();
  if (level === undefined || level.session.root !== root || level.state !== "open" || level.warned) return;
  level.warned = true;
  process.emitWarning(
    "The repo was used inside one of its own transaction callbacks. Only calls on the tx the callback was given are inside the transaction; this call ran on another connection, outside it, and is not rolled back with it. Pass tx to the code you call. (warnOnRootUseInTransaction: this warning is given once per transaction, and never when NODE_ENV is production.)",
    { code: "EGON_ROOT_IN_TRANSACTION" },
  );
}

/**
 * In the sandbox: the error for a call on the repo itself (or the sandbox's repo) made from
 * inside one of the repo's transaction callbacks; `undefined` for any other call. Outside
 * the sandbox such a call runs on another connection, outside the transaction; on the
 * sandbox's one connection it can only run inside it (where a rollback would take it
 * along) or wait for it (which waits for the call: a deadlock), so it is refused.
 */
function insideCallback(sandbox: Level): QueryError | undefined {
  const level = storage?.getStore();
  if (
    level === undefined ||
    level === sandbox ||
    level.session !== sandbox.session ||
    level.state !== "open"
  ) {
    return undefined;
  }
  return new QueryError(
    "query.rootInSandboxTransaction",
    "The repo was used inside one of its own transaction callbacks, in the test sandbox.",
  );
}

/**
 * Sets up the scope of a repo made by `createRepo`, and installs the root-use warning when
 * asked for outside production.
 */
export function createRoot(repo: object, core: ReadCore, makeRepo: RepoFactory, warn: boolean): RootScope {
  const watch = warn && process.env.NODE_ENV !== "production";
  const root = new RootScope(core, makeRepo, watch);
  if (watch) {
    core.executor = new RootWatch(core.adapter, root);
    core.pooled = true;
  }
  roots.set(repo, root);
  return root;
}

/** The scope of a repo made by `createRepo`; `undefined` for anything else (a transaction's repo too). */
export function rootOf(repo: unknown): RootScope | undefined {
  return typeof repo === "object" && repo !== null ? roots.get(repo) : undefined;
}

/** A repo bound to `level`, sharing the adapter, the defaults and the listeners of its root. */
function repoFor(root: RootScope, level: Level): Repo {
  const core = root.core;
  return root.makeRepo(new ReadCore(core.adapter, level, core.schema, core.codegen, core.hub), level);
}

// ---------------------------------------------------------------------------
// Running a level
// ---------------------------------------------------------------------------

/** How a level's callback ended. */
type Outcome =
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "rollback"; readonly reason: unknown }
  | { readonly kind: "throw"; readonly error: unknown }
  | { readonly kind: "timeout" };

const TIMED_OUT: Outcome = /* @__PURE__ */ Object.freeze({ kind: "timeout" });

/** Why a level ended in a failure, for the message of `transactionOrThrow`. */
type Why = "rollback" | "statement";

/** What a level returns: its result, and why it failed when it did. */
interface Ended {
  readonly result: Result<unknown, unknown>;
  readonly why: Why | undefined;
}

/** Runs a level's callback and says how it ended. Never rejects. */
async function body(level: Level, call: () => unknown): Promise<Outcome> {
  try {
    const value = await call();
    if (level.rollbackReason !== NONE) return { kind: "rollback", reason: level.rollbackReason };
    return { kind: "value", value };
  } catch (error) {
    if (error instanceof RollbackSignal && error.level === level)
      return { kind: "rollback", reason: error.reason };
    return { kind: "throw", error };
  }
}

/** The callback's outcome, or a timeout when the level's deadline comes first. */
async function within(level: Level, running: Promise<Outcome>): Promise<Outcome> {
  const deadline = level.deadline;
  if (deadline === undefined) return running;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<Outcome>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, deadline - now()), TIMED_OUT);
  });
  try {
    return await Promise.race([running, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The transaction statements a level sends: `BEGIN`, `SAVEPOINT`, `RELEASE SAVEPOINT`,
 * `COMMIT`, `ROLLBACK TO SAVEPOINT`, `ROLLBACK`.
 */
type Statement = "begin" | "savepoint" | "release" | "commit" | "rollbackTo" | "rollback";

/** The execution options of a transaction statement, in one shape. */
interface StatementOptions {
  readonly signal: AbortSignal | undefined;
  readonly timeoutMs: number | undefined;
  readonly context: Call | undefined;
}

/** The deadline a level's transaction statements must keep: its own, or its owner's, whichever is first. */
function statementDeadline(level: Level): number | undefined {
  const own = level.deadline;
  const owner = level.owner?.deadline;
  if (own === undefined) return owner;
  return owner === undefined || own <= owner ? own : owner;
}

/** What is left of a level's budget, in milliseconds (perhaps 0 or less); `undefined` when it has none. */
function budgetLeft(level: Level): number | undefined {
  const deadline = statementDeadline(level);
  return deadline === undefined ? undefined : deadline - now();
}

/**
 * The error of a transaction statement the budget stopped (`cause`), or could not start
 * (`undefined`): the transaction's timeout when the level's own budget ran out (the level
 * expires), the owning call's when its budget did.
 */
function budgetError(level: Level, sql: string | undefined, cause: DatabaseError | undefined): DatabaseError {
  const owner = level.owner;
  if (owner === undefined || statementDeadline(level) === level.deadline) {
    level.expire();
    return transactionTimeout(level, sql, cause);
  }
  const error =
    cause ??
    new DatabaseError(
      "database.timeoutSpent",
      "The statement was not run: the call's timeoutMs was spent before it could start.",
      {
        code: "timeout",
      },
    );
  return overBudget(error, owner.options) as DatabaseError;
}

/**
 * Whether a statement that was sent and rejected as stopped (`"timeout"` or `"aborted"`)
 * completed anyway: the cancel came too late, and the adapter then rejects with no `cause`
 * (the driver's error, when the cancel did stop it).
 */
function completedAnyway(error: unknown): boolean {
  return (isEgonError(error, "timeout") || isEgonError(error, "aborted")) && error.cause === undefined;
}

/**
 * Sends one transaction statement of `level` through the adapter's `Connection`, with
 * `timeoutMs` (what is left of the level's budget; `undefined` for a rollback, which the
 * budget must not cut short) and, when the repo has `query` listeners, a {@link Call} as
 * its context: it is then one of the repo's `query` events, operation `"transaction"`. A
 * level opened for a write of several statements adds that call's signal (not to a
 * rollback) and context.
 *
 * A statement the budget stopped rejects with the budget's error ({@link budgetError}). A
 * `COMMIT` or `RELEASE` that completed although it was stopped while it ran did commit: it
 * resolves.
 */
async function send(
  level: Level,
  statement: Statement,
  timeoutMs: number | undefined,
  begin: BeginOptions | undefined,
): Promise<void> {
  const session = level.session;
  const hub = session.hub;
  const given = level.owner?.options;
  const call = hub.listening ? new Call(hub, "transaction", undefined, own(given, "context")) : undefined;
  // A rollback is never stopped: it ends what the signal or the budget stopped.
  const signal = statement === "rollback" || statement === "rollbackTo" ? undefined : own(given, "signal");
  // One shape whatever is set (the adapter reads an `undefined` option as absent).
  const options =
    timeoutMs === undefined && call === undefined && signal === undefined
      ? undefined
      : ({
          signal,
          timeoutMs: timeoutMs === undefined ? undefined : Math.max(0, timeoutMs),
          context: call,
        } satisfies StatementOptions as ExecuteOptions);
  const connection = session.connection;
  // Whether the adapter will send it: it refuses, with no `cause`, a statement whose
  // budget is spent or whose signal has fired (checked in the same turn as this).
  const sent = (timeoutMs === undefined || timeoutMs > 0) && signal?.aborted !== true;
  try {
    switch (statement) {
      case "begin":
        return await connection.begin(begin, options);
      case "savepoint":
        return await connection.savepoint(savepointName(level), options);
      case "release":
        return await connection.releaseSavepoint(savepointName(level), options);
      case "commit":
        return await connection.commit(options);
      case "rollbackTo":
        return await connection.rollbackTo(savepointName(level), options);
      default:
        return await connection.rollback(options);
    }
  } catch (error) {
    // A SAVEPOINT that failed in the database aborts the transaction on Postgres (decision 2).
    if (sent && statement === "savepoint") session.fail(error);
    if (sent && (statement === "commit" || statement === "release") && completedAnyway(error)) return;
    if (timeoutMs === undefined || !isEgonError(error, "timeout")) throw error;
    throw budgetError(level, (error as DatabaseError).sql, error as DatabaseError);
  } finally {
    if (call !== undefined) hub.emit(call, 0, undefined);
  }
}

/**
 * The statement that ends a level that commits, with what is left of its budget; `false`
 * when nothing is left: the level then rolls back instead.
 */
function commitOf(level: Level): Promise<void> | false {
  const left = budgetLeft(level);
  if (left !== undefined && left <= 0) return false;
  return send(level, level.kind === "savepoint" ? "release" : "commit", left, undefined);
}

/** The statement that ends a level that rolls back. It has no budget: it must run to its end. */
function rollbackOf(level: Level): Promise<void> {
  return send(level, level.kind === "savepoint" ? "rollbackTo" : "rollback", undefined, undefined);
}

function savepointName(level: Level): string {
  return `egon_${level.depth}`;
}

/**
 * Ends a level after its callback: commits (or releases its savepoint) when the callback
 * returned and nothing failed, rolls back otherwise. Returns the result, or throws what
 * the callback threw.
 */
async function finish(level: Level, ended: Outcome): Promise<Ended> {
  const session = level.session;
  if (level.state === "ended") {
    // An enclosing level ended first (its callback returned, threw or timed out) and took
    // this one with it: the connection is no longer this level's to use.
    session.transactions--;
    if (ended.kind === "throw") throw ended.error;
    throw completedError(level);
  }
  level.state = "closing";
  // A budget that ran out decides the outcome, whatever the callback made of it (it may
  // have caught the cancelled statement's error).
  if (ended.kind === "timeout") level.expire();
  let outcome = level.timedOut ? TIMED_OUT : ended;
  if (level.child !== undefined) {
    if (outcome.kind === "value") {
      outcome = {
        kind: "throw",
        error: new QueryError(
          "query.nestedTransactionLeftRunning",
          "A nested transaction was still running when its enclosing transaction's callback returned, so the enclosing one was rolled back.",
        ),
      };
    }
    level.child.abandon();
  }
  level.refuseTurns();
  if (outcome.kind === "value" && session.streams > 0) {
    outcome = {
      kind: "throw",
      error: new QueryError(
        "query.transactionStreamLeftOpen",
        "A stream on tx was still open when the transaction's callback returned, so the transaction was rolled back.",
      ),
    };
  }
  if (outcome.kind !== "value") level.discard = true;

  // Decided when the connection is free, so that what the callback issued and did not
  // await has run (and, failing, has been recorded) first.
  // (Typed with `as`: both are assigned in the callback, which narrowing does not follow.)
  let action = "rollback" as "commit" | "rollback";
  let failed = NONE as Maybe<unknown>;
  let endError: Maybe<unknown> = NONE;
  try {
    await session.control(() => {
      if (outcome.kind === "value") {
        if (session.failure === NONE && session.broken === NONE) {
          const committing = commitOf(level);
          if (committing !== false) {
            action = "commit";
            return committing;
          }
          // The budget ran out before the COMMIT could be sent: roll back instead.
          outcome = { kind: "throw", error: budgetError(level, undefined, undefined) };
        } else {
          failed = session.failure !== NONE ? session.failure : session.broken;
        }
      }
      level.discard = true;
      return rollbackOf(level);
    });
    if (level.kind !== "savepoint") {
      // The transaction is over: the connection starts afresh (a checkout keeps using it).
      // What failed in it is kept for the decision to retry.
      session.endedWith = session.failure;
      session.failure = NONE;
      session.broken = NONE;
    } else if (action === "rollback") {
      session.failure = NONE;
    }
  } catch (error) {
    endError = error;
    // A COMMIT that failed may leave the transaction open (SQLite after a busy error, a
    // COMMIT refused before it was sent because a write's signal fired): roll it back, so
    // that nothing stays open on a connection that a checkout goes on using.
    if (action === "commit" && level.kind === "transaction") await rollbackAfterCommit(level, error);
  }
  session.transactions--;
  level.state = "ended";

  if (endError !== NONE) {
    if (level.kind === "savepoint") {
      // The savepoint could not be released or rolled back to: the enclosing transaction
      // can only be rolled back as a whole now.
      if (session.broken === NONE) session.broken = endError;
    } else if (action === "rollback") {
      // ROLLBACK itself failed: the connection's state is unknown; close it.
      session.destroy = true;
    }
    if (outcome.kind === "throw") {
      attachSuppressed(outcome.error, endError);
      throw outcome.error;
    }
    throw endError;
  }
  switch (outcome.kind) {
    case "value":
      return action === "commit"
        ? { result: success(outcome.value), why: undefined }
        : { result: failure(failed), why: "statement" };
    case "rollback":
      return { result: failure(outcome.reason), why: "rollback" };
    case "throw":
      throw outcome.error;
    default:
      throw transactionTimeout(level, undefined, undefined);
  }
}

/**
 * The callback of a transaction or savepoint on the repo's side: the repo bound to the
 * level, run under the store that tells a call from inside the callback, for the root-use
 * warning and (`store`, always in the sandbox) for the sandbox's own checks.
 */
function withRepo(
  root: RootScope,
  call: (repo: Repo) => unknown,
  store = root.watch,
): (level: Level) => unknown {
  if (!store) return (level) => call(repoFor(root, level));
  return (level) => watchStorage().run(level, call, repoFor(root, level));
}

/**
 * After a failed `COMMIT`: rolls back the transaction when the connection is still inside
 * it; when that fails too, the connection is closed instead of reused.
 */
async function rollbackAfterCommit(level: Level, error: unknown): Promise<void> {
  const session = level.session;
  try {
    if (!session.connection.inTransaction()) return;
    await session.control(() => rollbackOf(level));
  } catch (lost) {
    session.destroy = true;
    attachSuppressed(error, lost);
  }
}

/** Opens a transaction (`BEGIN`) on `session` and runs `call` on the level bound to it. */
async function runTransaction(
  session: Session,
  parent: Level | undefined,
  call: (level: Level) => unknown,
  begin: BeginOptions | undefined,
  deadline: number | undefined,
  timeoutMs: number | undefined,
  owner?: Owner,
): Promise<Ended> {
  const level = new Level(session, parent, "transaction", 0, deadline, timeoutMs, owner);
  if (parent !== undefined) parent.child = level;
  session.endedWith = NONE;
  try {
    session.transactions++;
    try {
      await session.control(() => send(level, "begin", budgetLeft(level), begin), level);
    } catch (error) {
      session.transactions--;
      level.state = "ended";
      throw error;
    }
    return await finish(
      level,
      await within(
        level,
        body(level, () => call(level)),
      ),
    );
  } finally {
    if (parent !== undefined && parent.child === level) {
      parent.child = undefined;
      parent.nextTurn();
    }
  }
}

/** Why a nested transaction cannot begin on `parent` now; `undefined` when it can (perhaps after waiting its turn). */
function nestedRefusal(parent: Level): unknown {
  if (parent.state !== "open") return completedError(parent);
  if (parent.rollbackReason !== NONE) return rolledBackError();
  return parent.sessionRefusal();
}

/** Opens a savepoint on `parent` and runs `call` on the level bound to it. */
async function runSavepoint(
  parent: Level,
  call: (level: Level) => unknown,
  timeoutMs: number | undefined,
  owner?: Owner,
): Promise<Ended> {
  const refused = nestedRefusal(parent);
  if (refused !== undefined) throw refused;
  // One nested transaction at a time on a level: the others wait for their turn.
  while (parent.child !== undefined) {
    await parent.turn();
    const again = nestedRefusal(parent);
    if (again !== undefined) throw again;
  }
  const session = parent.session;
  const own = timeoutMs === undefined ? undefined : now() + timeoutMs;
  const inherited = parent.deadline;
  const ownFirst = own !== undefined && (inherited === undefined || own < inherited);
  const level = new Level(
    session,
    parent,
    "savepoint",
    parent.depth + 1,
    ownFirst ? own : inherited,
    ownFirst ? timeoutMs : parent.timeoutMs,
    owner,
  );
  parent.child = level;
  try {
    session.transactions++;
    try {
      await session.control(() => {
        // A statement issued before it, queued, may have failed meanwhile: rolling back to a
        // savepoint begun after that failure would erase it from the record.
        const late = parent.sessionRefusal();
        if (late !== undefined) return Promise.reject(late);
        return send(level, "savepoint", budgetLeft(level), undefined);
      }, level);
    } catch (error) {
      // A SAVEPOINT the database refused was recorded by `send`; one that never ran (it
      // waited past the budget, or was refused before it was sent) harms nothing.
      session.transactions--;
      level.state = "ended";
      throw error;
    }
    return await finish(
      level,
      await within(
        level,
        body(level, () => call(level)),
      ),
    );
  } finally {
    parent.child = undefined;
    parent.nextTurn();
  }
}

/** A pause before the next attempt: growing with each one, randomised, never past the deadline. */
async function backoff(attempt: number, deadline: number | undefined): Promise<boolean> {
  const delay = Math.min(1_000, 10 * 2 ** attempt) * (0.5 + Math.random());
  if (deadline !== undefined && now() + delay >= deadline) return false;
  await new Promise((resolve) => setTimeout(resolve, delay));
  return true;
}

/**
 * Whether an attempt that threw may succeed when run again: the error is retryable, or the
 * transaction had recorded a retryable failure (a callback that caught a deadlock and then
 * ran another statement throws the `QueryError` of the refusal, whose cause it is).
 */
function retryableThrow(error: unknown, session: Session): boolean {
  return isRetryable(error) || isRetryable(session.endedWith);
}

/** Whether a finished attempt failed in a way another attempt may not. */
function retryableEnd(ended: Ended): boolean {
  return ended.why === "statement" && !ended.result.success && isRetryable(ended.result.error);
}

/** A top-level transaction on its own connection from the pool, with its retries. */
async function onPool(root: RootScope, call: (level: Level) => unknown, settings: Settings): Promise<Ended> {
  const timeoutMs = settings.timeoutMs;
  const deadline = timeoutMs === undefined ? undefined : now() + timeoutMs;
  const budget: ReadOptions | undefined = timeoutMs === undefined ? undefined : { timeoutMs };
  for (let attempt = 0; ; attempt++) {
    const connection = await acquireWithin(root.core, budget, deadline, "transaction");
    const session = new Session(connection, root, root.core.hub);
    let ended: Ended;
    try {
      ended = await runTransaction(session, undefined, call, settings.begin, deadline, timeoutMs);
    } catch (error) {
      await giveBack(session);
      if (attempt < settings.retries && retryableThrow(error, session) && (await backoff(attempt, deadline)))
        continue;
      throw error;
    }
    await giveBack(session);
    if (attempt < settings.retries && retryableEnd(ended) && (await backoff(attempt, deadline))) continue;
    return ended;
  }
}

/** A top-level transaction on a checkout's connection, with its retries. */
async function onCheckout(
  parent: Level,
  call: (level: Level) => unknown,
  settings: Settings,
): Promise<Ended> {
  const timeoutMs = settings.timeoutMs;
  const deadline = timeoutMs === undefined ? undefined : now() + timeoutMs;
  for (let attempt = 0; ; attempt++) {
    const refused = parent.refusal();
    if (refused !== undefined) throw refused;
    let ended: Ended;
    try {
      ended = await runTransaction(parent.session, parent, call, settings.begin, deadline, timeoutMs);
    } catch (error) {
      if (
        attempt < settings.retries &&
        retryableThrow(error, parent.session) &&
        (await backoff(attempt, deadline))
      )
        continue;
      throw error;
    }
    if (attempt < settings.retries && retryableEnd(ended) && (await backoff(attempt, deadline))) continue;
    return ended;
  }
}

/** Returns a session's connection to the pool, or closes it when its state cannot be trusted. */
function giveBack(session: Session): Promise<void> {
  return session.destroy ? session.connection.destroy() : session.connection.release();
}

// ---------------------------------------------------------------------------
// What the repo calls
// ---------------------------------------------------------------------------

/** Whether the repo bound to `scope` is inside a transaction (`tx.inTransaction`). */
export function inTransaction(scope: Scope): boolean {
  return scope instanceof Level ? scope.inTransaction : false;
}

/** The callback that runs a batch's steps on the transaction's repo. */
function batchCall(batch: AnyBatch): (repo: Repo) => unknown {
  return (repo) => runSteps(batch, repo);
}

/**
 * `repo.transaction(fnOrBatch, options)` and `repo.transactionOrThrow(…)`.
 *
 * @throws TypeError for a wrong argument or option; QueryError for an option a nested
 * transaction cannot take; whatever the callback throws; `RollbackError` (orThrow) when
 * the transaction was rolled back.
 */
export async function transaction(
  scope: Scope,
  input: unknown,
  options: unknown,
  orThrow: boolean,
): Promise<unknown> {
  const method = orThrow ? "transactionOrThrow" : "transaction";
  let call: (repo: Repo) => unknown;
  let batch: AnyBatch | undefined;
  if (isBatch(input)) {
    batch = input;
    call = batchCall(input);
  } else if (typeof input === "function") {
    call = input as (repo: Repo) => unknown;
  } else {
    throw new TypeError(
      `repo.${method}() takes a callback, repo.${method}(async (tx) => …), or a batch made with createBatch().`,
    );
  }
  const settings = settingsOf(method, options);
  if (batch !== undefined) {
    const invalid = firstInvalid(batch);
    if (invalid !== undefined) return settle({ result: failure(invalid), why: "rollback" }, orThrow, batch);
  }
  let ended: Ended;
  if (scope instanceof Level) {
    ended = await onLevel(scope, call, settings, method);
  } else if (scope.sandbox !== undefined) {
    // Inside the sandbox, the repo's transactions are savepoints of the sandbox's own; the
    // options that only a real transaction can take are left out.
    ended = await inSandbox(scope, scope.sandbox, call, settings);
  } else {
    warnIfInside(scope);
    ended = await onPool(scope, withRepo(scope, call), settings);
  }
  return settle(ended, orThrow, batch);
}

async function onLevel(
  level: Level,
  call: (repo: Repo) => unknown,
  settings: Settings,
  method: string,
): Promise<Ended> {
  const root = level.session.root as RootScope;
  if (level.kind === "checkout") return onCheckout(level, withRepo(root, call), settings);
  if (level.kind === "sandbox") return inSandbox(root, level, call, settings);
  if (settings.begin !== undefined || settings.retries > 0) {
    throw new QueryError(
      "query.savepointOptions",
      `tx.${method}() inside a transaction runs in a savepoint, which cannot take isolation, readOnly or retries.`,
    );
  }
  return runSavepoint(level, withRepo(root, call), settings.timeoutMs);
}

/**
 * A transaction of the repo while a sandbox has it: a savepoint of the sandbox's
 * transaction, its callback run under the store so that a call on the repo from inside it
 * is recognised (refused: see `insideCallback`), including another transaction, which
 * would otherwise wait for its turn behind the one it is called from.
 */
function inSandbox(
  root: RootScope,
  sandbox: Level,
  call: (repo: Repo) => unknown,
  settings: Settings,
): Promise<Ended> {
  const inside = insideCallback(sandbox);
  if (inside !== undefined) return Promise.reject(inside);
  return runSavepoint(sandbox, withRepo(root, call, true), settings.timeoutMs);
}

/** The result as `transaction` returns it, or (orThrow) its data, or a `RollbackError`. */
function settle(ended: Ended, orThrow: boolean, batch: AnyBatch | undefined): unknown {
  const result = ended.result;
  if (!orThrow) return result;
  if (result.success) return result.data;
  const reason = result.error;
  if (ended.why === "statement") {
    throw new RollbackError({
      reason,
      id: "rollback.statementFailed",
      message:
        "The transaction was rolled back because a statement in it failed and the callback returned anyway (the statement's error is error.reason).",
      cause: reason,
    });
  }
  if (batch !== undefined && isBatchFailure(reason)) {
    throw new RollbackError({
      reason,
      id: "rollback.batchFailed",
      message: `The batch failed at its step "${reason.step}" and was rolled back; error.reason holds { step, error, completed }.`,
    });
  }
  throw new RollbackError({ reason });
}

function isBatchFailure(value: unknown): value is { readonly step: string } {
  return (
    typeof value === "object" && value !== null && typeof (value as { step?: unknown }).step === "string"
  );
}

/**
 * `tx.rollback(reason)`: ends the transaction's callback; the transaction rolls back and
 * returns `failure(reason)`.
 *
 * @throws QueryError outside a transaction, and after the transaction ended.
 */
export function rollback(scope: Scope, reason: unknown): never {
  if (!(scope instanceof Level) || scope.kind === "checkout") {
    throw new QueryError("query.rollbackOutside", "rollback() is only available inside a transaction.");
  }
  if (scope.kind === "sandbox") {
    throw new QueryError(
      "query.rollbackSandbox",
      "The sandbox's transaction is rolled back by sandbox.rollback(), not by rollback() on the repo sandbox.begin() returned.",
    );
  }
  if (scope.state !== "open") throw completedError(scope);
  if (scope.rollbackReason === NONE) scope.rollbackReason = reason;
  throw new RollbackSignal(scope, reason);
}

/**
 * `repo.checkout(fn)`: one connection, no transaction, for as long as `fn` runs.
 *
 * @throws TypeError when `fn` is not a function; whatever `fn` throws.
 */
export async function checkout(scope: Scope, repo: Repo, fn: unknown): Promise<unknown> {
  if (typeof fn !== "function") {
    throw new TypeError("repo.checkout() takes a callback: repo.checkout(async (r) => …).");
  }
  const call = fn as (repo: Repo) => unknown;
  // Already on one connection: the callback gets the same repo.
  if (scope instanceof Level) {
    const refused = scope.refusal();
    if (refused !== undefined) throw refused;
    return call(repo);
  }
  if (scope.sandbox !== undefined) return call(repo);
  warnIfInside(scope);
  const connection = await scope.core.adapter.acquire();
  const session = new Session(connection, scope, scope.core.hub);
  const level = new Level(session, undefined, "checkout", 0, undefined, undefined);
  try {
    return await call(repoFor(scope, level));
  } finally {
    level.state = "closing";
    level.child?.abandon();
    level.refuseTurns();
    // Statements it issued and did not await still run before the connection goes back.
    await session.control(async () => undefined);
    level.state = "ended";
    await giveBack(session);
  }
}

// ---------------------------------------------------------------------------
// The multi-statement primitive (bulk writes, nested writes)
// ---------------------------------------------------------------------------

/**
 * Runs `work` atomically on one executor: inside a transaction of its own when the repo
 * runs on the pool, in a savepoint when the repo is a transaction's (so a failure undoes
 * only this work and leaves the caller's transaction usable), and as it is when the repo
 * runs on one connection that the caller manages.
 */
export async function atomically<T>(
  core: ReadCore,
  options: ReadOptions | undefined,
  deadline: number | undefined,
  work: (executor: Executor) => Promise<T>,
): Promise<T> {
  const executor = core.executor;
  // The call's signal, context and budget reach the transaction statements too.
  const owner: Owner | undefined = options === undefined ? undefined : { options, deadline };
  if (executor instanceof Level) {
    const refused = executor.kind === "sandbox" ? insideCallback(executor) : executor.refusal();
    if (refused !== undefined) throw refused;
    const ended =
      executor.kind === "checkout"
        ? await runTransaction(executor.session, executor, work, undefined, undefined, undefined, owner)
        : await runSavepoint(executor, work, undefined, owner);
    return valueOfEnded(ended) as T;
  }
  if (!core.pooled) return work(executor);
  if (executor instanceof RootWatch) executor.check();
  const connection = await acquireWithin(core, options, deadline);
  const session = new Session(connection, undefined, core.hub);
  let ended: Ended;
  try {
    ended = await runTransaction(session, undefined, work, undefined, undefined, undefined, owner);
  } finally {
    await giveBack(session);
  }
  return valueOfEnded(ended) as T;
}

/** The value of a level the primitive ran, which ends in a failure only when a statement failed. */
function valueOfEnded(ended: Ended): unknown {
  if (ended.result.success) return ended.result.data;
  throw ended.result.error;
}

// ---------------------------------------------------------------------------
// The sandbox's transaction
// ---------------------------------------------------------------------------

/** A sandbox that has begun: what `endSandbox` needs to undo it. */
export interface OpenSandbox {
  readonly level: Level;
  readonly repo: Repo;
  readonly executor: Executor;
  readonly pooled: boolean;
}

/**
 * Checks out a connection, begins a transaction on it and routes every operation of the
 * root repo through it; the repo's own transactions become savepoints of it.
 */
export async function beginSandbox(root: RootScope): Promise<OpenSandbox> {
  const core = root.core;
  const connection = await core.adapter.acquire();
  const session = new Session(connection, root, core.hub);
  const level = new Level(session, undefined, "sandbox", 0, undefined, undefined);
  session.transactions = 1;
  try {
    await session.control(() => connection.begin(undefined));
  } catch (error) {
    await connection.release();
    throw error;
  }
  const open: OpenSandbox = {
    level,
    repo: repoFor(root, level),
    executor: core.executor,
    pooled: core.pooled,
  };
  core.executor = level;
  core.pooled = false;
  root.sandbox = level;
  return open;
}

/** Rolls the sandbox's transaction back, returns its connection and gives the repo back its pool. */
export async function endSandbox(root: RootScope, open: OpenSandbox): Promise<void> {
  const core = root.core;
  core.executor = open.executor;
  core.pooled = open.pooled;
  root.sandbox = undefined;
  const level = open.level;
  const session = level.session;
  level.state = "closing";
  level.discard = true;
  level.child?.abandon();
  level.refuseTurns();
  try {
    await session.control(() => session.connection.rollback());
  } catch (error) {
    level.state = "ended";
    await session.connection.destroy();
    throw error;
  }
  level.state = "ended";
  await session.connection.release();
}
