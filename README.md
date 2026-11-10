<h1><picture><source media="(prefers-color-scheme: dark)" srcset="docs/site/public/logo-dark.png"><img src="docs/site/public/logo.png" alt="" height="48" align="center" hspace="4"></picture>Egon ORM</h1>

[![CI](https://github.com/egon-orm/egon-orm/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/egon-orm/egon-orm/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/egon-orm)](https://www.npmjs.com/package/egon-orm)
[![Coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fegon-orm.github.io%2Fegon-orm%2Fbadges%2Fcoverage.json)](https://github.com/egon-orm/egon-orm/actions/workflows/docs.yml)
[![Docs](https://img.shields.io/badge/docs-egon--orm.github.io-137c3d)](https://egon-orm.github.io/egon-orm/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![Node >= 22.12](https://img.shields.io/badge/node-%3E%3D22.12-339933)

A TypeScript ORM for Postgres, SQLite and MySQL with **schemas**, **changesets**,
composable **queries** and a **repo**, typed end to end with no code generation.

- **Typed from the schema.** Row types, preloaded associations and `select` results are
  inferred from your classes. No generate step, no schema file to keep in sync.
- **Changes are values.** A changeset filters and validates input (built-in rules, Zod or
  any Standard Schema library) and turns a violated unique index into a field error.
  Writes return `{ success, data }` or `{ success: false, error }`.
- **Queries are values.** Build them in one place, extend them in another; every value is
  a bound parameter.
- **Nothing implicit.** No lazy loading (a missing preload is a compile error) and no
  `save()` on rows. Nothing joins a transaction you did not open; a single call that
  writes several statements (a parent with its children, a chunked `insertAll`) is atomic
  on its own.

> **Status: 0.x.** 0.1.0 is on npm. Before 1.0 a minor release can make breaking changes
> ([versioning policy](docs/site/reference/upgrading.md)). The design and build plan live in
> [`docs/plan/README.md`](docs/plan/README.md).

## Install

```sh
pnpm add egon-orm @egon-orm/postgres pg
```

Node.js 22.12 or later; ES modules (a CommonJS project can `require()` them on Node.js 22.12
or later). For SQLite use `@egon-orm/sqlite` with `better-sqlite3`; for MySQL,
`@egon-orm/mysql` with `mysql2`.

## Example

<!-- example: docs/site/examples/home.ts#example -->
```ts
import { postgres } from "@egon-orm/postgres";
import { belongsTo, cast, count, createRepo, from, hasMany, Schema, t, timestamps } from "egon-orm";

// Over two tables with serial (32-bit) keys, which t.integer() reads.
class User extends Schema("users", {
  id: t.integer().primaryKey().dbGenerated(),
  email: t.string(),
  name: t.string().nullable(),
  ...timestamps(),
}) {
  static posts = hasMany(() => Post, { foreignKey: "authorId" });

  static changeset(user: User | typeof User, params: unknown) {
    return cast(user, params, ["email", "name"]).validateRequired(["email"]).uniqueConstraint("email");
  }
}

class Post extends Schema("posts", {
  id: t.integer().primaryKey().dbGenerated(),
  authorId: t.integer(),
  title: t.string(),
}) {
  static author = belongsTo(() => User, { foreignKey: "authorId" });
}

const repo = createRepo({ adapter: postgres({ connectionString: process.env.DATABASE_URL }) });

const result = await repo.insert(User.changeset(User, { email: "ada@example.com" }));
if (!result.success) console.log(result.error.errorMessages()); // if the email is taken: { email: ["has already been taken"] }

const authors = await repo.all(
  from(User, "u")
    .where(({ u }) => u.name.isNotNull())
    .preload("posts"),
);
authors[0]?.posts[0]?.title; // string: the type knows "posts" was preloaded

const stats = await repo.all(
  from(User, "u")
    .leftJoinAssoc("u", "posts", "p")
    .groupBy(({ u }) => u.id)
    .select(({ u, p }) => ({ email: u.email, posts: count(p.id) })),
); // { email: string; posts: number }[]

```

## Documentation

The documentation site is [egon-orm.github.io/egon-orm](https://egon-orm.github.io/egon-orm/).
Its pages are Markdown in [`docs/site`](docs/site), readable here on GitHub too, and
`pnpm docs:dev` serves the site, API reference included, locally.

- [Getting started](docs/site/guide/getting-started.md): a first query in five minutes.
- [Tutorial](docs/site/guide/tutorial.md): a blog, step by step ([source](examples/blog)).
- Coming from [Prisma](docs/site/guide/coming-from-prisma.md), [Drizzle](docs/site/guide/coming-from-drizzle.md) or [Sequelize](docs/site/guide/coming-from-sequelize.md).
- [Recipes](docs/site/recipes/index.md) and the [roadmap](docs/site/reference/roadmap.md).

## Packages

| Package | Purpose |
|---|---|
| `egon-orm` | Schemas, types, changesets, queries, the repo; `egon-orm/testing` and `egon-orm/migration` |
| `@egon-orm/postgres` | The Postgres adapter (every feature) |
| `@egon-orm/sqlite`, `@egon-orm/mysql` | The SQLite and MySQL adapters ([documented gaps](docs/site/reference/dialect-support.md)) |
| `@egon-orm/zod` | Zod schemas derived from schema classes |
| `@egon-orm/cli` | The `egon` command: migrations and development databases |

## Development

Requires Node.js 22.12 or newer, pnpm 12 and Docker.

```sh
pnpm i
pnpm db:up              # Postgres 16 on localhost:54329
pnpm check              # lint + typecheck + unit tests + type tests + build
pnpm test:integration   # needs the database
pnpm docs:dev           # documentation site
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for everything else.

## License

[MIT](LICENSE)
