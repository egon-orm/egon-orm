# Step 21 (hardening): duplicate field names, inherited option keys, seeded mutation runs, status

Branch `step/21-hardening`, 2026-10-24, from `main` at `5b48199` (#74, changeset gaps).
Owner decisions of 2026-10-24 (all three in one PR). Input: the Requests of
`status/21-changeset-gaps.md`.

## Summary

| Item | Result |
|---|---|
| 1. Duplicate field names | **Done.** A name listed twice in `cast`'s permitted list, `validateRequired`, `uniqueConstraint`, `validateUniqueAsync`, or a repo write's `returning` / `onConflict` lists counts once. Tests fail without the fix. |
| 2. Inherited option keys | **Done** for every read Egon itself makes, in all six packages. One rule: options are read with `own(options, key)` (an `Object.hasOwn` read), and option defaults are frozen objects without a prototype. 42 tests (31 in core, 11 in the other packages) plant a key on `Object.prototype`; each was checked to fail without its fix. **One open question for the owner** (below): what the database drivers read from the configuration objects Egon builds for them. |
| 3. Seeded property tests in mutation runs | **Done.** `packages/core/test/support/mutation-seed.ts`, used only by `vitest.mutation.config.ts`. Normal runs stay unseeded (checked). Two Stryker runs of one file: see §3. |

## 1. Duplicate field names

The rule (owner decision, option b): a name listed twice is processed once, so it gives one
error at most. This is what a cast over an earlier changeset already did.

- **`cast`** (`changeset.ts`): errors are now always appended without repeats, as they were
  for a cast over an earlier changeset. A first cast starts with no errors, so the only
  repeats it can have come from a name permitted twice. Casting the repeated name again
  records the same change, so the changes were already right. Cost: one `list.some` on the
  error path only; nothing on the path without errors.
- **`validateRequired`**: a missing name is added to the missing list once (`includes` on
  the failure path only).
- **`uniqueConstraint`**: the default name uses each column once
  (`["email", "email"]` → `users_email_key`).
- **`validateUniqueAsync`**: the repo receives each field once.
- **Repo writes** (`repo/write.ts` `fieldList`): `returning`, `onConflict.target`,
  `onConflict.update` and `except`, and `insertAll`'s `returning`. Before, `update:
  ["name", "name"]` emitted `set "name" = excluded."name", "name" = excluded."name"`.
- The helper is `distinct()` (`packages/core/src/internal/distinct.ts`): it returns the
  list itself when there is no repeat (no allocation, `n²/2` comparisons of short lists),
  and a copy without repeats otherwise.

Checked and left as they are:

- `validate({ only })` filters with `includes`, so a repeat has no effect.
- Every other `validate*` takes one field. `validateChange` takes one field; the
  constraint helpers other than `uniqueConstraint` take one field or association.
- The compiler's `compileInsert` / `compileUpdate` / `compileDelete` field lists (reached
  only through `createAdapter`, which is documented as internal; the repo passes them
  lists without repeats now), and duplicates in `preload` / `reload` (duplicate work, no
  wrong result).

Docs: TSDoc of `cast`, `validateRequired` and `uniqueConstraint`; a bullet in
`docs/site/guide/changesets.md` ("What `cast` does"); `CHANGELOG.md`.

Tests: `changeset/cast.test.ts` ("a name permitted twice is cast once: one error, one
change"), `changeset/validations.test.ts` ("a name listed twice is checked once"),
`changeset/constraints.test.ts` (unique constraint name, `validateUniqueAsync`), and
`test/security/hostile-params.test.ts` (onConflict update, insertAll returning). Each was
run against the original source and failed.

## 2. Inherited option keys

### The approach

- **Core:** `own(options, key)` in `packages/core/src/internal/own.ts`:
  `Object.hasOwn(options, key) ? options[key] : undefined`, and `undefined` for an absent
  options object. `frozenOptions(values)` makes a frozen default without a prototype. Every
  destructuring of an options object became `own()` reads; every `options ?? {}`,
  `options = {}` and `Object.freeze({})` used as an options default became `own()` reads or
  a `frozenOptions({})`. `"key" in options` became `Object.hasOwn`.
- **Fixed at the read, not the object.** Objects the library builds and passes on with
  some keys left out (the per-statement `CallOptions` without `statementName`, the
  `explain` options, `begin` options, nested write options) are read with `own()` where they
  are read, so a missing key is missing whatever `Object.prototype` holds.
- **Other packages** cannot import core internals and must not grow public API, so each of
  postgres, sqlite, mysql, zod and cli has the same helper in `src/own.ts` (not exported).
- **Unknown-key checks** stay as they were (`Object.keys`, own keys only).
- **No public type changed.** `pnpm api:check` passes. One parameter rename the CLI fork made
  (`run(argv, io)`) was reverted so the API report is unchanged.
- **Hot path:** the per-query reads (`signal`, `timeoutMs`, `statementName`, `schema`,
  `context`, cast's `emptyValues` and `forceChanges`, validators' `message`) are now one
  `Object.hasOwn` each. Each is read once into a local. No allocation was added. Not
  measured (benchmarks are step 19's).

### Confirmed cases (from the changeset-gaps note), all fixed and tested

`message` (`validateRequired({})`), `emptyValues`, `forceChanges`, `castAssoc` /
`castEmbed` with no options (`EMPTY` in `nested/change.ts`, now a `frozenOptions({})`
default plus `own()` reads), `trim`, `required` (`castAssoc` and `validateConfirmation`),
`with`, `errorKey`, `name`, `match`, `codegen`, `validate()`'s `scope` / `apply` / `only`,
`validateLength` / `validateNumber`'s `message`.

### Found beyond the list

The audit found more than the list, including several that act **without** any options
object, because the library's own default was `{}` or a partial object:

- **Every failed built-in cast** returned `INVALID`, a frozen `{ success: false }`
  without `message` or `meta`: with `message` planted, every cast error said the planted
  text. Fixed where results are read (`changeset.ts`, `validators/validate.ts`,
  `types/composite.ts`).
- `rebuild(changeset, parts)` read `parts.changes` / `errors` / `valid`; callers leave
  keys out. A planted `changes` replaced a changeset's changes.
- `repo.insertAll(User, rows)` with no options read `onConflict` from `{}`: a planted
  `onConflict: "nothing"` gave `ON CONFLICT DO NOTHING`.
- Every statement read `statementName` from a library-built object without it: a planted
  name prepared every statement, and made `BEGIN` / `COMMIT` throw.
- `repo.explain(q)` read `analyze` from a partial object: a planted `analyze: true` ran
  the query (`EXPLAIN ANALYZE`).
- `new DatabaseError(..., { code })` read `retryable`: a planted `true` made every
  database error retryable, which drives transaction retries.
- `createCompiler()`'s `options = {}` default read `keyOf`: a planted function replaced
  the plan-cache key.
- Migration builder `checkOptions` returned a fresh `{}`: every builder option
  (`ifNotExists`, `cascade`, `precision`, …) was read from `Object.prototype` when a call
  had no options. Also `defaultPrecision[type.kind]` on a `{}` table (Postgres and SQLite).
- `defineMigration`'s `transaction` (a planted `false` turned transactions off).
- The zod package's `type.zod` hint: a planted `zod` replaced every field's schema.
- The CLI's `migrations ?? {}` default (`directory` decides where `migrate create`
  writes).

### The audit, by file

Every non-test source file of the six packages was read (four read-only audits in
parallel, then the fixes). "own" means the keys are now read with `own()` / `Object.hasOwn`.

**`packages/core/src/changeset`**

| File | Options type | Keys (now own) |
|---|---|---|
| `changeset.ts` | `CastOptions` | emptyValues, forceChanges |
| | `RequiredOptions` | message, trim |
| | `MessageOptions` (format, inclusion, exclusion, subset, acceptance) | message |
| | `LengthOptions` | is, min, max, count, message (was destructured) |
| | `NumberOptions` | message (limits already for…in + hasOwn) |
| | `ConfirmationOptions` | message, required |
| | `ConstraintOptions` (unique, foreignKey, assoc, noAssoc, exclusion), `CheckConstraintOptions` | name, match, message, errorKey |
| | `rebuild` parts (internal) | changes, errors, valid |
| | cast results (`INVALID`) | message, meta |
| | `isChanged({ from, to })` | already hasOwn |
| `nested/change.ts` | `castAssoc` / `castEmbed` options | with, required; default `EMPTY` → `NO_OPTIONS = frozenOptions({})` |
| `validators/validate.ts` | `ValidateOptions` | scope, apply, only (was destructured); cast results: message, meta |
| `spec.ts` | `{ data, types }` target | data (types was already hasOwn) |

**`packages/core/src/schema`, `types`, `query`**

| File | Options type | Keys (now own) |
|---|---|---|
| `schema/schema.ts` | `SchemaOptions`, `EmbeddedSchemaOptions` | schema, primaryKey, naming, codegen |
| `schema/assoc.ts` | association options (BelongsTo, HasOne, HasMany, ManyToMany, Through) | onReplace, where, joinWhere, orderBy, foreignKey, references, joinKeys (and its owner, target), joinThrough, unique, through (also `isThrough`); default `?? {}` → `frozenOptions({})` |
| `schema/field.ts` | `virtual({ json })`, `EmbedOptions`, `t.bigint`, `t.date`, `TimestampsOptions` | json, onReplace, mode, as, createdAt, updatedAt, type (`options = {}` default removed) |
| `types/scalars.ts` | `BigintOptions`, `DecimalOptions` | mode, precision, scale (was destructured) |
| `types/temporal.ts` | `DateOptions`, `TimestampOptions` | as, precision |
| `types/define.ts` | `TypeDefinition` (`defineType`), `DbType` | name, db, cast, equal, fromDb, toDb (was destructured); kind, of, sql |
| `types/composite.ts` | element cast results | meta, message, meta.path |
| `query/builder.ts` | `LockOptions` | skipLocked, noWait (the `...rest` unknown-key check became `Object.keys`) |
| `query/advanced/with-cte.ts` | `CteOptions` | recursive, materialized |
| `query/advanced/windows.ts` | `WindowSpec` from `windows()` | partitionBy, orderBy, frame (was destructured) |
| `query/functions.ts` | `WindowSpec` of `over()` | partitionBy, orderBy, frame |
| `query/advanced/set-operations.ts` | the source node's `meta` (values and fragment sources have none) | meta |

Already safe in query/: select maps, `.set({})`, `where({})`, preload specs, `windows({})`
names, `dynamic()` bindings (all `Object.keys` or hasOwn). No `for…in` over a user object.

**`packages/core/src/repo`, `batch`, `adapter`, `compiler`, `errors.ts`**

| File | Options type | Keys (now own) |
|---|---|---|
| `repo/options.ts` | `RepoOptions` (`createRepo`) | adapter, log, log.params, schema, warnOnRootUseInTransaction, codegen |
| | per-call `ReadOptions` (`checkReadOptions`) | schema, context |
| `repo/read.ts` | `ReadOptions`, `StreamReadOptions`, `ExplainReadOptions` | signal, timeoutMs, schema, context, batchSize, format, analyze |
| `repo/preload.ts` | `ReadOptions`, `PreloadOptions` | timeoutMs, maxConcurrency, context, signal, schema, force |
| `repo/repo.ts` | `PreloadOptions` | force |
| `repo/write.ts` | `InsertOptions`, `UpdateOptions`, `DeleteOptions`, `InsertOrUpdateOptions` | onConflict, returning, force, staleError, allowStale |
| | `OnConflictOption` | target, update, `{ constraint }`, `{ except }` |
| | `StaleErrorOption` | field, message |
| | `ReadOptions` | timeoutMs, context, signal, schema |
| | `validateUniqueAsync` options | message, errorKey |
| `repo/bulk.ts` | `InsertAllOptions` | onConflict, placeholders, returning (the `checked ?? {}` default removed); `placeholders[name]` |
| `repo/nested.ts` | child write options | signal, context, timeoutMs, schema |
| `repo/transaction.ts` | `TransactionOptions` | isolation, readOnly, retries, timeoutMs (was destructured); statement options: signal, timeoutMs, context |
| `repo/constraints.ts` | lookup tables `MATCHING_TYPES`, `LABELS`, `VIOLATION_WORDS` | now `frozenOptions` (frozen, no prototype) |
| `adapter/adapter.ts` | `BeginOptions` | isolation, readOnly, deferrable (was destructured) |
| | `ExecuteOptions`, `StreamOptions` | signal, timeoutMs, statementName, batchSize, slots, context |
| | `AdapterDefinition` | planCacheSize |
| `adapter/telemetry.ts` | `QueryListenerOptions` | params |
| `adapter/codecs.ts` | `DriverCodecs` (the dialect packages' tables) | `fixes[kind]`, fromDb, toDb, array |
| `compiler/compiler.ts` | `CompilerOptions` (`= {}` default removed) | codecs, planCacheSize, keyOf |
| | `ExplainOptions`, `InsertPlanOptions`, `OnConflict` | analyze, format, onConflict, target, update, except; `"kind" in` / `"constraint" in` → hasOwn |
| `compiler/write.ts` | `InsertPlanOptions`, `OnConflict` | onConflict, target, update, constraint, except; `"kind" in` → hasOwn |
| `compiler/cache.ts` | `PlanCacheOptions` | keyOf |
| `errors.ts` | constructor details (incl. `= {}` defaults) | cause, params, query, constraint, table, column, detail, sql, message, id, code, retryable, version, migration |
| `batch/batch.ts` | stores options by reference; the repo reads them when the batch runs | nothing to change |

Left as plain reads: keys that are always present and required by the type
(`AdapterDefinition.dialect` etc., `InsertPlanOptions.source` / `returning`,
`PlanCacheOptions.capacity` / `keyLists`, error details' `count`, `action`, `changeset`,
`schema`, `type`, `association`, `reason`), where `own()` would only widen the type.

**`packages/core/src/migration`**

| File | Options type | Keys (now own) |
|---|---|---|
| `builder.ts` | `checkOptions` (every builder method; the fresh `{}` default → `frozenOptions({})`), `optionalBoolean`, `optionalName` | every builder option: ifNotExists, ifExists, cascade, schema, primaryKey, unique, name, where, include, using, concurrently, check, exclude, … |
| | `id`, `references`, `timestamps`, `precise`, `modify` options; column types `{ kind, of, sql, precision, scale }` | type, onDelete, onUpdate, precision, notNull, default; kind, of, sql, precision, scale |
| `ddl.ts` | `dialect.defaultPrecision` (`{}` on Postgres and SQLite, partial on MySQL) | `[type.kind]` |
| `migrator.ts` | `MigratorOptions`, `UpOptions`, `DownOptions` (`options ?? {}` → `frozenOptions({})`) | adapter, directory, migrations, log, table, schema, timestampColumn, lockTimeoutMs, timeoutMs; to, step, all, dryRun |
| `define.ts` | `MigrationDefinition` | up, down, transaction (was destructured); `"change" in` → hasOwn |
| `loader.ts` | migration sources `{ version, name, migration }` | version, name, migration (`entry ?? {}` removed); `"change" in` → hasOwn |
| `database.ts` | `dropDatabase` options | ifExists |
| `test-helpers.ts` | `FakeDatabaseOptions` (test-only, not built) | applied, columns, fail, hang, failRollback, failUnlock, capabilities |

**Other packages**

| File | Options type | Keys (now own) |
|---|---|---|
| `postgres/src/options.ts` | `PostgresOptions`, `PostgresPoolOptions` | pool, every connection key (also in the "cannot combine with pool" check), connectionString, host, port, user, password, database, ssl, statementTimeoutMs, applicationName; max, idleTimeoutMs, connectionTimeoutMs |
| `postgres/src/index.ts`, `sqlite/src/index.ts`, `mysql/src/index.ts` | adapter options | planCacheSize |
| `postgres/src/cancel.ts` | the connection's TLS options | `"key" in ssl` → hasOwn |
| `postgres/src/driver.ts` | built pool config, a caller's pool's `options` | connectionTimeoutMillis |
| `sqlite/src/options.ts` | `SqliteOptions` | filename, readonly, pragmas, attach |
| `mysql/src/options.ts` | `MysqlOptions`, `MysqlPoolOptions` (`options ?? {}` → frozen, no prototype; `FIXED` now frozen) | connectionString, host, port, user, password, database, ssl, pool, max, idleTimeoutMs, connectionTimeoutMs |
| `zod/src/to-zod.ts` | `ToZodOptions`, the `ZodHint` on a type | mode, pick, omit; zod |
| `cli/src/config.ts` | the config module and `EgonConfig` | default, config, adapter, database, database.name, database.admin, migrations; the loaded config is a copy without a prototype |
| `cli/src/cli.ts` | `CliIo` given to `run()`, the migrations settings (`?? {}` → frozen, no prototype), `io.env` | stdout, stderr, cwd, env, now; NODE_ENV |

### Left alone on purpose (not options)

- **Brand checks on values:** `[ASSOC]`, `[AS_SOURCE]`, `[AS_SUBQUERY]`, `[MIGRATION]`
  (`Symbol.for` keys), and the migration builder's fragment detection (`.node`,
  `.params`). A key planted under `Symbol.for("…")` on `Object.prototype` would reach
  them; they are type checks of values, not options.
- **Objects whose members may come from a class prototype:** hand-written field types
  (`cast`, `equal`, `fromDb`, `toDb`), adapters (`compile`, `execute`, …), a caller's
  `pg.Pool`, custom node emitters, the adapter's `typeOverrides`. An own-only read would
  break a class instance.
- **Results and data:** Standard Schema results and issues (a library may define them on a
  class), `validateChange`'s returned errors, embed rows from plain objects, date objects,
  `toJSON`. These are values, not options.
- **Module namespaces** from `import()` (no prototype) and Node's `parseArgs` values (no
  prototype).

### Tests

Each test plants a key with `plant()` (an enumerable property on `Object.prototype`,
removed after the test) and checks it has no effect. Each was run against the source
without its fix and failed (the changeset ones by reverting the four changeset files to
`main`; the others by reverting each site by hand and restoring it).

- `packages/core/test/security/hostile-params.test.ts`, "an option planted on
  Object.prototype is no option" (10 tests: the confirmed cases, the `INVALID` message and
  meta, `rebuild`, `{ types }` without data); "… no option of a query, a schema or a type"
  (11: lock, withCte, windows/over, Schema naming, onReplace, bigint mode, decimal scale,
  date as, timestamps, defineType equal, an array element's cast message); "… no migration
  option" (4: createTable ifNotExists, column precision and the default-precision table,
  defineMigration transaction, createMigrator table); "… no option of the repo" (6:
  insertAll onConflict, explain analyze, read schema, statementName, transaction retries,
  DatabaseError retryable); and the two duplicate-name write tests.
- `packages/{postgres,sqlite,mysql,zod,cli}/src/hostile-options.test.ts` (11 tests): each
  package's own options. They are in the packages because core's tests do not import the
  dialect packages.

Not covered by a test of its own: the three `planCacheSize` reads, `cancel.ts`'s `key`,
`cancelTimeoutMs`, the CLI's `ioOf` / `NO_MIGRATIONS` / `NODE_ENV`, and
`set-operations.ts`'s `meta`. Each is a one-line `own()` read of the same kind.

### Behaviour changes a caller could notice

- A `CliIo` passed to `run()` whose `stdout` etc. live on a class prototype no longer
  works; `CliIo` is documented as an object, and the guide and tests pass object literals.
- The CLI's loaded config is a copy without a prototype (`loadConfig` is not exported).
- Error reference pages (`docs/site/reference/errors/*.md`, generated): five message
  templates name their placeholders differently (`{timeoutMs}` for
  `{options?.timeoutMs}`, `{inQuery(query)}`, `{message}`, `{owner}`).

## 3. Seeded property tests in mutation runs

- `packages/core/test/support/mutation-seed.ts` calls
  `fc.configureGlobal({ ...fc.readConfigureGlobal(), seed: 20261024 })`.
- `vitest.mutation.config.ts` appends it to the `core:unit` project's setup files; nothing
  else uses it.
- Checked with a scratch test that printed `fc.readConfigureGlobal().seed`: `20261024`
  under `vitest.mutation.config.ts`, `undefined` under `core:unit`.
- Two Stryker runs of `packages/core/src/changeset/nested/relation.ts` (the file whose
  property-killed mutant varied between runs, `relation.ts:310`), with the repository's
  `stryker.config.json` (scratch script, reports under `reports/mutation/`, not committed):
  **identical**. Both runs: 380 mutants, 294 killed, 81 survived, 5 without coverage
  (77.37%), about 3 minutes 20 seconds each. Compared mutant by mutant (file, line, column,
  mutator, replacement): no status differs. 17 mutants share such a key with another, so
  363 keys were compared; the totals per status match as well. Not a full-area run.
  Before the seed, the robustness run saw `relation.ts:310` killed in one run and not the
  next; one pair of runs shows the seed works here, not that every file is now stable.

## Checks

On the final tree:

- `pnpm check` passes: unit 161 files, 6,621 tests (coverage thresholds met); type tests 35
  files, 608 tests; build.
- `pnpm api:check`: up to date for 9 entry points.
- `pnpm lint:packages`, `pnpm smoke`: pass.
- `EGON_TEST_TIER2=1 pnpm test:integration --maxWorkers=2`: 51 files, 1,801 passed, 2
  expected failures, 55 skipped.

## Checks I changed, exempted or worked around

None. The new module-level defaults carry `/* @__PURE__ */` as `check-pure-annotations`
requires.

## Gaps and unverified claims

- The audit is four agents' reading of every source file, then the fixes; it was not
  checked mechanically (there is no lint for an options read). A read missed by all of
  them would not be caught by a test.
- No performance measurement (step 19).

## Needs the owner's decision

- **What the database drivers read from the configuration Egon gives them.** Egon builds
  the configuration objects it hands to `pg.Pool`, `mysql2.createPool`, the
  `better-sqlite3` constructor and `tls.connect`, and those libraries read keys Egon does
  not set: pg reads an inherited `ssl` when none was given (and pg-pool `Client`,
  `Promise`, `log`, `onConnect`, `verify`); better-sqlite3 tests its options with `in`,
  including `nativeBinding` (which loads a native addon) and `verbose` (which receives every
  statement); mysql2 reads `stream`, `infileStreamFactory`, `authPlugins`, `typeCast` and
  more. A key planted on `Object.prototype` reaches these drivers even though Egon itself
  no longer reads it. Options: (a) leave it to the drivers (documented in `SECURITY.md`,
  as this PR does); (b) give each driver a configuration in which every key the driver
  reads is set, as an own property (with `undefined` where we have nothing), which depends
  on each driver's version and has to be kept up to date; (c) a null-prototype
  configuration, which helps where the driver uses the object as it is (better-sqlite3)
  but not where it copies it into a plain object first (pg-pool). This PR does (a) only,
  and does not choose: **the owner's call.** My recommendation: (b) for better-sqlite3's
  short list (`nativeBinding`, `verbose`, `timeout`, `fileMustExist`, `memory`,
  `readOnly`), and (a) for pg and mysql2, whose lists are long and change between releases.

## Requests

- **Batch step named `__proto__`** (another part, not fixed): `checkName` in
  `packages/core/src/batch/batch.ts` does not refuse `"__proto__"`, and step results are
  stored with `results[key] = …` on plain objects, so a step of that name with an object
  result replaces the results object's prototype. Found by the audit.
