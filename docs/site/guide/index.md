# Introduction

::: info 0.x release
Egon ORM 0.1.0 is on npm. Before 1.0 a minor release can make breaking changes; see
[Upgrading](/reference/upgrading).
:::

Egon ORM is a TypeScript ORM for Postgres, SQLite and MySQL. It keeps four things apart
that many ORMs blend together:

| Concept | What it is | Page |
|---|---|---|
| **Schema** | A class that describes a table: its fields, types and associations. Rows are instances of it. | [Schemas](/guide/schemas) |
| **Changeset** | A description of a change to one record: the filtered input, the validation errors, the constraints to check. | [Changesets](/guide/changesets) |
| **Query** | An immutable value that describes what to read or bulk-write. Nothing runs when you build one. | [Queries](/guide/queries) |
| **Repo** | The only thing that talks to the database. It runs queries and writes changesets. | [Repo](/guide/repo) |

<<< @/examples/home.ts#example

## Why keep them apart

- **Data is just data.** A row is a typed object the database returned. It has no
  connection, no dirty flags and no `save()`, so passing it around, caching it or sending it
  to a client cannot trigger a query.
- **A change is a value you can inspect.** Each form is a function from input to a
  changeset: it permits its own fields, validates them, and declares which database
  constraints should come back as form errors. You can test it without a database.
- **A query is a value you can compose.** A function can take a query and return a
  narrower one; a base query can be kept in a constant. The SQL that runs is the SQL the
  query describes.
- **One object does I/O.** Everything that touches the database goes through the repo, or
  through `tx`, the repo bound to a transaction. What runs inside a transaction is
  visible in the code.

## How it differs from other TypeScript ORMs

These are differences in approach, not a ranking; each tool makes sensible choices for
its goals.

| | Egon | Prisma | Drizzle | TypeORM, Sequelize |
|---|---|---|---|---|
| Where the schema lives | TypeScript classes | a `.prisma` file, compiled by `prisma generate` | TypeScript table objects | decorated entity classes or model definitions |
| Reading related rows | `preload`, typed per query | `include` / `select` | relational queries (`with`) or joins | eager `include` / `relations`, and lazy loading |
| Validating input | changesets, with built-in rules or any Standard Schema library | not built in | not built in (`drizzle-zod` derives schemas) | Sequelize model validators; TypeORM uses `class-validator` |
| A rejected write | a result: `{ success: false, error }` with field errors | an exception (`P2002` for a unique violation) | an exception (a `DrizzleQueryError` wrapping the driver's error) | an exception |
| Transactions | explicit: only calls on `tx` are inside | explicit (`$transaction`) | explicit (`db.transaction`) | explicit; Sequelize can pass them implicitly through CLS |
| Migrations | written by hand | generated from schema changes | generated from schema changes (drizzle-kit) | TypeORM: generated or written by hand; Sequelize: written by hand |

What you get from the Egon approach:

- **Typed end to end without a build step.** Row types, preloaded associations and
  `select` results are inferred from the classes. A row loaded without `posts` has no
  `posts` property in its type.
- **Forms and database errors in one shape.** A unique index violated at write time comes
  back as `{ email: ["has already been taken"] }`, next to the validation errors.
- **No hidden queries.** No lazy loading and no query you did not write. Nothing joins a
  transaction you did not open; a single call that writes several statements (a parent
  with its children, a chunked `insertAll`) is atomic on its own.

What it costs, honestly:

- **More explicit code.** A form needs a changeset function; a page needs its preloads
  listed. Where another ORM guesses, Egon asks.
- **Migrations are yours to write.** Nothing is diffed from your schema classes, and
  keeping the classes and the database in step is your job
  (`egon migrate create <name>` writes an empty one to fill in).
- **Results to check.** `insert` returns a result you must look at, or use
  `insertOrThrow`.
- **No identity map.** The same record loaded twice is two objects.
- **Young.** The first release is 0.1.0, the ecosystem is small, and SQLite and MySQL have
  [documented gaps](/reference/dialect-support).

## What to expect if you come from another ORM

- **No lazy loading.** An association is on a row only if you preloaded it, and the type
  says so. `user.posts` on a row loaded without it is a compile error.
- **Rows are data.** There is no `user.save()`. You describe a change with a changeset and
  hand it to the repo.
- **New records are changesets, not objects.** You never write `new User()`. A `User`
  object exists only after the database returned one.
- **Writes return a result.** `repo.insert` returns `{ success: true, data }` or
  `{ success: false, error }`, where `error` is the changeset with its errors.
  `repo.insertOrThrow` throws instead.
- **Fields are non-null by default.** `.nullable()` opts in.
- **Transactions are explicit.** Only calls on the transaction object are inside it. A
  single write that spans several statements opens its own, so it is all or nothing.
- **Every value is a bound parameter.** Raw SQL is possible only through the `fragment`
  template, whose interpolations are bound too.

The pages for [Prisma](/guide/coming-from-prisma), [Drizzle](/guide/coming-from-drizzle)
and [Sequelize](/guide/coming-from-sequelize) users map common tasks one by one.

## Naming conventions

- Functions and options are camelCase.
- A method that returns `null` or a result has a throwing twin ending in `OrThrow`:
  `get` / `getOrThrow`, `insert` / `insertOrThrow`.
- Field names are camelCase in TypeScript and snake_case in the database (`createdAt` is
  the column `created_at`), unless a field says otherwise with `.column("...")`.
- The words used throughout these pages are defined in the [Glossary](/reference/glossary).

## See also

- [Getting started](/guide/getting-started): from install to a first query.
- [Tutorial](/guide/tutorial): a small blog, step by step.
- [FAQ and troubleshooting](/guide/faq): the errors people hit first.
