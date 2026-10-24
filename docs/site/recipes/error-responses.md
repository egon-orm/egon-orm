# Errors as HTTP responses

Egon ships no HTTP helper: which status an error deserves is your application's decision.
This recipe maps the expected outcomes of a read or a write to responses in one function,
and types the response body on the client.

| Outcome | Status | Body |
|---|---|---|
| A request body that is not JSON | 400 | `{ error: "Bad Request" }` |
| An invalid changeset (`result.success` is `false`) | 422 | `{ errors: result.error.errorMessages() }` |
| `NoResultsError` from a `...OrThrow` read | 404 | `{ error: "Not Found" }` |
| `StaleEntryError`: the row changed or was deleted since it was read | 409 | `{ error: "Conflict" }` |
| `ConstraintError` with `type: "unique"`, for a constraint the changeset did not declare | 409 | `{ error: "Conflict" }` |
| Anything else | 500 | `error.toJSON()` for an error of the library, `{ name, code, id }`; `{ error: "Internal Server Error" }` otherwise. The message goes to your logs. |

## Setup

<<< @/examples/recipes/error-responses.ts#setup

## One function for the errors

<<< @/examples/recipes/error-responses.ts#map

## The handlers

<<< @/examples/recipes/error-responses.ts#handlers

A body that cannot be parsed is the client's mistake, answered with 400 before any
database work. A write returns a result, so the invalid changeset is handled where it
happens, with its messages. The exceptions are the outcomes a handler does not expect, and
go to `errorResponse`.

## On the client

<<< @/examples/recipes/error-responses.ts#client

- `Json<User>` is the user as `JSON.stringify` writes it: `createdAt` is a string, and the
  virtual `password` is not there (nor would a redacted field be).
- `ErrorMessages<ReturnType<typeof User.changeset>>` is the type of `errorMessages()` on
  the changeset `User.changeset` makes, and on the one the write gives back: one optional
  key per field and association, `$base`, and the keys its validations add
  (`passwordConfirmation`). `JsonReturn` of a handler that returns it is the same type.

::: tip Good to know
- Declare the constraints a user can violate (`uniqueConstraint("email")`): the write then
  returns an invalid changeset with `has already been taken` on the field, which belongs in
  a 422, instead of throwing.
- A 500 response carries no message. An error's message can name tables and constraints,
  which is for your logs, not your users; `error.toJSON()` writes only its class name, its
  `code` and its `id`, which you can look up in [Errors](/reference/errors).
- Send rows, not copies of them: `Response.json(user)` writes what `Json<User>` says, but
  a copy (`{ ...user }`, `const { email, ...rest } = user`) is a plain object, which
  `JSON.stringify` writes in full, redacted and virtual fields included. `Json` of a copy
  says so; `Json` of a mapped type such as `Omit<User, "email">` still describes the row.
:::

## See also

- [Showing form errors (React)](/recipes/form-errors)
- [Errors](/guide/changesets#errors) in the changesets guide
- [Frameworks](/guide/frameworks)
