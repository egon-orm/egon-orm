# Changelog

Every release of Egon ORM, newest first. All packages (`egon-orm` and every `@egon-orm/*`
package) are released together and share one version number. When a release changes
something you have to act on, its entry links to a section of the
[upgrade guide](https://egon-orm.github.io/egon-orm/reference/upgrading), which also states
the versioning and support policy. Each package's own `CHANGELOG.md` lists the changes
recorded for it.

## 0.1.0 (unreleased)

The first release: a TypeScript ORM for Postgres, SQLite and MySQL with schemas,
changesets, composable queries and a repo, typed end to end with no code generation.

**Requirements:** Node.js 22.12 or later; TypeScript 5.8 or later (owner decision,
2026-10-22). The packages are ES
modules only; a CommonJS project loads them with `require()`. Postgres 14 or later, SQLite
3.39 or later, MySQL 8.0.31 or later
([supported versions](https://egon-orm.github.io/egon-orm/reference/upgrading#supported-versions)).

If you used the packages from this repository before this release, read
[Upgrading to 0.1.0](https://egon-orm.github.io/egon-orm/reference/upgrading#_0-1-0): the
error constructors take an identifier first, error messages are short by default, the
dialect packages no longer export `normalizePgError`, `normalizeSqliteError` and
`normalizeMysqlError`, `ConstraintOptions` of `egon-orm/migration` is now
`CreateConstraintOptions`, and the published declarations leave out members that were only
for the library's own use (`plan()`, `named` and `query` of a `PreparedQuery`, `operations`
of the migration builder, and the migration builders' `context` and `added`).

### Packages

| Package | What it is |
|---|---|
| `egon-orm` | The library: schemas, types, changesets, queries, the repo, batches, errors. Entry points `egon-orm`, `egon-orm/migration`, `egon-orm/testing` and `egon-orm/messages`. No runtime dependency. |
| `@egon-orm/postgres` | The Postgres adapter, over `pg` (and `pg-cursor` for streams). Postgres runs every feature and every test. |
| `@egon-orm/sqlite` | The SQLite adapter, over `better-sqlite3`. |
| `@egon-orm/mysql` | The MySQL adapter, over `mysql2`. |
| `@egon-orm/zod` | `toZod`, which derives a Zod schema from a schema class, and `castWith`. |
| `@egon-orm/cli` | The `egon` command: migrations and the development database. |

### Schemas and types

- A schema is a class: `class User extends Schema("users", { ... }) {}`. Rows are
  instances of it, with your getters and methods, and their types come from the fields.
- Fields are non-null unless marked `.nullable()`. Field types for text, numbers,
  decimals, big integers, booleans, enums, UUIDs, dates, times, timestamps, binary data,
  JSON and arrays, plus `defineType` for your own; embedded schemas (`embedOne`,
  `embedMany`) stored as JSON.
- camelCase in TypeScript, snake_case in the database by default, with per-field and
  per-schema overrides. `timestamps()`, generated keys, redacted and virtual fields.
- Associations: `belongsTo`, `hasOne`, `hasMany`, `manyToMany`, and read-only chains of them
  (`through`).

### Changesets and validation

- `cast` and `change` describe a change to one record: the permitted input, the errors and
  the constraints to check. Changesets are immutable and synchronous; `validateAsync` is
  the explicit asynchronous step. `applyAction` and `applyActionOrThrow` validate a form
  without storing it.
- Built-in validations (required, length, format, number, inclusion, confirmation and
  more), any [Standard Schema](https://standardschema.dev) validator (Zod, Valibot,
  ArkType, Yup) and plain functions.
- Unique, foreign-key, check and exclusion constraints declared on the changeset come back
  as field errors instead of exceptions.
- Nested changesets write a parent with its children (`castAssoc`, `putAssoc`,
  `castEmbed`) in one atomic call.
- A field name listed twice (in `cast`'s permitted list, `validateRequired`,
  `uniqueConstraint`, `validateUniqueAsync`, or a repo write's `returning` and
  `onConflict` lists) counts once: one error, one column.
- Every options read Egon makes is of own properties only: a key planted on
  `Object.prototype` is never taken as an option, and neither are the library's defaults'
  inherited keys. What the `pg` and `mysql2` drivers read from their own configuration is
  left to them ([SECURITY.md](./SECURITY.md)).
- A date given as `{ year, month, day }` and an embedded value given as an object read
  only their own properties: `{}` is a cast error for a date, and a missing embedded field
  takes its default, whatever `Object.prototype` holds.
- `__proto__` is refused as a batch step name, a binding alias and a `param()` name (each
  keys an object), and a `__proto__` key of JSON data stays a key when an embed is stored
  or a preloaded row is copied.
- The SQLite adapter gives `better-sqlite3` options without a prototype, with every key it
  reads set, so a key planted on `Object.prototype` (`verbose`, `nativeBinding`) never
  reaches it.

### Queries

- `from(User, "u")` builds an immutable query with named bindings:
  `.where(({ u }) => u.age.gte(18))`. Joins (also through associations), subqueries,
  CTEs (recursive too), set operations, window functions, aggregates, `caseWhen`,
  locking, `dynamic` filters and named parameters with `prepare`.
- `fragment` is the only way to write raw SQL, and its interpolations are bound too: every
  value in a query is a bound parameter.
- `select` results, joins and preloads are typed; using an association that was not
  preloaded is a compile error.

### The repo

- `createRepo({ adapter })`: reads (`all`, `one`, `get`, `getBy`, `count`, `aggregate`,
  `exists`, `stream`), writes (`insert`, `update`, `delete`, upserts, `insertAll`,
  `updateAll`, `deleteAll`), each returning `{ success: true, data }` or
  `{ success: false, error }` with an `OrThrow` twin. The reads that can find nothing
  (`one`, `first`, `get`, `getBy`, `reload`) have one too.
- Preloads, in one query per association or through a join.
- Explicit transactions with savepoints, `tx.rollback(reason)`, and `createBatch` for a
  sequence of dependent steps that commits or rolls back as one.
- Query events and logging, with parameter values left out unless you turn them on.
- `egon-orm/testing`: a sandbox that runs each test in a transaction it rolls back, and
  `expectQueries` to assert on the SQL a block of code runs.

### Databases

- Postgres is supported in full. SQLite and MySQL run the same schemas, changesets, queries
  and repo calls; what they cannot do is listed per feature in
  [dialect support](https://egon-orm.github.io/egon-orm/reference/dialect-support), and a
  query that uses it fails with an error that says so.
- Database errors are normalised to `DatabaseError` with a `code` (`connection`,
  `deadlock`, `serializationFailure`, `timeout`, ...) and `retryable`.

### Migrations and the CLI

- `egon-orm/migration`: `defineMigration` with `up` and `down`, a builder for tables,
  columns, indexes and constraints on all three databases, and `createMigrator`, which
  runs them in transactions under a lock.
- `egon migrate`, `egon migrate create`, `egon rollback`, `egon migrations` and
  `egon db create | drop | reset`, configured by `egon.config.ts`.

### Errors

- Every error has a stable `code` (its class) and `id` (the message), such as
  `database.connectionFailed`, and links to its entry in the
  [error reference](https://egon-orm.github.io/egon-orm/reference/errors).
- Messages are short by default; `useFullErrorMessages(messages)` from `egon-orm/messages`
  adds the explanation and the fix, for development. `explain(error)` gives the full text
  of one error.
- `JSON.stringify(error)` gives `{ name, code, id }`, safe to send to a client.

### JSON responses

- A row's `toJSON()` gives the shape a client receives: timestamps as ISO strings, big
  integers as strings, binary data as base64, redacted and virtual fields left out.
  `JsonReturn<typeof handler>` types the response of a handler.
- A changeset's `toJSON()` leaves redacted and virtual fields out of its changes.

### Edge runtimes

- Runs on Cloudflare Workers (tested in `workerd`) and other runtimes that refuse code
  generation, with a repo per request that reuses the compiled query plans.
- Node.js built-ins are imported as `node:` only, and the packages are side-effect free,
  so a bundler keeps only what you import.

### Not in this release

- Published performance numbers: the benchmarks against the raw drivers have not run yet.
- Lateral joins, `VALUES` lists as a query source, data-modifying CTEs and the other items
  on the [roadmap](https://egon-orm.github.io/egon-orm/reference/roadmap).
