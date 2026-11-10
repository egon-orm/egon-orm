# Step 21 (security): Security review, status

Branch `step/21-security`, 2026-10-22, on `main` at `3709dd9`. Spec: `docs/plan/21-release.md`
§2 "Security review". This part owns `SECURITY.md`; the fixes it found are in the areas
they belong to, each with a test that fails without it.

## Summary

The review is complete. Eleven findings: four fixed (one Medium, three Low; F11 in review round 1), two that need the
owner's decision (one Medium, one Low), five informational and documented. None is an
injection: every site that writes SQL text was read and holds.

| # | Severity | Finding | State |
|---|---|---|---|
| F1 | Medium | The connection string and password were reachable by `util.inspect` (depth > 2) of a repo, an adapter or a transaction | **Fixed** |
| F2 | Low | `castAssoc` / `putAssoc` matched items to loaded children with one scan per item: quadratic in attacker-controlled input | **Fixed** |
| F3 | Low | `castAssoc` read an item's key through the prototype chain | **Fixed** |
| F4 | Medium | A redacted value can appear in `util.inspect` of an error (and of a query event holding it), through the database's own text: `ConstraintError.detail`, `error.cause` | **Fixed** for `util.inspect`, `console.log` and `util.format` (1.0 gate item 1, PR #81, `status/21-gate-inspect-errors.md`): every Egon error's custom inspect hides `detail` and shows the cause chain as names and codes. Not fixable: Node's printer of an uncaught error skips custom inspect; documented in SECURITY.md |
| F5 | Low | A changeset without a schema class has no `codegen` opt-out: its `validate()` tries `new Function` | **Owner's decision**; documented |
| F6 | Info | A self-recursive changeset function over a very deep embed ends in a stack overflow | Documented |
| F7 | Info | `cast()` on an existing changeset copies the params: linear in the number of keys sent | Documented |
| F8 | Info | `changeset.params` and `repo.toSql()` hold values unredacted | By design; documented |
| F9 | Info | Statements without parameters may be statement lists on Postgres and SQLite | By design; documented |
| F10 | Info | `pnpm audit` reports 27 advisories, all in development tools | Request below |
| F11 | Low | SQLite's constraint-message pattern was unanchored: quadratic on a message repeating its words | **Fixed** (review round 1) |

## 1. Injection

### The property test at 100,000 runs, on every dialect

`packages/core/src/compiler/property.test.ts` (step 10) ran on Postgres only. It now runs
every property on all three dialects (`describe.each` over `postgresDialect`, `mysqlDialect`,
`sqliteDialect`), with the dialect's quote character in the identifier checks, the
expanded-list and path-step forms of MySQL and SQLite where they differ, and one new
property: a JSON path key is one quoted member of the path text, or refused when it holds
`"` or `\` (`jsonPathStep`). `EGON_PROPERTY_RUNS=<n>` runs every property `n` times and
stretches the timeouts to match; CI leaves it unset, so CI's run counts are as before
(10,000 for the main injection property, 500 to 2,000 for the others).

Review round 1: the values and names are drawn from `hostileText`, which weights in the
characters that end or escape a quoted name or string in some dialect (`"`, `` ` ``, `'`,
`\`, `[`, `]`) and the starts of comments and placeholders. With plain binary strings a
name seldom held a quote, and dropping the doubling of MySQL's backtick passed 1 run in 3 at
the default counts; with `hostileText` that mutation fails 3 runs out of 3. The table below
is the first run, before this change. A second run at 100,000, with `hostileText`, passed
too: 19 of 19 in 134.8 s.

`EGON_PROPERTY_RUNS=100000 pnpm vitest run --project core:unit packages/core/src/compiler/property.test.ts`,
on 2026-10-22 (Node 22, this machine): **19 tests, 19 passed, 100,000 runs each, 108.8 s.**

| Property (each on postgres / mysql / sqlite) | Time at 100,000 runs |
|---|---|
| Arbitrary strings in 18 value positions are bound, never written | 15.6 s / 14.9 s / 16.0 s |
| Values in limit, offset, VALUES cells, fragment sources, insert cells are bound | 5.4 s / 5.5 s / 5.9 s |
| Names in every identifier position appear only quoted | 6.6 s / 7.8 s / 5.8 s |
| Names in a row-level write and a bulk update are quoted | 1.7 s / 1.8 s / 1.3 s |
| Names looked up in a table (operators, functions, aggregates, locks, join kinds, directions, nulls, set operations, idents, window names) are refused when unknown | 2.3 s / 1.8 s / 1.7 s |
| A plan compiled from values A and bound with B equals a cold compile of B | 4.6 s / 4.6 s / 4.6 s |
| A JSON path key cannot leave its step of the path text (dialect-independent) | 0.4 s |

### Every place SQL text is assembled

Read in full: `compiler/emit.ts`, `compiler/write.ts`, `compiler/compiler.ts`,
`compiler/dialect.ts`, `compiler/plan.ts`, `adapter/adapter.ts`, `migration/ddl.ts`,
`migration/dialect.ts`, `migration/builder.ts` (the checks DDL relies on),
`migration/migrator.ts`, `migration/database.ts`, the three dialect packages' `dialect.ts`,
`driver.ts` and `options.ts`, and the CLI. A grep for template literals holding SQL words
and an interpolation in every non-test source found nothing outside these.

| Site | What reaches the text | Verdict |
|---|---|---|
| Values in every clause (`emit.ts`: where, having, join conditions, select, order, group, limit, offset, VALUES sources, fragment arguments, `in` lists, `between`, `like`, `case`, `coalesce`, `concat`, array operators) | A placeholder (`$n` or `?`); the value goes into the bound parameters | Safe (property-tested) |
| Literal nodes (`literal()`) | Only `true`, `false`, `null` and finite numbers; anything else is refused | Safe |
| Identifiers: tables, aliases, columns, CTE names, VALUES and source column lists, `selectedAs` names, the `excluded` alias (`quoteIdentifier`) | Wrapped in the dialect's quote, the quote doubled inside | Safe (property-tested). A NUL in a name is passed through and refused by the server, not an injection |
| `fragment.ident()` and window names | Checked against `IDENTIFIER` (`^[A-Za-z_][A-Za-z0-9_$]*$`), then quoted | Safe |
| Operators, functions, aggregates, niladic functions, join kinds, directions, nulls order, set operations | Looked up in the dialect's tables as own properties only (`lookup`: `"constructor"` finds nothing); unknown names are refused | Safe (property-tested) |
| Lock clauses (`lockClause`) | A string clause must be in the dialect's `lockModes` and is replaced by the table's SQL; SQLite writes nothing for the clauses `lock()` makes and refuses others; a fragment lock is a fragment | Safe |
| Fragments (`fragment()`) | The template's literal strings are SQL; the tag refuses a call that is not a template literal (frozen strings with `raw`); every interpolation is an expression or a bound value; a placeholder is kept a token of its own (`$1` next to a word or `$`) | Safe for template text, which is program text |
| Casts and custom types (`sqlTypeName`, `typeSql`) | Names from the dialect's type table, or a custom `sql` that matches `CUSTOM_SQL_TYPE` (words, single spaces or dots, `(n)` or `(n, m)`, `[]`) | Safe |
| JSON paths | Postgres: the keys as one bound array. MySQL, SQLite: each key bound as one step of the path text, with `"` and `\` refused (`jsonPathStep`), so a key cannot address another member | Safe (property-tested) |
| Database schema names (`.schema()`, the repo option, `Schema()`'s third argument, `resolveTableSchema`) | Quoted as identifiers | Safe (property-tested) |
| Row-level writes (`write.ts`): insert, update, delete, upsert, insert from a query | Column names from schema metadata, quoted; values as placeholders; `{ constraint }` targets quoted; fragment targets compiled as fragments | Safe |
| `explain` options (`compileExplain`) | `analyze` must be a boolean and `format` `"text"` or `"json"`; the text written is fixed per dialect | Safe |
| Savepoints (`savepoint`, `rollbackTo`, `releaseSavepoint`) | The name must be a non-empty string without NUL, then quoted with the adapter's quote function | Safe |
| `begin` / `start transaction` | Isolation levels from a fixed map (unknown ones refused), `read only` / `deferrable` from booleans | Safe |
| Migration DDL (`ddl.ts`, `egon-orm/migration`) | Every table, column, index, constraint, schema and extension name quoted; type names from tables or `CUSTOM_SQL_TYPE`; precision and scale whole numbers (checked by the builder); reference actions and index methods from fixed sets; DDL fragments compiled and refused when they bind a value; `m.execute` binds its values | Safe |
| Migration defaults and `enumText` values (the dialect literal writers) | Postgres: `'…'` with quotes doubled, `E'…'` with backslashes doubled when there is one; MySQL: `'…'` for text without quote or backslash, a run with a backslash as `convert(X'…' using utf8mb4)`, a quote as `char(39 using utf8mb4)`; SQLite: quotes doubled. NUL and lone surrogates are refused before (`isLiteralText`); numbers must be finite, booleans are the dialect's keywords | Safe for a UTF-8 client encoding, which every driver sets; documented on `MigrationDialect.stringLiteral` and in SECURITY.md |
| The migrator's tracking table and lock (`migrator.ts`, `migration/dialect.ts`) | The table name quoted; versions and lock keys bound | Safe |
| `createDatabase` / `dropDatabase` | The name must be non-empty without NUL, then quoted | Safe |
| SQLite `pragmas` and `attach` (`sqlite/options.ts`, `driver.ts`) | Pragma names match `^[A-Za-z_][A-Za-z0-9_]*$`, values `^-?[A-Za-z0-9_.]+$`, a number or a boolean; an attached schema name matches the name pattern and is quoted, its file is bound | Safe |
| MySQL session and cancellation (`mysql/driver.ts`) | Fixed text; `kill query ?` binds the thread id; `multipleStatements: false` | Safe |
| Statement lists (F9) | Postgres (`pg`'s simple protocol, no values) and SQLite (`exec` when `prepare` reports several statements) run a parameterless text of several statements; this is what migrations and `repo.raw` scripts rely on. Only program text reaches SQL text, so it cannot be used to inject | By design |
| The CLI | Prints statements; assembles none | Safe |

## 2. Prototype pollution and mass assignment

`packages/core/test/security/hostile-params.test.ts` (16 tests):

- `__proto__`, `constructor` and `prototype` keys from `JSON.parse` are inert: no prototype
  changes, `Object.prototype` stays clean, merged params keep `__proto__` as an own key;
  a permitted name that is a prototype member is refused; a field cannot be named
  `__proto__`, `constructor` or `toJSON`.
- A property planted on `Object.prototype` is not a param, for `cast()` and (after F3) for
  a nested item's key. Params that are not plain objects (`Object.create(...)`, class
  instances, arrays) are refused with `CastError`.
- Only permitted fields change; associations and embeds need their own call. Getters: only
  permitted keys are read, each once, and a throwing getter's own error surfaces. Symbol
  keys are ignored; values with `valueOf`, `toString` or `Symbol.toPrimitive` are cast
  errors without any of them being called.
- Size, by counting work rather than timing it: a million keys behind a counting proxy, with
  two permitted, get two reads and no key enumeration; 5,000,000-digit numbers are refused
  by length; a 100,000-level JSON document is refused at 500 levels without a stack
  overflow; `castAssoc` of 8,000 items against 4,000 loaded children reads each child's key
  a bounded number of times (F2); `castEmbed` of 50,000 items keeps their order.
- `keyFinder` (F2's index) finds what the scan finds, by property test, for one key field,
  a composite key, `-0`, `NaN`, `null` keys and duplicate keys, and scans a key type with its
  own equality (a decimal `"3.50"` finds `"3.5"`).

The JSON output (`toJSON` of rows and changesets, step 21b) already writes a `__proto__`
key as an own property (`setOwn` in `schema/json.ts` and `internal/inspect.ts`), leaves
redacted fields out, and maps nested values with `jsonOf`; changeset error keys are field
names or `base`. `error.toJSON()` is `{ name, code, id }`. Both are covered by step 21b's
tests and by the secrets tests below.

**F2 (Low, fixed).** `castAssoc` (and `putAssoc` with plain objects) matched each item to
the loaded children with `indexOfKey`, a scan: with 10,000 loaded children and 20,000
items it took 1.2 s, growing with the product. The items come from the request. Fixed in
`changeset/nested/relation.ts` (`keyFinder`): where every key field compares with
`Object.is` (integers, bigints, strings, uuids), the loaded rows are indexed once in nested
`Map`s and each item is one lookup (the same case took 47 ms); other key types, `-0`
values and fewer than 16 rows keep the scan. Used by `castRelation` and `putRelation`.
Mutation-checked: with the scan put back, the key-read test fails (32 million reads).

**F3 (Low, fixed).** `keyOf` read an item's key with `item[field.name]`, so with a polluted
`Object.prototype.id` an item without an `id` matched the existing child of that id and
became an update instead of an insert. `cast()` already read own properties only. Fixed:
params items are read with `Object.hasOwn` (rows are read as before). Mutation-checked.

**F6 (Info).** A changeset function that calls `castEmbed` with itself for a
self-referential embed recurses once per level of the params: about 5,000 levels end in a
`RangeError` (stack overflow) within milliseconds, with nothing written. The recursion is
the application's; SECURITY.md tells applications to limit request size.

**F7 (Info).** `cast()` on an existing changeset merges the params (`{ ...base.params,
...params }`), linear in the keys sent: a million keys take about 1.2 s. A request body
limit bounds it.

## 3. ReDoS

Every regular expression in the published packages' sources (found with a grep for regex
literals, `RegExp`, `.test`, `.exec`, `.match`, `.replace(/` and `.split(/`) is tested with
input built to make a backtracking engine work hard: long runs of what a quantifier accepts,
ending in what the pattern refuses. Two kinds of check:

- **Growth** (`expectLinear`, in `@egon-orm/test-support`): the work is timed on an input
  of 50,000 characters and on one of 400,000 (the fastest of three runs each, after a warm
  up), and the larger must take less than 16 times the smaller plus 50 ms. Linear work grows
  8 times, quadratic 64 times, so this separates them whatever the machine's speed. Used for
  every pattern that is not anchored at the start, and for the one parse of unbounded text
  (decimals). Mutation-checked on the old SQLite pattern (F11): 81 ms at 50,000, 5.2 s at
  400,000, failed.
- **A one-second bound on 100,000 characters**, for anchored patterns and length-checked
  input. It catches an exponential pattern and a costly quadratic one, but not every
  quadratic one: the old SQLite pattern took 296 ms there, inside the bound (review round 1).
  The float grammar without its length check takes about 6 s there, so its length check is
  caught.

- `packages/core/test/security/redos.test.ts`: integer, bigint, float, decimal, uuid,
  date, time, timestamp and local-timestamp casts; a bigint read from an embedded document;
  `IDENTIFIER` and `fragment.ident`; `CUSTOM_SQL_TYPE`; `isLiteralText` (lone surrogates);
  migration file names; message placeholders; `validateRequired` with `trim`.
- `packages/postgres/src/redos.test.ts` (timestamp text, SQLSTATE codes, connection
  messages), `packages/mysql/src/redos.test.ts` (datetime text; the duplicate-key, foreign
  key, check and column patterns, with a quoted value that holds the pattern's own words),
  `packages/sqlite/src/redos.test.ts` (timestamp text, which SQLite stores as any text; the
  constraint patterns; pragma names and values), `packages/cli/src/redos.test.ts`
  (migration names). The MySQL and SQLite files use `expectLinear` throughout.

**F11 (Low, fixed in review round 1).** SQLite's `COLUMNS_FAILED`
(`/constraint failed: (.+)$/`) was not anchored: on a message that repeats `constraint
failed: ` and ends in a line break, it was tried at each repetition and read to the end
each time, quadratic (18 ms at 25,000 characters, 73 ms at 50,000, 296 ms at 100,000). The
message comes from SQLite, and can quote a user's value (`CHECK constraint failed:` an
expression). `COLUMNS_FAILED` and `INDEX_FAILED` are now anchored at the constraint's kind
that starts every such message (`^[A-Z]+(?: [A-Z]+)* constraint failed: …`), so each is
tried once; the SQLite conformance suites still read the real messages.

Verdicts: the only ambiguous pattern is the float grammar (`\d+\.?\d*`), which runs only
on text of at most 400 characters; integer and bigint text is limited to 40, time to 15,
timestamps to 64, uuids to 36. The other patterns have no overlapping quantifiers. Most are
anchored at the start; the ones that are not are MySQL's constraint patterns
(`DUPLICATE_KEY`, `FOREIGN_KEY`), where each try stops at the next quote or backtick so the
tries together read the message once (checked with `expectLinear`). Patterns not reachable with outside input, and quadratic at worst on
text bounded elsewhere, were read and not given a test: MySQL's `ROWS_MATCHED` (the
server's info line) and `UPDATE` (our SQL), the `/0+$/` that trims a MySQL decimal (at most
65 digits), the error-path tidy-up in `preload()` (program text), the CLI's path and number
checks. `validateFormat` runs the application's own pattern (SECURITY.md says so).

## 4. Secrets

`packages/postgres/test/secrets.itest.ts` (12 tests) and `packages/mysql/test/secrets.itest.ts`
(3 tests, tier 2), against real servers, with a repo created with `log: { params: true }`,
its `query` listener, and an adapter listener with `{ params: true }`:

- A redacted value, through insert, the comparisons, `in`, `like`, `updateAll` with `.set`,
  update, `insertAll`, upsert, a transaction and a savepoint: in no log line (which shows
  `**redacted**`), no event, no inspect output of rows, changesets or transactions, no
  `toJSON`.
- An invalid changeset's `InvalidChangesetError`: message, inspect and JSON clean. A
  declared unique constraint gives `has already been taken`, without the value.
- An undeclared unique violation (`ConstraintError`) and a value the database cannot
  convert (`DatabaseError`, 22P02): message, JSON and log line clean; `detail` and
  `inspect(error)` hold the value (F4, pinned by the test).
- The password, in a connection string that is unreachable, has a bad port, does not parse,
  has an unknown `sslmode` or a host that does not resolve: in no error message, stack,
  JSON, log line or inspect output of the repo and adapter; a wrong password is not echoed;
  a connected repo, adapter and transaction (by connection string and by `password`) do not
  show it. MySQL the same.
- `packages/cli/src/secrets.test.ts`: `egon migrate` and `egon migrations`, as text and
  `--json`, report an adapter failure by the Egon error's message and leave the driver's
  cause (which held a connection string) out.

**F1 (Medium, fixed).** The adapter kept the started driver wrapper, and a checked-out
connection kept the driver's connection, in TypeScript `private` fields, which are ordinary
enumerable properties at run time. The `pg` driver wrapper holds the pool's configuration,
so `util.inspect(repo, { depth: 5 })` (or any logger or crash reporter that walks objects
deeply) printed `connectionString: 'postgres://egon:<password>@…'`; at Node's default depth
of 2 it did not. Fixed in `adapter/adapter.ts`: `SharedAdapter`'s driver and
`SharedConnection`'s driver and connection are ES private fields (`#driver`,
`#connection`), which neither `util.inspect` (even with `showHidden`) nor `JSON.stringify`
reaches. This covers all three adapters, which store their configuration behind these
objects. Mutation-checked: with `adapter.ts` from `main`, the six password tests fail.
A visible consequence: calling an adapter's (or a connection's) methods through a `Proxy`
of it, or on `Object.create(adapter)`, now throws `TypeError`, since an ES private field is
reachable only from the object itself. Nothing in the library or its tests does that.

**F4 (Medium, needs the owner's decision).** Egon's messages, `toJSON()`, log lines and
the JSON of query events never hold a value. The database's own text does: Postgres puts
`Key (token_hash)=(<value>) already exists.` in the `detail` of a unique violation (copied
to `ConstraintError.detail`) and quotes a value it cannot convert in its message; MySQL's
duplicate-key message quotes the value; both drivers' errors are kept as `error.cause`.
`console.log(error)` or `util.inspect(error)` prints `detail` and the cause, and a query
event of a failed statement holds the error, so a listener that inspects events prints them
too. For a redacted unique column (a token hash, an API key) that shows the redacted value.
Options:

1. Give `ConstraintError` and `DatabaseError` a custom inspect that leaves out `detail` and
   shows the cause as one line (`cause: pg error 23505, on error.cause`); the properties stay
   readable. Small, no signature change, but it changes what `console.log(error)` shows
   everyone, and hides useful text when nothing is redacted.
2. Leave `detail` out (and wrap the cause) only when the violated constraint's columns
   include a redacted field: the repo knows the schema of a write, but not reliably the
   columns of a constraint named by the database.
3. Keep it as it is, documented (done: SECURITY.md says to log errors by `message` or
   `toJSON()`).

Recommendation: 3 for `0.1.0` (it is documented and the safe paths are the default ones),
and 1 before `1.0`.

**F8 (Info).** `changeset.params` (the params as given) and `repo.toSql()` (the parameters
one execution would send, documented as a debugging tool) hold redacted values. By design;
SECURITY.md says so.

## 5. `new Function`

Documented in SECURITY.md (what is generated, the opt-out, the runtime fallback).

The generators: `generateMaker` (`schema/schema.ts`), `generatedBuilders`
(`changeset/validators/generated.ts`) and `generateDecoder` (`repo/hydrate.ts`), all through
`generateFunction` (`internal/codegen.ts`, the only `new Function`). Read in full: every
name (field names, association names, select keys, column aliases) goes into the source as
`JSON.stringify(name)`, which is a valid, closed string literal for any string (quotes,
backslashes, line terminators and lone surrogates are escaped); everything else is a
counter the generator made (`v0`, `f1`, `c2`, `k[3]`, `values[4]`). No value from a row or
from params is ever in the source; the generated functions take them as arguments. Object
keys are written as computed keys (`["__proto__"]: …`), so `__proto__` is an own property.

`packages/core/test/security/codegen.test.ts` (5 tests):

- An application with `codegen: false` on its schemas, its embedded schema and its repo
  defines schemas, casts, uses `castEmbed`, validates, reads, preloads, reads a join with a
  whole row in the select and inserts with a returned row, with **zero** `new Function`
  calls (a counting `Function` stub). The same application with the option on does
  generate, so the count is meaningful.
- Field names and select keys from fast-check, plus hand-made breakouts (`"]; …; //`,
  quotes, backticks with a placeholder, a backslash before a quote, U+2028, a comment end,
  a lone surrogate): the row factory, `validate()` and the decoder keep every name as a key
  and run none of them.
- The runtime fallback of step 21a (an `EvalError` from a refusing runtime) is covered by
  `internal/codegen.test.ts`: every generated path falls back and returns the same results,
  and a refusal is not retried.

**F5 (Low, needs the owner's decision).** A changeset without a schema class
(`cast({ data, types }, …)`) has no `codegen` option, so its first `validate()` tries
`new Function` even in an application that turned code generation off everywhere else. It
falls back correctly, but a strict Content Security Policy reports the attempt (a CSP
report endpoint sees one violation per field table). The TSDoc of `generatedBuilders`
already says so; the test pins it. Options: never generate for schemaless field tables (no
API change; their `validate()` is a little slower), or a process-wide switch
(`useCodegen(false)`, new API). Recommendation: the first.

## 6. Dependencies

- **Runtime dependencies:** none, in any published package. `egon-orm` has no
  `dependencies` (ADR 0003); the adapters, `@egon-orm/zod` and `@egon-orm/cli` declare only
  peer dependencies (`pg` and optional `pg-cursor`, `@types/pg`; `mysql2`; `better-sqlite3`;
  `zod`; `egon-orm`). A grep of every import in the packages' sources finds only those, Node
  built-ins and the packages' own entry points (`fast-check` is in tests only; `core`'s one
  `node:` import is a type).
- **Licences** of the peer dependency trees as installed (67 packages, walked from each
  peer's `dependencies` and `optionalDependencies`): MIT (52), ISC (8), Apache-2.0 (3:
  `detect-libc`, `long`, `tunnel-agent`), BSD-3-Clause (`ieee754`), `(MIT OR WTFPL)`
  (`expand-template`), `(BSD-2-Clause OR MIT OR Apache-2.0)` (`rc`). All permissive; nothing
  copyleft. The published packages are MIT.
- **Audit:** `pnpm audit --prod`: no known vulnerabilities. `pnpm audit` (everything): 27
  advisories (7 high, 15 moderate, 5 low), all in development tools: `vite` 5.4.21 under
  `vitepress` (docs site), `undici` 7.28.0 and `sharp` 0.35.2 under `miniflare`
  (`examples/edge-worker`), `esbuild` 0.21.5 and 0.27.7 under `vitepress`, `vitest` and
  `tsup` (dev-server and Windows advisories). None ships in a package (F10, Request below).
- **Lockfile integrity:** `pnpm install --frozen-lockfile` succeeds; all 842 packages in
  `pnpm-lock.yaml` resolve from the registry with an `integrity` hash, none from a tarball
  URL or git; `minimumReleaseAgeStrict: true` with no exclusions (`pnpm lint` checks it);
  install scripts are allowed for `better-sqlite3`, `esbuild` and `workerd` only.

## 7. SECURITY.md

Written: reporting through GitHub private vulnerability reporting on `egon-orm/egon-orm`
(with the direct link), what to include, and the threat model on one page (what is trusted,
what is not, and for each concern what Egon guarantees and what stays the application's
job). **The owner must enable private vulnerability reporting** in the repository settings
(Settings → Code security → Private vulnerability reporting); until then the link shows
nothing to reporters.

## Decisions

- Tests live in `packages/core/test/security/` (core), and beside the sources or in `test/`
  of the dialect packages and the CLI, named for the concern (`redos`, `secrets`).
- ReDoS tests check growth between two sizes (`expectLinear`) for unanchored patterns and
  unbounded input, and a one-second bound on 100,000 characters for the rest (§3). These are
  correctness checks, not benchmarks or speed gates (plan README §7): nothing is measured
  against a budget. The size tests of §2 count work instead of timing it.
- `EGON_PROPERTY_RUNS` is the name of the override; it applies to every property in
  `compiler/property.test.ts` only.
- F1 was fixed with ES private fields rather than a custom inspect on the adapter, so that
  `JSON.stringify` and debuggers that walk properties are covered too. One visible change
  follows from it: an adapter method called through a `Proxy` of the adapter, or on
  `Object.create(adapter)`, now throws `TypeError` (an ES private field is reachable only
  from the object itself). The same holds for a connection.

## Needs the owner's decision

- **F4 (Medium):** whether `ConstraintError` / `DatabaseError` should hide `detail` and the
  driver's cause from `util.inspect`. Recommendation: document for `0.1.0` (done), custom
  inspect before `1.0`.
- **F5 (Low):** whether schemaless changesets should stop generating code. Recommendation:
  yes, never generate for schemaless field tables.
- **Enable GitHub private vulnerability reporting** on `egon-orm/egon-orm`; SECURITY.md
  points to it.

## Gaps

- The 100,000-run property test was run once, locally (results above); CI runs the default
  counts.
- The MySQL secrets test ran locally with `EGON_TEST_TIER2=1`; it runs in CI only where tier
  2 is enabled.
- The CLI test checks the CLI's reporting with an adapter that fails as the real ones do; the
  real adapters' error messages are checked by the dialect packages' secrets tests. The
  built binary was not run against a failing server.
- SQLite has no password; its secrets were not tested beyond the ReDoS and error patterns.
- F4 and F5 are open.

## Requests

- **21-packaging / owner (F10):** bump the development dependencies the audit flags when
  releases old enough for `minimumReleaseAge` exist: `vitepress` (for `vite` ≥ 6.4.4),
  `wrangler` / `miniflare` (for `undici` ≥ 7.29.1, `sharp` ≥ 0.35.5), `tsup` and `vitest`
  (for `esbuild` ≥ 0.28.1). None ships in a package; none blocks `0.1.0`.
- **21-packaging:** link the support policy (which versions get security fixes) from
  `SECURITY.md` once it is written; SECURITY.md does not promise one yet.
- **21-audit:** the security verdict for the readiness report: ready, with F4 and F5 as
  documented caveats.
- **CONTRIBUTING.md** (not owned here): one line on `EGON_PROPERTY_RUNS` under "Tests"
  would help the next security review.
