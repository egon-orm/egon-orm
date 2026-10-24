# Changesets

A changeset describes a change to one record before anything is written: which values
were accepted, what changed, what is wrong, and which database constraints to watch for.
It is immutable and synchronous, and it never touches the database.

<<< @/examples/changesets.ts#overview

## Why changesets

Most ORMs validate a model object: you assign properties, then ask whether the object is
valid. A changeset keeps three things apart instead:

- the **data**: the row as it is in the database (or nothing, for a new record);
- the **input**: the params a request sent, filtered to the fields you permit;
- the **changes**: the values that differ from the data, after conversion.

Validation looks at the changes, so an update is not rejected because of an old value it
did not touch, and different forms on the same table (sign-up, profile, admin) are
different functions that permit different fields. Nothing is mutated: each method
returns a new changeset, and the row you started from is never modified.

## Creating a changeset

| Function | For | Notes |
|---|---|---|
| `cast(target, params, permitted, opts?)` | Untrusted input | Keeps only the permitted keys and converts each value to the field's type. |
| `change(target, values?)` | Trusted values | Typed; no conversion. |

`target` is one of:

- **a schema class**, for a new record: `cast(User, params, [...])`;
- **a loaded row**, for an update: `cast(user, params, [...])`;
- **a changeset**, to add more input to it;
- **`{ data, types }`**, for a changeset with no schema (see [Without a schema](#without-a-schema)).

A changeset function is usually a static method that accepts both:

<<< @/examples/changesets.ts#schema

<<< @/examples/changesets.ts#changeset-function

### Several changesets for one schema

One changeset function is enough while every form on a table permits the same fields.
When they differ, write one function per way the record changes, named after it: sign-up,
profile, email change, admin. The list of permitted fields is what keeps a profile form
from setting `role` or `passwordHash`, so each function permits only what its form may
set. Rules that several of them need go in a shared step, applied with
[`pipe`](#working-with-changes).

<<< @/examples/changesets.ts#several-changesets

Each caller picks the function for its form:

<<< @/examples/changesets.ts#several-changesets-use

They can just as well be static methods on the schema class, like `User.changeset` above.

### What `cast` does

<<< @/examples/changesets.ts#cast

- `params` must be a plain object, `null` or `undefined`. Anything else throws `CastError`.
- Keys that are not in `permitted` are ignored. This is the protection against a request
  setting fields it should not. Only the object's own keys are read, never inherited ones.
- Each value is converted by the field's type (`"42"` becomes `42`). A value the type
  rejects adds the error `is invalid` and records no change.
- Empty strings become `null` (`emptyValues`, default `[""]`). A key whose value is
  `undefined` counts as absent.
- A value equal to the current one is not a change (`forceChanges: true` records it
  anyway). For a new record, "current" is the field's default.
- `permitted` is type-checked; an unknown field name throws. An association or an embed
  cannot be cast this way: use `castAssoc` and `castEmbed`.
- A name listed twice counts once, here and in the lists given to `validateRequired`,
  `uniqueConstraint` and `validateUniqueAsync`: it gives one error at most.
- Casting a changeset again merges the new params and changes into it and keeps its
  errors.

`change` records trusted values the same way, without conversion: a value equal to the
current one is still not a change, and a key whose value is `undefined` is skipped.

### Required fields

Fields are non-null by default, and the changeset enforces that:

- Setting a non-nullable field to `null` adds `can't be blank` and records no change. A
  changeset therefore never holds `null` for a non-nullable field, and its `changes` are
  typed that way: `email?: string`, `name?: string | null`.
- A required field with no value at all is reported by `repo.insert` with the same error,
  before any SQL runs. It is not an error earlier, because you may still set it with
  `putChange`.

<<< @/examples/changesets.ts#required

`validateRequired` is for stricter rules: it also rejects whitespace-only strings, and
works on nullable fields.

## Validations

Each validation runs only when its field has a change (a change to `null` is not
validated). The exceptions are `validateRequired`, which also checks the existing data,
and `validateAcceptance`, which checks the params whatever changed. A validation adds
nothing to a field (or key) that already has an error, so each field shows one message,
the first failure: `validateLength("name", { min: 2 })` followed by
`validateFormat("name", ...)` reports only the length.

<<< @/examples/changesets.ts#validations

| Method | Default message |
|---|---|
| `validateRequired(fields?, opts?)` | `can't be blank` |
| `validateFormat(field, regex)` | `has invalid format` |
| `validateInclusion(field, values)` | `is invalid` |
| `validateExclusion(field, values)` | `is reserved` |
| `validateSubset(field, values)` | `has an invalid entry` |
| `validateLength(field, { is?, min?, max?, count? })` | see below |
| `validateNumber(field, { lessThan?, greaterThan?, lessThanOrEqualTo?, greaterThanOrEqualTo?, equalTo?, notEqualTo? })` | see below |
| `validateConfirmation(field, opts?)` | `does not match confirmation` |
| `validateAcceptance(key)` | `must be accepted` |
| `validateChange(field, fn)` | whatever `fn` returns |

- `validateRequired` checks the changes **and** the existing data (a new record's
  defaults count). It skips a field that already has an error, and removes the change of
  a field it finds missing. With no field list it checks every stored field that is not
  nullable and has no default, generator or database-generated value. `trim: false`
  counts only `""` as blank.
- `validateFormat` takes a regular expression; a global or sticky one is safe to reuse.
- `validateInclusion` and `validateExclusion` compare with the field's type, so dates
  compare by time.
- `validateLength` counts grapheme clusters for strings, what a reader sees as one
  character (`count: "codepoints"` or `"bytes"` changes that), and items for arrays.
  `is` is checked first, then `min`, then `max`, and at most one error is added:

  | | String | `count: "bytes"` | Array |
  |---|---|---|---|
  | `is` | `should be {count} character(s)` | `should be {count} byte(s)` | `should have {count} item(s)` |
  | `min` | `should be at least {count} character(s)` | `should be at least {count} byte(s)` | `should have at least {count} item(s)` |
  | `max` | `should be at most {count} character(s)` | `should be at most {count} byte(s)` | `should have at most {count} item(s)` |

- `validateNumber` checks its options in the order you write them and reports the first
  that fails: `must be less than {number}`, `must be greater than {number}`,
  `must be less than or equal to {number}`, `must be greater than or equal to {number}`,
  `must be equal to {number}`, `must be not equal to {number}`. It works on `number` and
  `bigint` fields. Like `validateLength`, it throws when given no limit.
- `validateConfirmation("password")` casts `passwordConfirmation` from the params with
  the field's type and compares it with the change of `password` (so the same input typed
  twice always matches), and puts the error on `passwordConfirmation`. A missing confirmation is an error only
  with `{ required: true }`. Like the other validations it runs only when the field has a
  change, so a form that leaves the password alone is not asked to confirm it. It reads
  the params, so it does nothing on a changeset made with `change`.
- `validateAcceptance("termsOfService")` passes when the params hold `true`, `"true"`,
  `1` or `"1"` under that key. The key need not be a field. It does nothing on a
  changeset made with `change` (there are no params).

For Zod and other schema validators, see [Validation](/guide/validation).

### Custom validations

<<< @/examples/changesets.ts#custom-validation

- `validateChange(field, (value, field) => ...)` returns a message, an error object
  (`{ message, validation?, meta? }`), an array of either, or nothing. It is called with
  the changed value, never with `null`, and is not called at all for a field that
  already has an error.
- Every validation takes `{ message }`: a string, or a function that receives the error's
  `meta` and returns the message.
- For a step you reuse across changeset functions, write a function of a changeset and
  apply it with [`pipe`](#working-with-changes).

## Errors

<<< @/examples/shapes.ts#changeset-error

<<< @/examples/changesets.ts#error-shape

- `cs.errors` holds the raw errors per field, oldest first.
- `cs.errorMessages()` returns `{ field: string[] }` with placeholders filled in. It is
  typed by the schema: one optional key per field and association (an association or
  embed holds the nested tree), `$base`, and the keys validations add, such as
  `passwordConfirmation` from `validateConfirmation` or a key given to `addError`. A
  misspelt key does not compile. The changeset a write gives back keeps those keys.
  They are collected along a chain of calls: for a changeset that is reassigned
  (`cs = cs.addError(…)`) or picked by a branch (`ok ? cs : cs.addError(…)`), declare the
  keys in its type, `Changeset<typeof User, true, "captcha">`.
  Name the type with `ErrorMessagesOf<typeof cs>`, or `ErrorMessagesOf<ReturnType<typeof User.changeset>>`
  (`ReturnType<typeof cs.errorMessages>` gives the untyped tree).
- `traverseErrors(cs, fn)` lets you format each error yourself (translation, plurals) and
  descends into [nested changesets](/guide/nested-changesets).
- `cs.addError(key, message, meta?)` adds one by hand. The key may be a field or another
  name, such as `$base` for the record as a whole.

The message and its values are kept apart until you render them, which is what makes
translation and plurals possible: look the template up in your catalogue, then fill it
from `meta`.

<<< @/examples/changesets.ts#traverse-errors

Errors are plain, serialisable objects. The errors the built-in validations and casts
produce never contain a field's value: their `meta` holds the rule, such as
`{ count: 2 }`, not the input. Errors you add yourself (`addError`, `validateChange`, a
custom type's failure `meta`) hold what you put in them, so keep the values of redacted
fields out of those.

## Working with changes

| Method | Effect |
|---|---|
| `putChange(field, value)` | Set a change. A value equal to the current one is not a change, and putting the current value back removes the change. |
| `forceChange(field, value)` | Set a change even if equal. |
| `deleteChange(field)` | Remove a change. |
| `updateChange(field, fn)` | Transform an existing change; nothing happens without one. |
| `merge(other)` | Combine two changesets of the same record. The other's changes win; errors, validations and constraints are joined. |
| `pipe(fn)` | Apply `fn(cs)`; for your own reusable steps. |

`putChange`, `forceChange` and `updateChange` take `null` for "no value"; `undefined` is
refused (use `deleteChange` to remove a change).

| Read | Returns |
|---|---|
| `getField(field, fallback?)` | The change if there is one, else the current value, else the field's default. |
| `getChange(field, fallback?)` | The change, or `fallback` (`undefined` by default). |
| `fetchField(field)` | `{ from: "changes" \| "data"; value }`, or `undefined` when the field has no value. |
| `fetchChange(field)` | `{ value }` when the field has a change, else `undefined`. Tells a change to `null` apart from no change. |
| `fieldMissing(field)` | Whether the field has no value in the changes or the data. |
| `isChanged(field, { from?, to? })` | Whether the field has a change (from and to those values, when given). |
| `applyChanges()` | The data with the changes applied, without validating. |
| `applyAction(cs, action)` | A [result](/guide/repo#writing): the data with the changes applied if the changeset is valid, else the changeset with its `action` set. No database. |
| `applyActionOrThrow(cs, action)` | The data with the changes applied; an invalid changeset throws `InvalidChangesetError`, which carries it with its `action` set. No database. |

`applyChanges`, `applyAction` and `applyActionOrThrow` work on a changeset of a loaded row and on a changeset
[without a schema](#without-a-schema). They are not available on a new-record changeset:
a row that the database never returned cannot exist. Calling them there is a compile
error (and throws `QueryError` if reached anyway).

<<< @/examples/changesets.ts#apply

<<< @/examples/changesets.ts#pipe

## Constraints

Constraint declarations tell the repo how to report a database violation as a changeset
error. They are covered in [Constraints](/guide/constraints).

<<< @/examples/changesets.ts#constraints

`uniqueConstraint`, `foreignKeyConstraint`, `assocConstraint`, `noAssocConstraint`,
`checkConstraint` and `exclusionConstraint` only record what to expect; the declarations
are in `cs.constraints`.

## Hooks for the repo

- `optimisticLock("lockVersion")` makes an update fail if the row changed since it was
  read, and increments the field on update. An update with no other change runs no query
  and leaves the field alone.
- `prepareChanges(fn)` runs `fn` just before the write, inside its transaction.
- `validateUniqueAsync(fields, repo)` checks the database for an existing row. It returns
  a promise, is subject to races, and is only a convenience for early feedback: always
  pair it with `uniqueConstraint`.

<<< @/examples/changesets.ts#lock

## Without a schema

A changeset can validate input that has no table, such as a search form. The types are
field builders, with their modifiers: `t.integer().default(1)` gives `page` the value 1
when the input has none, and fields are non-null unless `.nullable()`. `.autogenerate()`
and `.dbGenerated()` mean nothing without a table and are refused.

<<< @/examples/changesets.ts#schemaless

## Inspecting

`console.log(cs)` prints `Changeset<User> { action, changes, errors, valid }` with
redacted fields hidden; `JSON.stringify(cs)` leaves them out. Neither shows the params or
the data. `cs.validations` lists the validations that ran, as `[field, descriptor]`
pairs such as `["name", { validation: "length", min: 2, max: 80 }]`, for tools that
generate forms.

::: tip Good to know
- **There is no constructor.** A new record is a changeset of the class:
  `cast(User, params, [...])` or `change(User, values)`. It becomes a row only when the
  repo inserts it.
- **Fields are non-null by default.** `null` on a field that is not `.nullable()` is an
  error as soon as it is set, not when the database rejects it.
- **Validation is not a write.** Validations run immediately and all of them report; the
  database's constraints are checked only when the repo writes, one per attempt.
- **Changesets are immutable.** Every method returns a new changeset; keep the one it
  returns.
:::

## See also

- [Validation](/guide/validation): Zod, other schema libraries and functions.
- [Constraints](/guide/constraints): database errors as field errors.
- [Nested changesets](/guide/nested-changesets)
- [Translating error messages](/recipes/translating-errors) and
  [Showing form errors](/recipes/form-errors).
