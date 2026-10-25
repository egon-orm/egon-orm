# Upgrading

How to move from one version to the next when a release changes something you have to act
on: a renamed function, a changed default, a behaviour that now throws. Each section names
the versions, what changed, why, and what to change in your code. The
[Changelog](/reference/changelog) lists every release and links here.

This page also states what a version number promises (the versioning policy) and which
versions of Node.js, TypeScript, the databases and their drivers are supported.

## Versioning

All packages, `egon-orm` and every `@egon-orm/*` package, are released together and share
one version number. Use the same version of each; a `^` range on all of them does that.

The versions follow [semantic versioning](https://semver.org). Before 1.0 the minor number
plays the part of the major one:

| Release | Before 1.0 (`0.y.z`) | From 1.0 (`x.y.z`) |
|---|---|---|
| Breaking change | minor: 0.1 to 0.2 | major: 1.x to 2.0 |
| New feature, backwards compatible | patch | minor |
| Bug fix | patch | patch |

So `^0.1.0` takes every 0.1.x release, features included, and never 0.2. Every breaking
change has a section on this page.

### What counts as breaking

The public API is what the entry points export (`egon-orm`, `egon-orm/migration`,
`egon-orm/testing`, `egon-orm/messages` and each `@egon-orm/*` package), as listed in the
[index of exports](/reference/exports). Anything reached another way (a file inside `dist/`,
a property that is not documented) can change in any release.

Breaking, at run time:

- removing or renaming an export, a method, an option or an error class;
- changing what a call returns or throws for the same input, or a default;
- changing the SQL that a query emits so that it returns different rows;
- changing an error's `code` or `id`, or the shape of `toJSON()` of a row, a changeset or
  an error;
- dropping support for a Node.js, TypeScript, database or driver version that this page
  lists as supported.

Breaking, in the types (a project that compiled with the earlier version stops compiling):

- removing or renaming an exported type, or one of its members;
- making a parameter required, or narrowing what a parameter accepts;
- widening what a function returns (a `string` that becomes `string | null`), or adding a
  member to a union you are expected to handle in a `switch`;
- adding a required member to an interface you implement (an adapter, a field type);
- inferring a different row, `select` or preload type for the same code.

Not breaking:

- new exports, new optional options and parameters, new members of interfaces that only
  the library implements;
- a type that becomes more precise without rejecting a program that was correct at run
  time (an inferred `string` that becomes the literal union of an enum's values);
- different wording of an error message: match on `code` and `id`, never on `message`;
- the formatting of the SQL text (whitespace, quoting, the order of bound parameters).

### Deprecations

Before 1.0, a breaking change may land in the next minor release without a deprecation
period; its section here says what to change. From 1.0, a removal is announced first: the
API keeps working, marked `@deprecated` in its TSDoc, for at least one minor release before
the next major removes it.

### Security fixes

A security fix ships in a patch release of the latest minor line (before 1.0, the latest
`0.y`), so `^` ranges pick it up. There are no backports before 1.0: earlier `0.y` lines
get no fixes. From 1.0, the previous major also gets security fixes for six months after
the next major is released. (Both are owner decisions of 2026-10-22.) How to report a
vulnerability is in
[SECURITY.md](https://github.com/egon-orm/egon-orm/blob/main/SECURITY.md).

## Supported versions

| | Supported | Tested in CI |
|---|---|---|
| Node.js | 22.12 or later (22 LTS and 24 LTS) | 22.12.0 (the consumer checks), the latest 22 and the latest 24 |
| TypeScript | 5.8 or later (owner decision, 2026-10-22) | the newest 5.8.x, the latest release and 6.0 (the workspace's version), with the consumer checks |
| Module formats | ES modules; CommonJS through `require()` of the ES modules (Node.js 22.12 or later) | both, from installed packages |
| TypeScript `moduleResolution` | `nodenext`, `node16`, `bundler` | all three, and a CommonJS file under `nodenext` |
| PostgreSQL | 14 or later | 14 (the floor) and 16 |
| SQLite | 3.39 or later (the one `better-sqlite3` bundles) | the bundled one |
| MySQL | 8.0.31 or later | 8.0.31 (the floor) and 8.4 |

The drivers are peer dependencies, installed by you:

| Package | Peer | Supported range | Tested in CI |
|---|---|---|---|
| `@egon-orm/postgres` | `pg` | `^8.21.0` | 8.21.0 and the newest 8.x |
| | `pg-cursor` (optional, for `repo.stream`) | `^2.12.0` | 2.12.0 and the newest 2.x |
| | `@types/pg` (optional, for TypeScript) | `^8.21.0` | 8.21.0 and the newest 8.x |
| `@egon-orm/sqlite` | `better-sqlite3` | `^12.4.1 \|\| ^13.0.0` | 12.4.1 and the newest 13.x |
| `@egon-orm/mysql` | `mysql2` | `^3.11.0` | 3.11.0 and the newest 3.x |
| `@egon-orm/zod` | `zod` | `^4.6.6` | 4.6.6 and the newest 4.x |

TypeScript 5.8 is the minimum for ES module and CommonJS projects alike: it is the first
release that types a `require()` of an ES module, which a CommonJS project does.

`better-sqlite3` 13 needs Node-API 10, which Node.js 22.14 and later have; on 22.12 and
22.13 use `better-sqlite3` 12 (the adapter says so instead of crashing).

Each package states its Node.js range in `engines` and its drivers as peer ranges, so a
package manager warns about a combination outside them. A Node.js, database or driver
version stays supported until its own end of life at least (for the databases, an owner
decision of 2026-10-22); dropping one is a breaking change (above).

## 0.1.0

The first release. If you used the packages from this repository before it, three things
changed that compile or behave differently.

### Error constructors take an identifier first

Every error has a stable identifier, `error.id` (such as `database.connectionFailed`), and
its message starts with it: `<id>: <what failed> See <link>`. The explanation and the fix
are in the [error reference](/reference/errors), or in the message itself during
development with `useFullErrorMessages(messages)` from `egon-orm/messages`.

The constructors of the errors that take a message now take the identifier before it:

| Before | From 0.1.0 |
|---|---|
| `new DatabaseError(message, details)` | `new DatabaseError(id, message, details)` |
| `new MigrationError(message, details)` | `new MigrationError(id, message, details)` |
| `new QueryError(message, cause)` | `new QueryError(id, message, { cause })` |
| `new CastError(message, cause)` | `new CastError(id, message, { cause })` |
| `new SchemaDefinitionError(message, cause)` | `new SchemaDefinitionError(id, message, { cause })` |

`QueryError`, `CastError` and `SchemaDefinitionError` used to take the underlying error as
their second argument. Now the second argument is the message, and the underlying error
moves into the details object, as `{ cause }`. The same holds for a class of your own that
extends `EgonError`: its `super(message, cause)` becomes `super(id, message, { cause })`.

`ConstraintError` and `RollbackError` keep their one `details` argument, which takes
optional `id`, `message` and `params`.

This matters to code that builds these errors itself, such as a custom adapter or a test
double. In TypeScript the old call no longer compiles; in JavaScript it runs and gives a
wrong message, because the sentence is read as the identifier. There is no namespace for
identifiers of your own: pass the one of ours that fits, for an adapter usually
`database.rejected` or `database.connectionFailed`:

<<< @/examples/upgrading.ts#adapter-error

Code that only catches errors needs no change. Test them by class and `code`, or by `id`,
not by the message text, which is shorter now.

### Messages are short by default

A message no longer includes the advice it used to end with. During development, turn the
full text back on once, at start-up:

<<< @/examples/errors.ts#full-messages

The `egon` command prints full messages.

### Removed and renamed exports

A few names that were exported before 0.1.0 are gone or renamed (owner decisions,
2026-10-22 and 2026-10-24). Nothing replaces the removed functions: the adapters call them for you.

| Before | From 0.1.0 |
|---|---|
| `normalizePgError` from `@egon-orm/postgres` | Not exported. |
| `normalizeSqliteError` from `@egon-orm/sqlite` | Not exported. |
| `normalizeMysqlError` from `@egon-orm/mysql` | Not exported. |
| `ConstraintOptions` from `egon-orm/migration` (the options of `m.createConstraint`) | `CreateConstraintOptions`. The `ConstraintOptions` of `egon-orm`, a changeset's constraint options, is unchanged. |
| `ErrorMessagesOf` from `egon-orm` (the type of `errorMessages()`) | `ErrorMessages`. |
| `plan()`, `named` and `query` of a `PreparedQuery`; `operations` of the migration builder; the protected `context` and `added` of the migration builders | Not in the published declarations. They were for the library's own use. |

`createAdapter` stays exported, but it is internal to the Egon packages: its driver
contract is not exported, and it may change in any release.
