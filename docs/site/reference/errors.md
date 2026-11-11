# Errors

Every error the library throws extends `EgonError`. Each has a stable `code` for its class,
a stable `id` for its message, a short message that names what failed and links to the
entry of its `id`, and, where a driver error was involved, that error as `cause`.

<<< @/examples/errors.ts#handle

`isEgonError(value, code?)` checks by code. It works across two copies of the package,
where `instanceof` would not:

<<< @/examples/errors.ts#by-code

## Identifiers and messages

Each distinct message has an identifier, `error.id`, such as `"query.aliasTaken"`: the
namespace of its class and a name, or the class's `code` alone for a class with one
message (`"noResults"`). It never changes between releases, and its type, `ErrorId`, is
the union of them all, so a `switch` on it is checked:

<<< @/examples/errors.ts#by-id

A message reads `<id>: <short sentence> See <link>`:

```text
query.aliasTaken: join() was given the alias "u", which this query already uses. See https://egon-orm.github.io/egon-orm/reference/errors/query#query-aliastaken
```

The short sentence says what failed, with the names it concerns (the clause, the schema,
the field, the SQL state). What to do about it is on the identifier's entry, one page per
namespace:

| Page | Thrown as |
|---|---|
| [General](/reference/errors/general) | `NoResultsError`, `MultipleResultsError`, `InvalidChangesetError`, `StaleEntryError`, `NotLoadedError` |
| [Query](/reference/errors/query) | `QueryError` |
| [Cast](/reference/errors/cast) | `CastError` |
| [Schema definition](/reference/errors/schema) | `SchemaDefinitionError` |
| [Constraint](/reference/errors/constraint) | `ConstraintError` |
| [Database](/reference/errors/database) | `DatabaseError` |
| [Rollback](/reference/errors/rollback) | `RollbackError` |
| [Migration](/reference/errors/migration) | `MigrationError` |

Short messages keep the bundle small: when every message carried its advice, error text
was about 15% of the library's minified size, and an application that runs on the edge
ships its bundle with every deployment.

## Full messages, in development

The advice ships separately, in `egon-orm/messages`. There are two ways to use it, and
both are explicit.

**For every error:** `useFullErrorMessages(messages)` makes every error constructed after
the call carry the full text: the short sentence, what to do about it, and the link.

<<< @/examples/errors.ts#full-messages

It works on every runtime (it reads nothing from `process`), on Cloudflare Workers and
Vercel Edge too. What brings the catalog into a bundle is importing `egon-orm/messages`
(for `messages` or for `explain`); an application that never imports it ships no advice.

::: warning Call it before your schemas are defined
An error made before the call keeps its short message. A schema whose definition is wrong
throws while its module is imported, which can happen before the code that calls
`useFullErrorMessages` runs: call it in the first module your application imports, or use
`explain(error)`.
:::

**For one error:** `explain(error)` returns the full text of one error, whenever it was
made, without changing any setting. It is the form for a log line or an error page:

<<< @/examples/errors.ts#explain

`explain` takes any value: an Egon error gives its full text (or its message as it is,
when the catalog has no entry for its identifier, or it was made by another copy of the
package); any other `Error` gives `name: message`; anything else `String(value)`.

Both take a catalog of your own instead, with the same shape: for an identifier, the
advice that follows the short sentence. `{{name}}` in an entry is replaced by a parameter
the error carries (a name such as the field or the column; the generated pages list each
entry with its placeholders). An identifier your catalog leaves out keeps its short message:

<<< @/examples/errors.ts#translated

## Sending an error to a client

`JSON.stringify(error)` gives `{ name, code, id }` and nothing else: the message, the cause
and any SQL stay on the server. It is safe to send, and stable to switch on:

<<< @/examples/errors.ts#to-json

## Classes

| Error | `code` | Thrown when | Extra fields | How to fix |
|---|---|---|---|---|
| `InvalidChangesetError` | `"invalidChangeset"` | An `OrThrow` write or `applyActionOrThrow` is given an invalid changeset, or a declared constraint is violated. | `changeset`, `action` | Show `error.changeset.errorMessages()`, or use the method without `OrThrow` and check the result. |
| `ConstraintError` | `"constraint"` | The database rejects a write and the changeset did not declare that constraint; also every violation in a bulk write. | `type`, `constraint`, `table`, `column`, `detail`, `sql` | Declare it on the changeset (the full message says how). See [Constraints](/guide/constraints). |
| `StaleEntryError` | `"staleEntry"` | An update or delete matched no row: the row was deleted, or an optimistic lock failed. | `action`, `schema` | Reload and retry, or pass `staleError` / `allowStale`. See [Update](/guide/repo#update). |
| `NoResultsError` | `"noResults"` | `oneOrThrow`, `firstOrThrow`, `getOrThrow`, `getByOrThrow` or `reloadOrThrow` found nothing. | `query` (rendered, without values) | Use the method without `OrThrow` where a missing row is expected. |
| `MultipleResultsError` | `"multipleResults"` | `one`, `getBy` or their twins matched more than one row. | `count`, `query` | Make the query unique, or use `first` for "any one". |
| `QueryError` | `"query"` | A query, changeset, batch or transaction is built or used wrongly, or needs a feature the database lacks. | | The entry of `error.id` says what to do. See [Dialect support](/reference/dialect-support) for features. |
| `CastError` | `"cast"` | `cast` is given params that are not an object, or a stored value does not fit its field's type. | | Pass a plain object; check the column holds what the field declares. |
| `NotLoadedError` | `"notLoaded"` | `castAssoc` or `putAssoc` is used on an association of a loaded row that was not preloaded as whole rows. | `schema`, `association` | Preload the association before building the changeset. |
| `SchemaDefinitionError` | `"schemaDefinition"` | A schema, type or association is defined incorrectly, or a schema's constructor is called. | | The message names the schema and the field; the entry of `error.id` says what to do. |
| `RollbackError` | `"rollback"` | `transactionOrThrow` ended in a rollback: `tx.rollback(reason)`, a batch step that failed (`reason` is `{ step, error, completed }`), or a statement that failed and was not handled. | `reason` | Use `transaction` to get the rollback as a result. |
| `DatabaseError` | see below | The connection or the database failed. | `retryable`, `sql` | Depends on the code. |
| `MigrationError` | `"migration"` | A [migration](/guide/migrations) has no `up` or no `down`, uses a feature the database lacks, failed, is missing its file, or the migration lock could not be taken. Imported from `egon-orm/migration`. | `version`, `migration`, `sql` | The message says which migration and why. |

Every class also has `id` and `toJSON()`.

## `DatabaseError` codes

| Code | Meaning | `retryable` |
|---|---|---|
| `"database"` | A driver error with no more specific code. | no |
| `"connection"` | Could not connect, the connection was lost, or the repo was closed. | no |
| `"serializationFailure"` | The transaction conflicted with another. | yes |
| `"deadlock"` | The database broke a deadlock by cancelling this transaction. | yes |
| `"aborted"` | The query was cancelled by the caller's `AbortSignal`. | no |
| `"timeout"` | The statement, or the whole call, ran longer than its `timeoutMs`. | no |

[`retries`](/guide/transactions#options) on a transaction runs it again for the retryable
codes.

## What is not thrown

Invalid input and declared constraint violations are **returned**, not thrown, by the
methods without `OrThrow`:

<<< @/examples/errors.ts#result

See [Writing](/guide/repo#writing). Their messages (`can't be blank`, `has already been
taken`) are data for your users, and are not affected by any of the above.

## What errors contain

- The SQL that failed (`sql`), where there was one.
- The driver's error as `cause`.
- Never the parameter values, unless the repo was created with `log: { params: true }`.
- Never the value of a [redacted](/guide/schemas#fields) field. A database message that may quote a value is left out of the message and kept on
  `cause`.

`console.log(error)` and `util.inspect(error)` are safe to use: they show the stack, the
identifier, the code and the other fields, but not the database's own text, which may
quote a value. `ConstraintError.detail` is shown as hidden, and the cause as one line of
names and codes, an Egon error by its identifier and a driver's error by its code:

```text
ConstraintError: constraint.violated: The database rejected the write: … See https://…
    at … {
  id: 'constraint.violated',
  code: 'constraint',
  type: 'unique',
  constraint: 'accounts_token_hash_key',
  table: 'accounts',
  column: undefined,
  detail: (hidden: read error.detail),
  sql: 'insert into "accounts" ("email", "token_hash") values ($1, $2) returning "id"',
  [cause]: error 23505 (hidden: read error.cause)
}
```

The properties are unchanged: reading `error.detail` or `error.cause` yourself gives the
raw text, quoted values included, for debugging. Every cause is shown by name and code
only, including one that is not the database's (a `TypeError` thrown in a migration's
`up()`); to see the cause and where it was thrown, use `console.log(error.cause)`.
Node's own printer of an uncaught exception or unhandled rejection does not use custom
inspection, so it prints that text:
catch errors before they reach the top level, and log them by `message` or `toJSON()`.
See [SECURITY.md](https://github.com/egon-orm/egon-orm/blob/main/SECURITY.md).

## See also

- [FAQ and troubleshooting](/guide/faq): the messages people meet first, and their fixes.
- [Adapters: errors](/guide/adapters#errors): how driver errors are converted.
- [Edge runtimes](/guide/edge): short messages and the size of a Worker.
