// Helpers for the step 18 unit tests. Imported by tests only.
//
// A fake Postgres for the runner: an adapter made with createAdapter over a driver that
// answers the runner's own statements (lock, tracking table, transactions) from memory
// and records every other statement. It is deliberately small: what the statements do to
// a real database is checked by the migration conformance suite against Postgres.
import { createAdapter, type DatabaseAdapter } from "../adapter/adapter.js";
import type { DriverConnection, DriverCursor, DriverWrapper } from "../adapter/driver.js";
import { createCompiler } from "../compiler/compiler.js";
import { POSTGRES_CAPABILITIES, postgresDialect } from "../compiler/dialect.js";
import type { Capabilities, PoolEvent, RawResult } from "../contracts/adapter.js";
import { own } from "../internal/own.js";
import { MigrationBuilder } from "./builder.js";
import { type DdlContext, emitOperation } from "./ddl.js";
import { POSTGRES_MIGRATION_DIALECT } from "./dialect.js";

/** The DDL context of Postgres, with the compiler's fragment compilation. */
export function postgresDdl(): DdlContext {
  const compiler = createCompiler(postgresDialect);
  return {
    syntax: postgresDialect,
    dialect: POSTGRES_MIGRATION_DIALECT,
    compileFragment: (node) => compiler.compileFragment(node),
  };
}

/** Records operations with `record` and returns the Postgres SQL of each, one string per statement. */
export function sqlOf(record: (m: MigrationBuilder) => void, ctx: DdlContext = postgresDdl()): string[] {
  const m = new MigrationBuilder(63);
  record(m);
  return m.operations.flatMap((op) => emitOperation(op, ctx).map((statement) => statement.sql));
}

/** One statement the fake database saw. */
export interface SeenStatement {
  readonly connection: number;
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** Options of {@link fakeDatabase}. */
export interface FakeDatabaseOptions {
  /** Makes a statement fail: return an error to throw. */
  readonly fail?: (sql: string) => Error | undefined;
  /** The tracking table exists before the first run, with these versions. */
  readonly applied?: readonly number[];
  /** The tracking table's columns (default: version and created_at). */
  readonly columns?: readonly string[];
  readonly capabilities?: Capabilities;
  /** Makes `rollback` fail. */
  readonly failRollback?: boolean;
  /** Makes the lock release fail. */
  readonly failUnlock?: boolean;
  /** Makes a statement run until it is cancelled. */
  readonly hang?: (sql: string) => boolean;
}

/** The state of the fake database, for assertions. */
export interface FakeDatabase {
  readonly adapter: DatabaseAdapter;
  /** Another adapter over the same database (an adapter cannot be used after close()). */
  readonly newAdapter: () => DatabaseAdapter;
  readonly statements: SeenStatement[];
  /** The DDL and execute statements, in order (not the runner's bookkeeping). */
  readonly work: () => string[];
  /** The applied versions, sorted. */
  readonly versions: () => number[];
  /** Whether the tracking table exists. */
  readonly tracking: () => boolean;
  /** Connections released (returned to the pool) and destroyed. */
  readonly released: number[];
  readonly destroyed: number[];
  /** Whether the lock is held now. */
  readonly locked: () => boolean;
}

const BOOKKEEPING =
  /^(begin|commit|rollback|select pg_advisory|select 1 from information_schema|create table "schema_migrations"|create table "[^"]*"\."schema_migrations"|select "version"|insert into .*"version"|delete from .*"version")/;

/** A fake Postgres for the runner. */
export function fakeDatabase(options: FakeDatabaseOptions = {}): FakeDatabase {
  const statements: SeenStatement[] = [];
  const released: number[] = [];
  const destroyed: number[] = [];
  let exists = own(options, "applied") !== undefined;
  let columns = new Set(own(options, "columns") ?? ["version", "created_at"]);
  let committed = new Set(own(options, "applied") ?? []);
  let lockHolder: number | undefined;
  const waiting: (() => void)[] = [];
  let next = 0;

  const rows = (list: readonly Record<string, unknown>[]): RawResult => ({
    rows: list,
    rowCount: list.length,
    insertId: undefined,
  });

  const driver: DriverWrapper = {
    init(): void {},
    async acquire(): Promise<DriverConnection> {
      const id = ++next;
      let transaction: Set<number> | undefined;
      let cancelled = false;
      const current = (): Set<number> => transaction ?? committed;
      return {
        async query(sql, params): Promise<RawResult> {
          statements.push({ connection: id, sql, params });
          const failure = own(options, "fail")?.(sql);
          if (failure !== undefined) throw failure;
          if (own(options, "hang")?.(sql) === true) {
            // Runs until it is cancelled, as a statement past its timeout does.
            await new Promise<void>((resolve) => waiting.push(resolve));
            throw new Error("canceling statement due to statement timeout");
          }
          if (sql === "begin") {
            transaction = new Set(committed);
            return rows([]);
          }
          if (sql === "commit") {
            committed = transaction ?? committed;
            transaction = undefined;
            return rows([]);
          }
          if (sql === "rollback") {
            if (own(options, "failRollback") === true) throw new Error("rollback failed");
            transaction = undefined;
            return rows([]);
          }
          if (sql.startsWith("select pg_advisory_lock")) {
            while (lockHolder !== undefined && lockHolder !== id) {
              await new Promise<void>((resolve) => waiting.push(resolve));
              if (cancelled) {
                cancelled = false;
                throw new Error("canceling statement due to user request");
              }
            }
            lockHolder = id;
            return rows([{}]);
          }
          if (sql.startsWith("select pg_advisory_unlock")) {
            if (own(options, "failUnlock") === true) throw new Error("unlock failed");
            if (lockHolder === id) lockHolder = undefined;
            for (const wake of waiting.splice(0)) wake();
            return rows([{}]);
          }
          if (sql.startsWith("select 1 from information_schema.tables")) return rows(exists ? [{}] : []);
          if (sql.startsWith("select 1 from information_schema.columns")) {
            return rows(columns.has(params[2] as string) ? [{}] : []);
          }
          if (/^create table ("[^"]*"\.)?"schema_migrations"/.test(sql)) {
            exists = true;
            columns = new Set(["version", /"([^"]+)" timestamp\(0\)/.exec(sql)?.[1] ?? ""]);
            return rows([]);
          }
          if (sql.startsWith('select "version"')) {
            return rows(
              [...current()].sort((a, b) => a - b).map((version) => ({ version: String(version) })),
            );
          }
          if (/^insert into .*"version"/.test(sql)) {
            current().add(Number(params[0]));
            return rows([]);
          }
          if (/^delete from .*"version"/.test(sql)) {
            current().delete(Number(params[0]));
            return rows([]);
          }
          return rows([]);
        },
        async cursor(): Promise<DriverCursor> {
          throw new Error("no cursors here");
        },
        async cancel(): Promise<void> {
          cancelled = true;
          for (const wake of waiting.splice(0)) wake();
        },
        inTransaction: () => transaction !== undefined,
        // Read by release() below, to tell the connections apart.
        id,
      } as DriverConnection & { id: number };
    },
    async release(connection, destroy): Promise<void> {
      const id = (connection as DriverConnection & { id: number }).id;
      if (destroy) {
        destroyed.push(id);
        if (lockHolder === id) {
          lockHolder = undefined;
          for (const wake of waiting.splice(0)) wake();
        }
      } else {
        released.push(id);
      }
    },
    async destroy(): Promise<void> {},
    stats(): PoolEvent {
      return { size: 1, idle: 1, waiting: 0 };
    },
    saturated: () => false,
  };

  const newAdapter = (): DatabaseAdapter =>
    createAdapter({
      dialect: "postgres",
      capabilities: own(options, "capabilities") ?? POSTGRES_CAPABILITIES,
      quoteIdentifier: (name) => `"${name.replaceAll('"', '""')}"`,
      driver: () => driver,
      driverCodecs: {},
      normalizeError: (error) => error,
    });
  const adapter = newAdapter();

  return {
    adapter,
    newAdapter,
    statements,
    work: () => statements.filter((s) => !BOOKKEEPING.test(s.sql)).map((s) => s.sql),
    versions: () => [...committed].sort((a, b) => a - b),
    tracking: () => exists,
    released,
    destroyed,
    locked: () => lockHolder !== undefined,
  };
}
