# Roadmap

Egon ORM 0.1.0 is on npm. Before 1.0 a minor release can make breaking changes; see
[Upgrading](/reference/upgrading).

## Built

| Feature | Pages |
|---|---|
| Schemas, types, associations and embeds | [Schemas](/guide/schemas), [Types](/guide/types), [Associations](/guide/associations), [Embeds](/guide/embeds) |
| Changesets, validation (built-in rules, Zod and any Standard Schema library), constraints, nested changesets | [Changesets](/guide/changesets), [Validation](/guide/validation), [Constraints](/guide/constraints), [Nested changesets](/guide/nested-changesets) |
| The query builder: joins, subqueries, CTEs, set operations, window functions, fragments, named parameters | [Queries](/guide/queries), [Expressions](/guide/query-expressions), [Advanced queries](/guide/queries-advanced) |
| The repo: reads, writes, upserts, bulk writes, preloads, streams, transactions, batches, the test sandbox | [Repo](/guide/repo), [Transactions](/guide/transactions), [Batch](/guide/batch), [Testing](/guide/testing) |
| Postgres, SQLite and MySQL adapters | [Adapters](/guide/adapters), [Dialect support](/reference/dialect-support) |
| Migrations, their runner and the `egon` command | [Migrations](/guide/migrations), [CLI](/reference/cli) |

## Planned

| Feature | Notes |
|---|---|
| Performance | Benchmarks against the raw drivers. No numbers are published until then. |
| Faster editor completions in nested query callbacks | Completions in a query callback no longer depend on the size of the model (about 25 ms after an edit, with 200 connected schemas or ten). A callback inside a callback that returns the query, as in `preload("posts", (q) => q.where(…))` or `pipe((q) => q.where(…))`, still costs more as the model grows: about 270 ms with 200 connected schemas on the machine measured, because inferring the outer callback's result type reads every schema reachable through associations. Until then, declaring the return type of `changeset` methods lowers the cost; include in it the error keys the validations add, as in `Changeset<typeof User, boolean, "passwordConfirmation">`, or `errorMessages()` loses them. See the [FAQ](/guide/faq#are-editor-completions-slow-in-a-large-model). |
| Lateral joins | `joinLateral`, `leftJoinLateral`. |
| `VALUES` lists as a query source | `from(values(...), "v")`. |
| Table-valued fragments | Such as `generate_series` as a source. |
| Index hints | MySQL. |
| Data-modifying CTEs | `UPDATE` or `DELETE` inside a `WITH`. |
| Named server-side prepared statements | For [`prepare`](/guide/queries-advanced#prepared-queries). |
| Form helpers for nested changesets | Sort and drop parameters, and index-keyed objects in place of arrays. |
| Other databases through a custom dialect | |
| Built-in multi-tenancy | Tenants as a column of shared tables, with the tenant given explicitly on the repo or the call: a query or write on a tenant-scoped schema class without a tenant is refused, inserts fill in the tenant, and preloads stay within it. A database schema per tenant stays a [recipe](/recipes/multi-tenancy), using the repo's `schema` option. |
| Built-in soft deletes | Support for what the [soft-deletes recipe](/recipes/soft-deletes) does by hand: a schema option for the deleted-at field, soft delete and restore in the repo, and an explicit opt-in to leave deleted rows out of a query. No default scope applies by itself. |
| Postgres row-level security | Operations in migrations to enable row-level security on a table and to create and drop policies, each with the operation that undoes it, for `down`; settings such as the application's user id (`app.user_id`) given per transaction, always transaction-scoped and bound; a new row a policy refuses (SQLSTATE `42501`, "new row violates row-level security policy") reported as an error of its own. Rows a policy hides are not errors: a read leaves them out and a write affects no rows. Postgres only. |
| Query observability | Built on the `query` event of [`repo.on`](/guide/repo#logging-and-events), which already reports each statement's SQL and timings: slow-query detection, OpenTelemetry tracing and warnings for N+1 query patterns. |
| A browser entry point | `egon-orm/client`, with `cast` and the validations, so a form can run the same casts and field validations in the browser, without bundling the query builder or the repo. Constraints and checks that ask the database stay on the server. |
| Test factories | Beside the [test sandbox](/guide/testing): build valid rows for a schema, override single fields, create association graphs, and generate deterministic test data. For integration tests in large applications. |

## Not planned

These are deliberate choices, not gaps:

- **Active-record methods** such as `user.save()`. Rows are data.
- **Lazy loading.** Associations are loaded only when asked for.
- **An identity map or unit of work.** Two queries for the same row return two objects.
- **Implicit transactions.** Nothing joins a transaction you did not open: only calls on
  the transaction object are inside it. (A single call that writes several statements, a
  parent with its children or a chunked `insertAll`, is atomic on its own.)
- **Generating migrations from schema differences.** Migrations are written by hand.
- **Non-SQL stores.**
