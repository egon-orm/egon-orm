# 1.0 gate item 1: inspect output of errors (security finding F4), status

Branch `step/21-gate-inspect-errors`, 2026-11-10, from `main` at `a118ddf`. PR #PRNUM.
Background: `status/21-security.md` (F4), `status/21-audit.md` §4.1 and §8 item 1.

Labels: **verified** (I ran it), **measured** (a number I took), **unverified** (not checked).

## What shipped

- **A custom inspect on `EgonError`**, so on every Egon error class, not only
  `ConstraintError` and `DatabaseError` (`packages/core/src/errors.ts`). Driver errors reach
  `DatabaseError`, `ConstraintError` and `MigrationError` as `cause`, and a `QueryError`
  can wrap a failed statement's error (`repo/transaction.ts` `failedError`, `brokenError`), so
  the base class is the one place that covers them all, including classes added later.
  It is keyed by `Symbol.for("nodejs.util.inspect.custom")`, with no import of `node:util`, as
  `changeset.ts`, `schema.ts` and `builder.ts` already do.
- **The format.** The stack (which begins with `Name: message`), then the error's own
  fields in their order (`name` is left out: the stack has it), each through Node's
  `inspect` one level deeper, then the cause:

  ```text
  ConstraintError: constraint.violated: The database rejected the write: … See https://…
      at … {
    id: 'constraint.violated',
    code: 'constraint',
    type: 'unique',
    constraint: 'accounts_token_hash_key',
    table: 'accounts',
    column: 'token_hash',
    detail: (hidden: read error.detail),
    sql: 'insert into "accounts" ("token_hash") values ($1)',
    [cause]: error 23505 (hidden: read error.cause)
  }
  ```

  - `detail` is shown as `(hidden: read error.detail)` when it is set, `undefined` when not.
  - The cause is one line, the whole chain joined by ` <- `, at most eight links (a cycle
    stops there): an Egon error by its name and identifier, any other error by its name
    and its `code` when that is a string or a number (a SQLSTATE `23505`, `ER_DUP_ENTRY`,
    `SQLITE_CONSTRAINT_UNIQUE`), anything else by its `typeof`. No message text from any
    link: an Egon error's message is safe, but showing names only keeps the line short.
    Example: `[cause]: QueryError query.unsupportedFeature <- DatabaseError database.rejected <- error 23505 (hidden: read error.cause)`.
  - Other fields keep their own inspect: a changeset on `InvalidChangesetError`, a
    `RollbackError`'s `reason` (an Egon error inside it uses this inspect too, rows and
    changesets redact), and colours pass through.
  - Without Node's `inspect` argument (a runtime that calls the method bare) values are
    shown with `String()`.
- **The properties are unchanged.** `error.detail` and `error.cause` hold the raw text,
  own properties as before, and `toJSON()` is still `{ name, code, id }` (tests below).
- **Docs.** `SECURITY.md` (the Secrets row: what inspect now hides, that the properties
  still hold the text, and the uncaught-error printer), `docs/site/reference/errors.md`
  ("What errors contain": inspect is safe, an example, the properties still raw),
  `docs/site/guide/edge.md` (the `EgonError` only row of the size table).
- **Changeset** `.changeset/inspect-errors.md`, `egon-orm` patch (the fixed group bumps all
  six). Patch because nothing is removed or changed in a signature: only what inspect
  prints changes, and one method is added.

## Which print paths go through it (verified, Node 22.23.4 and 22.12.0)

| Path | Uses the custom inspect | Evidence |
|---|---|---|
| `util.inspect(error)`, any options, incl. `showHidden: true`, infinite depth | yes | `errors.test.ts` "inspect output" |
| `console.log` / `console.error` | yes | `errors.test.ts` (a `Console` on a stream), and `test/security/inspect.test.ts` in a real Node process |
| `util.format("%o" / "%O" / "%s")`, `util.format(error)` | yes | `errors.test.ts`, every class |
| An error nested in an object (a query event's `error`) | yes | unit test, and the three secrets itests |
| **Node's printer of an uncaught exception or an unhandled rejection** | **no** | `test/security/inspect.test.ts` |

**Node's uncaught-error printer cannot be covered by a custom inspect.** Node prints a
fatal error with `inspect(error, { customInspect: false })`, so it shows every own
enumerable field (`detail`) and `[cause]`, and the cause's own fields (pg's `detail`), as
before. I checked whether a different shape could hide them: a non-enumerable `detail`
hides it there, but Node prints `[cause]` whenever `'cause' in error` is true, even for a
prototype getter. The cause is pg's error, whose `message` and `detail` quote the value,
so the only way to keep that path clean is for `error.cause` not to be the driver's error,
which is the breaking change the brief rules out. The test pins the current behaviour (it
expects the value in the fatal print), so a change on either side shows. SECURITY.md and
the errors reference say to catch errors before the top level and log `message` or
`toJSON()`.

## Tests

- `packages/core/src/errors.test.ts`, "inspect output" (16 tests, plus one per class):
  the exact format of a `ConstraintError`; the properties still raw; an undefined
  `detail` and no cause; `DatabaseError`; a three-link chain with Egon identifiers; a cyclic
  chain cut at eight; causes that are a string (holding the secret), an object without a
  name, a number, `null`; a numeric code (MySQL's `errno` style); every class through
  `inspect`, `format('%o')`, `%O`, `%s`, `format(error)`, `showHidden` and nested in an
  event; `console.log` and `console.error`; nested values one level deeper and indented; no
  `inspect` argument; an error without a stack; `toJSON()` unchanged.
- `packages/core/test/security/inspect.test.ts` (3 tests): a child Node process (`--import
  tsx`, the source) whose `console.log` / `console.error` print no secret, and whose uncaught
  exception and unhandled rejection print it (pinned, as above).
- `packages/postgres/test/secrets.itest.ts`: the two pinned leaks flipped. The undeclared
  unique violation: `inspect` and the deep `shown()` of the error, of the failed statement's
  query event and of all events hold no secret, `detail` and `cause.detail` do, and the cause
  line is `error 23505`. The 22P02 conversion error: the cause's message holds the value,
  `shown(error)` does not, the cause line is `error 22P02`.
- `packages/mysql/test/secrets.itest.ts`: the pinned leak flipped the same way; cause line
  `Error ER_DUP_ENTRY`; events clean.
- `packages/sqlite/test/secrets.itest.ts` (new, one test): SQLite had no secrets test. Its
  duplicate-key message names the column, not the value, so this checks the format and the
  clean paths (`SqliteError SQLITE_CONSTRAINT_UNIQUE`), not a leak that existed.
- **Mutation check (verified):** with the method's key changed so Node no longer finds it,
  29 tests fail: 24 of the 28 new unit tests (the four that pass check what must not
  change, or compare two paths with each other: the raw properties, `toJSON()`, an undefined
  `detail` and no cause, `console.log` equal to `inspect`), the
  child-process `console` test, and all four integration tests above. The uncaught-printer pins pass either way, as they should.

## Edge and size (measured)

- No `node:util` import; `check-node-specifiers` and `check-pure-annotations` pass in
  `pnpm check`. The `edge worker` job, run locally (`pnpm --filter
  @egon-orm/example-edge-worker run check`, workerd via Miniflare against Postgres): all ten
  checks pass; bundle 581.5 KiB, 181.0 KiB gzip. That workerd's own `console.log` calls the
  custom inspect is **unverified** (the Worker test does not print an error).
- `node scripts/size-report.mjs`, before (main `a118ddf`) and after:

  | Bundle | before min / gzip | after min / gzip |
  |---|---:|---:|
  | reference app | 392.5 / 122.3 KB | 393.2 / 122.6 KB |
  | schemas only | 53.8 / 18.0 KB | 54.5 / 18.3 KB |
  | cast | 103.7 / 32.5 KB | 104.4 / 32.8 KB |
  | query only | 123.7 / 39.1 KB | 124.4 / 39.4 KB |
  | `EgonError` only | 0.8 / 0.5 KB | 1.6 / 0.9 KB (1,596 / 887 bytes) |

  About 0.7 KB minified and 0.3 KB gzip on every bundle. I shortened the code once
  (1,678 to 1,596 bytes for `EgonError` only); most of what is left is the two loops and
  their strings.

## Decisions

- **On the base class, not only the two classes the audit named.** See above; it is also the
  only way to cover `MigrationError` and a `QueryError` wrapping a driver error.
- **`detail` and the cause are named, not dropped.** `(hidden: read error.detail)` tells a
  developer the text exists and where it is, without showing it. The audit's option 1
  suggested `cause: pg error 23505, on error.cause`; this is the same idea in Node's
  `[cause]` position.
- **The stack keeps the message**: Egon messages never hold a value, so nothing is removed
  from them.

## Needs the owner's decision

- **Step 21a's box "Importing `EgonError` alone bundles to under 1 KB"** (ticked at 0.7 KB)
  is no longer true minified: 1.6 KB (0.9 KB gzip, under 1 KB). The box was a proof that the
  dist tree-shakes (it used to cost 187 KB), which still holds. The alternative that keeps it
  is a one-line method on each of the twelve concrete classes calling a shared function (the
  abstract base, which is all that import keeps, would have none): the same bytes in every
  real bundle, twelve entries in the API report, and a new class must remember to add it.
  Recommendation: keep it on the base class and read the 21a box as "under 1 KB gzip", or
  "under 2 KB". I did not edit 21a's files.
- **Node's uncaught-error printer** (above): accept and document (done), or make a breaking
  change so that `error.cause` is not the driver's error. Recommendation: accept.

## API report

`pnpm api:report` changed `api-report/egon-orm.api.md` and `api-report/egon-orm-migration.api.md`
by the same addition: `EgonError` has
`[INSPECT](depth: number | null, options: object, inspect?: (value: unknown, options: object) => string): string`
and the report lists the (unexported) `INSPECT` symbol, as it already does for the
changeset's and the query builder's. No export was added and no signature changed.
`pnpm api:check` passes after the update.

## Checks

- `pnpm check`: passes (**verified**).
- `pnpm api:check`: passes after `pnpm api:report` (**verified**).
- `pnpm test:integration --maxWorkers=2` with `EGON_TEST_TIER2=1` (**verified**): 1,794
  passed, 2 expected failures, 62 skipped, and two timeouts while a Stryker run of another
  worker held the load average at 50: `cli.itest.ts`'s `beforeAll` (240 s, it builds three
  packages) and one test of `compiler/advanced/advanced.itest.ts` (30 s). Neither touches
  inspect output. Both files re-run alone: 62 of 62 passed.

## Requests

- **docs/site/guide/edge.md**: the other rows of the size table were already behind before
  this change (386 KB documented, 392.5 KB measured on `main` for the reference app); I
  updated only the `EgonError` row, which this change moves. A refresh of the whole table
  belongs with step 19 or the next docs pass.
