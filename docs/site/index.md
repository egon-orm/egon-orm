---
layout: home
hero:
  name: Egon ORM
  text: Typed data access for TypeScript
  tagline: Schemas, changesets, composable queries and a repo, typed end to end with no code generation. For Postgres, SQLite and MySQL.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Tutorial
      link: /guide/tutorial
    - theme: alt
      text: Why Egon
      link: /guide/
features:
  - title: Typed end to end
    details: Row types, preloaded associations and select results are inferred from the schema classes. There is no generate step and no schema file to keep in sync.
  - title: Changes are values
    details: A changeset holds the permitted input, its validation errors and the constraints to expect. Writes return a result, so a rejected form is an expected outcome, not an exception.
  - title: Queries are values
    details: Build a query in one function, extend it in another, run it with the repo. Nothing runs until you ask, and every value is a bound parameter.
  - title: Nothing implicit
    details: No lazy loading and no save() on rows; a missing preload is a compile error, not an extra query. Nothing joins a transaction you did not open; a single call that writes several statements is atomic on its own.
---

::: info 0.x release
Egon ORM 0.1.0 is on npm. Before 1.0 a minor release can make breaking changes; see
[Upgrading](/reference/upgrading).
:::

## Install

```sh
npm install egon-orm @egon-orm/postgres pg
```

Node.js 22.12 or later. For SQLite use `@egon-orm/sqlite` with `better-sqlite3`, for MySQL
`@egon-orm/mysql` with `mysql2`.

## A first look

<<< @/examples/home.ts#example

The tables are not shown: [Getting started](/guide/getting-started) creates them with a
migration.

- A **schema** class describes a table; its instances are rows.
- A **changeset** (`User.changeset`) filters and validates input, and declares that a
  duplicate email is a form error.
- A **query** (`from(User, "u")…`) is an immutable value; `preload` loads associations
  without N+1 queries.
- The **repo** runs queries and writes changesets. `insert` returns
  `{ success: true, data }` or `{ success: false, error }`.

Next: [Getting started](/guide/getting-started) in five minutes, or the
[Tutorial](/guide/tutorial) in thirty. Coming from another ORM? Read the page for
[Prisma](/guide/coming-from-prisma), [Drizzle](/guide/coming-from-drizzle) or
[Sequelize](/guide/coming-from-sequelize).
