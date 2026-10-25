# Recipes

Short answers to common tasks. Each recipe is a complete example: the code on the page is
type-checked, and, except for the React form, runs in CI against Postgres, with the values
in its `// =>` comments checked.

Each recipe shows its schemas, tables and starting rows in a folded block. Run each one in
an empty database of its own: they create their own tables, and some use the same table
names with other columns.

## Reading

| Recipe | In short |
|---|---|
| [Pagination](/recipes/pagination) | `limit` and `offset` with a total, or keyset pagination with a tuple cursor. |
| [Top N per parent](/recipes/top-n-per-parent) | A preload with a per-parent `limit`, or a window function. |
| [Filters from a query string](/recipes/dynamic-filters) | Validate `?q=…&page=…` with a schemaless changeset, then add clauses conditionally. |
| [Full-text search](/recipes/full-text-search) | A generated `tsvector` column, and `fragment` for `@@` and `ts_rank`. |

## Writing

| Recipe | In short |
|---|---|
| [Upserts](/recipes/upserts) | `onConflict` on `insert` and `insertAll`. |
| [Find or create](/recipes/find-or-create) | Insert with `onConflict: "nothing"`, then read the row that won. |
| [Optimistic locking](/recipes/optimistic-locking) | `optimisticLock("lockVersion")`, and a conflict reported on the form. |
| [Soft deletes](/recipes/soft-deletes) | A `deletedAt` field and a reusable scope. |
| [Auditing](/recipes/auditing) | A batch that writes a row and its audit entry together. |

## Modelling

| Recipe | In short |
|---|---|
| [Enums](/recipes/enums) | `t.enum` for text and integer columns, with a check constraint. |
| [Money](/recipes/money) | A custom type that stores cents in a `numeric` column. |
| [Multi-tenancy with database schemas](/recipes/multi-tenancy) | A database schema per tenant, chosen per call or per repo. |

## Forms and messages

| Recipe | In short |
|---|---|
| [Showing form errors (React)](/recipes/form-errors) | A server action that returns `errorMessages()`, and fields that show them. |
| [Translating error messages](/recipes/translating-errors) | `traverseErrors` with a message catalogue and plural rules. |
| [Errors as HTTP responses](/recipes/error-responses) | 422 for an invalid changeset, 404, 409 and 500 for the rest, typed on the client with `Json` and `ErrorMessages`. |
