# FAQ and troubleshooting

The errors people meet first, with the exact message and the fix. Compiler messages are
from TypeScript 6 (`tsc --pretty false`); type names in them depend on your code.

## Type errors

### `Property 'posts' does not exist on type 'User'`

```text
error TS2576: Property 'posts' does not exist on type 'User'. Did you mean to access the static member 'User.posts' instead?
```

The row was loaded without the association. Nothing is loaded lazily, so a plain `User`
has no `posts`, and the compiler says so instead of returning `undefined` at run time.
Preload it, and say what a function needs with `Loaded`:

<<< @/examples/faq.ts#preload

See [The Loaded type](/guide/associations#the-loaded-type).

### `Argument of type 'null' is not assignable to parameter of type 'Operand<…>'`

```text
error TS2345: Argument of type 'null' is not assignable to parameter of type 'Operand<string | null>'.
```

You wrote `u.name.eq(null)`. In SQL, `name = NULL` is never true, so the query would match
nothing; it is refused. Use one of these:

<<< @/examples/faq.ts#null

If the types are bypassed, the same mistake throws when the clause is added:

```text
QueryError: query.compareNull: where(): eq() was given null. See https://egon-orm.github.io/egon-orm/reference/errors/query#query-comparenull
```

### `Class 'Post' used before its declaration`, or a circular import

```text
error TS2449: Class 'Post' used before its declaration.
error TS2769: No overload matches this call.
    Argument of type 'typeof Post' is not assignable to parameter of type '() => unknown'.
```

An association takes a **function** that returns the class, not the class itself:
`hasMany(() => Post, …)`, not `hasMany(Post, …)`. The function runs the first time the
association is used, after both classes exist, which is what lets two schemas refer to each
other, in one file or across two files that import each other:

<<< @/examples/faq.ts#circular

- Import the other class as a value (`import { Post }`), not with `import type`: the
  function uses it at run time (`TS1361: 'Post' cannot be used as a value because it was
  imported using 'import type'`).
- Without the function, a circular import fails at run time as well, with
  `ReferenceError: Cannot access 'Post' before initialization`.
- Define schemas as classes, `class User extends Schema(…) {}`. A schema held in a `const`
  cannot refer to itself through another schema: TypeScript gives up and types it as
  `any` (`TS7022`). See [Why classes](/guide/schemas#why-classes-and-static-associations).

### `Expected 1 arguments, but got 0` on `new User()`

```text
error TS2554: Expected 1 arguments, but got 0.
```

A schema class has no public constructor: rows come from the database. A new record is a
changeset, `User.changeset(User, params)` or `change(User, values)`, which the repo turns
into a row. Calling the constructor anyway throws:

```text
SchemaDefinitionError: schema.noConstructor: User has no public constructor: a row comes only from the database. See https://egon-orm.github.io/egon-orm/reference/errors/schema#schema-noconstructor
```

### `insert takes a changeset of a new record`

```text
error TS2769: No overload matches this call.
  … Property '"insert takes a changeset of a new record (cast(User, …)); this one is of a loaded row: use update() or insertOrUpdate()"' is missing …
```

The changeset was made from a loaded row, so it describes an update:

<<< @/examples/faq.ts#update

The reverse mistake, `repo.update(change(User, values))`, names the other case:

```text
error TS2345: … Property '"update and delete take a changeset of a loaded row; this one is of a new record: use insert() or insertOrUpdate()"' is missing …
```

With `exactOptionalPropertyTypes` on, the same error is `TS2379`.

The same kind of message, `"a new record has no row: applyChanges() and applyAction() need a changeset of a loaded row"`,
appears when `applyChanges()` is called on a changeset of a class.

### `Argument of type 'typeof User' is not assignable to parameter of type 'Changeset<…>'`

```text
error TS2769: No overload matches this call.
  …
    Argument of type 'typeof User' is not assignable to parameter of type 'Changeset<AnySchema, boolean, never>'.
```

You wrote `repo.insert(User, { email })`, as you would with `create` elsewhere. A write
takes one changeset, which says what changes and validates it:
`repo.insert(change(User, { email }))` for trusted values, or
`repo.insert(User.changeset(User, params))` for input. See
[Creating a changeset](/guide/changesets#creating-a-changeset).

### `Expected 2-3 arguments, but got 1` on `repo.all(q)`

```text
error TS2554: Expected 2-3 arguments, but got 1.
```

The query has a [named parameter](/guide/queries#named-parameters), `param("email", t.string())`,
and the call gives it no value. Pass the values as the second argument, before the options:
`repo.all(q, { email })`. A misspelt name is reported on the object instead
(`TS2561: Object literal may only specify known properties, but 'emial' does not exist in type '{ email: string; }'`).

### `Argument of type '"postz"' is not assignable to parameter of type 'never'` on `preload`

```text
error TS2345: Argument of type '"postz"' is not assignable to parameter of type 'never'.
```

`preload` takes the names of the schema's associations, the `static` members made with
`hasMany`, `belongsTo` and the like; anything else is refused, and the compiler reports the
refusal as `never` rather than listing the names. Check the spelling against the class. The
same goes for `Loaded<typeof Post, "autor">`, which reports
`TS2344: Type '"autor"' does not satisfy the constraint 'PreloadSpec<typeof Post>'`.

### `Expected 2 arguments, but got 1` on `hasMany`

```text
error TS2554: Expected 2 arguments, but got 1.
```

`hasMany` and `hasOne` need their options: either `{ foreignKey }`, the field of the
**other** schema that holds this one's key, as in `hasMany(() => Post, { foreignKey: "authorId" })`,
or `{ through }`, a chain of associations to follow, as in
`hasMany(() => Comment, { through: ["posts", "comments"] })`. The key is not derived from
the class name, which a minifier may change. `belongsTo` has a default (`<property name>Id`).
See [Defining associations](/guide/associations#defining-associations).

### `Type '"emial"' is not assignable to type 'FieldName<typeof User>'`

```text
error TS2769: No overload matches this call.
  The last overload gave the following error.
    Type '"emial"' is not assignable to type 'FieldName<typeof User>'. Did you mean '"email"'?
```

The permitted fields of `cast` are checked against the schema. Fix the name; an unknown
name that gets past the types throws `QueryError` when the changeset is built.

### `Argument of type 'number' is not assignable to parameter of type 'Operand<string>'`

```text
error TS2345: Argument of type 'number' is not assignable to parameter of type 'Operand<string>'.
```

The value does not have the column's type (`u.email.eq(1)`). Operators take values of the
column's type; there is no implicit conversion. Convert the value, or compare with
`cast(...)` on the column.

### `Type 'Col<string>' is not assignable to type 'Condition'`

```text
error TS2769: No overload matches this call.
  …
    Type 'Col<string>' is not assignable to type 'Condition'.
      The types of '"~expr".type' are incompatible between these types.
        Type 'string' is not assignable to type 'boolean | null'.
```

A `where` callback returned a column instead of a condition, for example
`.where(({ u }) => u.email)`. Return a comparison: `u.email.eq(email)`, or for a boolean
column the column itself (`p.published`).

### A preload with a `select` `selects without its key`

```text
QueryError: query.preloadSelectKey: preload "posts" selects without its key. See https://egon-orm.github.io/egon-orm/reference/errors/query#query-preloadselectkey
```

A preload whose callback selects columns must include the field the association is matched
on (`authorId` for `User.posts`, `id` for `Post.author`); nothing is added for you.

- For `hasMany` and `hasOne`, where the key is the foreign key on the child, leaving it out
  is also a compile error that names the field
  (`"~error": "preload \"posts\" selects without its key: add authorId to the select"`).
- For `belongsTo` (the target's primary key), the query compiles, and throws this
  `QueryError` when it is built.

## Errors at run time

The messages below are as thrown by default: an identifier, a short sentence and a link to
the identifier's entry, which says what to do. In development, `useFullErrorMessages` puts
that advice in every message, and `explain(error)` gives it for one error; see
[Errors](/reference/errors#full-messages-in-development).

### `ConstraintError: … The changeset has not defined this constraint`

```text
ConstraintError: constraint.undeclared: unique constraint "users_email_key" violated on insert into "users". The changeset has not defined this constraint. See https://egon-orm.github.io/egon-orm/reference/errors/constraint#constraint-undeclared
```

With full messages on, the message ends with the declaration to add:

```text
Add: .uniqueConstraint("email")
(or .uniqueConstraint("email", { name: "users_email_key" }))
```

The database rejected the write, and the changeset did not say that this violation is an
expected form error. Add the declaration the message suggests to the changeset function;
the write then returns `{ success: false }` with `{ email: ["has already been taken"] }`.
If your index has another name, pass it with `{ name }`. See [Constraints](/guide/constraints).

### `QueryError: where({ name: undefined }) …`

```text
QueryError: query.filterUndefined: where({ name: undefined }) on the root binding "u" (User): undefined is not a value, and a filter that silently disappears matches every row. See https://egon-orm.github.io/egon-orm/reference/errors/query#query-filterundefined
```

A filter built from optional input had no value. Add the clause only when there is one:

<<< @/examples/faq.ts#undefined

### `QueryError: repo.raw() takes a fragment`

```text
QueryError: query.rawArgument: repo.raw() takes a fragment, and was given a string, which would put text into the SQL unchecked. See https://egon-orm.github.io/egon-orm/reference/errors/query#query-rawargument
```

`repo.raw` never takes a string. Write ``repo.raw(fragment`select … where id = ${id}`)``:
the interpolations become bound parameters.

### `NoResultsError` from `getOrThrow`

The row does not exist. Use `get`, which returns `null`, where a missing row is expected,
and map `NoResultsError` to a 404 where it is not (see
[Framework integration](/guide/frameworks#express)).

### `StaleEntryError` on update

No row matched the update: the row was deleted, or the
[optimistic lock](/recipes/optimistic-locking) found a newer version. Pass
`{ staleError: { field } }` to report it on the changeset instead.

## Questions

### Why is there no `user.save()`?

Rows are data: they hold no connection and track no changes. A change is a changeset,
written by the repo; see [Introduction](/guide/#why-keep-them-apart).

### Why does `repo.insert` not throw on invalid input?

Invalid input is an expected outcome of a form, so it is a typed result you handle where
you call it. Every write has an `OrThrow` twin for code where a failure is a bug.

### Can I use my existing tables?

Yes. Declare schema classes that match them, with `.column("…")` where a column name is not
the snake_case form of the field. A table needs no migration history to be used; see
[Adopting an existing database](/guide/migrations#adopting-an-existing-database) to start
migrating it.

### Does it work with SQLite and MySQL?

Yes, with the gaps listed in [Dialect support](/reference/dialect-support). Postgres
supports every feature.

### Are editor completions slow in a large model?

Not in a query callback. After an edit, the editor checks the types again before it can
offer completions. Inside a callback such as `where(({ u }) => u.)`, `orderBy`, `groupBy`,
`having` or a join's `on`, that costs the same in a model of 200 connected schemas as in
one of ten: about 25 ms on the machine measured.

One case still grows with the model: a callback inside a callback that returns the query,
such as `preload("posts", (q) => q.where(({ posts }) => posts.))` or
`pipe((q) => q.where(…))`. There the cost grows with the number of schemas reachable from
the query's schema through associations: about 270 ms with 200 connected schemas on the
same machine. A model of a few dozen schemas does not notice. About half of that is the
editor inferring the return types of the reachable schemas' `changeset` methods; the fix
is on the [roadmap](/reference/roadmap).

If that case is slow for you, declare the return type of your `changeset` methods. Include
in the type the error keys that the validations add, such as `passwordConfirmation` from
`validateConfirmation("password")`, or `errorMessages()` loses them:

<<< @/examples/faq-completions.ts#completions

Write `boolean` for the second argument when the method takes a loaded row or the class,
as here. `true` means a new record only, whose `data` is typed `null`.

## See also

- [Errors](/reference/errors): every error class and code.
- [Glossary](/reference/glossary)
