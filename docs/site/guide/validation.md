# Validation

Besides the [built-in validations](/guide/changesets#validations), a changeset can be
validated by Zod, by any other [Standard Schema](https://standardschema.dev) library
(Valibot, ArkType, Yup), or by a plain function. The core package depends on none of
them: it talks to every library through the Standard Schema interface.

<<< @/examples/validation.ts#overview

Each method returns a new changeset, like every other changeset method. A validator that
finds problems adds errors; it never removes changes.

## Choosing

- **Built-in validations** (`validateRequired`, `validateLength`, …) for single-field
  rules with standard, translatable messages.
- **A Zod schema** (or Valibot, ArkType, Yup) when you already have one, when the same
  definition is shared with a client, or when `@egon-orm/zod` can derive it for you.
- **A function** for rules that need several fields, outside state, or a message of your
  own, without a library.

They mix freely: a changeset function can call `validateRequired`, then `validate` with a
schema, then `validate` with a function.

## With Zod

<<< @/examples/validation.ts#zod

Each issue becomes a changeset error on the field named by the first segment of its path,
with `validation: "schema"`. The rest of the path is kept in `meta.path` (`["theme"]` for
an issue at `settings.theme`). Path segments written as `{ key }` objects, as some
libraries report them, are unwrapped.

An issue with an empty path, or one whose path does not start with a field name, belongs
to the record as a whole: it is stored under the key `BASE` (`"$base"`), with its whole
path in `meta.path`.

<<< @/examples/validation.ts#base

Errors are appended after the errors the changeset already has, in the order the
validator reported them. A field that already has an error (from `cast`,
`validateRequired` or an earlier validation) gets no more: its issues are dropped, so each
field shows one message, the first failure. `cast(User, { email: "" }, ["email"])`
reports `can't be blank`, and a schema that then finds no email adds nothing to it. The
same holds for a field of a nested changeset. Issues on the record as a whole (`BASE`)
are always kept.

## Cross-field rules

A rule that compares fields reports on the field the user should fix:

<<< @/examples/validation.ts#cross-field-zod

## With a function

<<< @/examples/validation.ts#function

A function receives the values and a context, and returns a list of issues, or nothing:

<<< @/examples/shapes.ts#validator-fn

`path` is a field name, or a list whose first element is the field name. `meta` is
merged into the error's `meta`, so it can fill `{placeholders}` in the message.

Return an array, even for one issue: `[{ path: "email", message: "is taken" }]`. An empty
array and `undefined` (no `return`) mean no issues. Anything else is a bug in the
function, and `validate` throws a `TypeError` that says what it got: `null`, a single
issue without its array, a string, a number, any other object. With `validateAsync`, the same
holds for what the promise resolves to, and the promise rejects with the `TypeError`.
This includes a function typed as returning `void`, which TypeScript lets return a
value: `(v) => seen.push(v)` returns a number, so write `(v) => { seen.push(v); }`.

`ctx.data` is the record before the changes: the loaded row, or, for a new record, an
object of the field defaults (`undefined` for a field without one). It is never `null`.
A default given as a function is called once per validation, so `values` and `ctx.data`
hold the same default.

## What the validator receives

A plain object of **every field with the changes applied**: the loaded row (or a new
record's defaults), overlaid with the changes, in field order. The values are the
converted ones (`Date`, numbers, enum strings), as `cast` produced them. Virtual fields
are included, and so are redacted fields.

A field with no value (a new record's field that has neither a change nor a default) is
**left out** of the object, not set to `undefined`, so that a schema's optional keys
accept it and a required key reports it as missing.

## Options

| Option | Default | Effect |
|---|---|---|
| `scope` | `"all"` | `"all"` keeps every issue, except on a field that already has an error. `"changed"` keeps only issues on fields that have a change (and issues on the record as a whole). |
| `apply` | `false` | When `true` and the schema finds no issue, its output is written back as changes, so transforms such as `.trim()` take effect. Standard Schemas only; cannot be combined with `only` or `scope: "changed"`. |
| `only` | all fields | Gives the validator only these fields, and keeps only issues on them (and on the record as a whole). |

<<< @/examples/validation.ts#options

### Why `scope: "all"` is the default

A cross-field rule reports on one field, but is often broken by a change to another. In
the example above, moving `startsAt` past `endsAt` reports on `endsAt`, which did not
change. Keeping every issue makes sure that rule is never dropped.

Use `"changed"` when existing rows may hold data that would no longer pass a new rule,
and that old data should not block unrelated updates: a user editing their name is then
not told that the email they registered years ago is no longer accepted.

## Transforms with `apply`

<<< @/examples/validation.ts#apply

For each key of the schema's output that is a field, the value is first cast with the
field's type, as `cast` casts input. A value the type rejects (a transform that turned a
`string` field's value into a number) becomes a `cast` error on that field and is not
written. A value that differs from the field's current value (compared by the field's
type, so an equal `Date` is not a change) is recorded as a change, as `putChange` would
record it. Output keys that are not fields are ignored.

Nothing is applied when there are issues: a schema that reports an issue has no output.
For that reason `apply` cannot be combined with `only` or `scope: "changed"`, which drop
issues after the schema has run; that combination throws, rather than leaving a valid
changeset whose transform silently did not happen. To transform some fields only,
validate with a schema of just those fields. A function validator has no output, so
`apply` with a function throws too.

## One field: `validateField`

<<< @/examples/validation.ts#validate-field

`validateField` runs only when the field has a change, and not on a change to `null` or
on a field that already has an error (like the built-in validations). The validator
receives the changed value alone. Every issue goes on that field, its path in
`meta.path`. A function given to `validateField` returns an array of issues or nothing,
like one given to `validate`, and throws the same `TypeError` otherwise.

## Async validation

A changeset is synchronous: `validate` throws `validator returned a Promise; use
validateAsync` if the validator answers with a promise. Use `validateAsync` for a check
that has to wait, such as a call to another service, and await it:

<<< @/examples/validation.ts#async

Keeping the two apart means that the ordinary path never waits, and that an accidental
`async` function in a synchronous chain is an error you see at once, not a validation
that silently never ran. `validateAsync` accepts synchronous validators too.

A validator that throws is a bug in the validator: the exception propagates and is not
turned into a validation error.

## Other libraries

Any value with a Standard Schema `~standard` property works, whatever library made it.

**Valibot**

<<< @/examples/validation.ts#valibot

**ArkType**

<<< @/examples/validation.ts#arktype

**Yup** implements Standard Schema from version 1.7, but its `validate` always answers
with a promise, so its schemas go to `validateAsync`:

<<< @/examples/validation.ts#yup

To validate with Yup synchronously, wrap the schema in a function that calls
`validateSync` and returns issues. The same approach works for any library without
Standard Schema support:

<<< @/examples/validation.ts#yup-sync

<<< @/examples/validation.ts#yup-sync-use

A function has no output, so `apply` is not available this way.

## Deriving Zod schemas from a schema class

`@egon-orm/zod` builds a Zod schema from a schema class, so the shape is written once.
It needs Zod 4.6.6 or later as a peer dependency.

<<< @/examples/validation.ts#to-zod

| Mode | Shape |
|---|---|
| `"row"` | Every field, exactly as in a row, virtual and redacted fields included. The default. |
| `"insert"` | The fields an insert takes (no virtual fields). A field is optional when it is nullable, has a default, or is generated (by `.autogenerate()` or by the database). |
| `"update"` | Every field, all optional. |

`pick` and `omit` are typed and checked. An optional key may be absent but may not hold
`undefined` (Zod's `exactOptional`).

Every field accepts exactly the values its type accepts, checked with the type's own
`cast`: the members of an enum, a decimal's scale, a timestamp's precision, a UUID in
lower case. The built-in scalar types (`t.string()`, `t.integer()`, `t.bigint()`,
`t.float()`, `t.boolean()`, `t.uuid()`, `t.binary()`, the dates, times and timestamps)
start from the matching Zod type (`z.string()`, `z.int()`, `z.date()`, …), so a value of
the wrong kind gets Zod's own message. Enums, arrays, decimals with a precision, JSON and
custom types are a `z.custom()` check, reported as `is invalid`. An embed is a nested
object (a list of them for `embedMany`). `null` is accepted only for a `.nullable()`
field.

The result is an ordinary Zod object: `.extend()` it to add rules, and pass it to
`validate`. `castWith(target, params, schema)` is shorthand for `cast` with the schema's
keys as the permitted list, followed by `.validate(schema)`; every key of the schema must
be a field:

<<< @/examples/validation.ts#cast-with

A custom type becomes a check that accepts what the type's own `cast` accepts. To give
it a proper Zod schema instead, add a `zod` hint to the type:

<<< @/examples/validation.ts#zod-hint

## Writing a reusable validator

A validator is a value, so a rule used by several schemas is a function that returns one.
Type it with `ValidatorFn<T>` for the fields it needs:

<<< @/examples/validation.ts#reusable

::: tip Good to know
- **Validation keeps every issue by default**, except on a field that already has an
  error, which keeps its first message. A rule that reports on a field the user did not
  change is still reported (`scope: "all"`); opt in to `scope: "changed"` per call.
- **A validator function returns an array, or nothing.** `return { path, message }`,
  `return "is taken"` or `return null` throws a `TypeError`; it is never read as "no
  issues".
- **`validate` is synchronous.** A validator that returns a promise, such as any Yup
  schema, needs `validateAsync`.
- **Validators never change values** unless you pass `apply: true`, and then only when
  they found no issue.
- **Errors are plain data.** A schema error is `{ message, validation: "schema", meta: { path } }`,
  serialisable like every other changeset error.
:::

## See also

- [Changesets: validations](/guide/changesets#validations): the built-in rules.
- [Filters from a query string](/recipes/dynamic-filters): validating input without a table.
