# Showing form errors (React)

A sign-up form whose server action returns the changeset's errors, and fields that show
them. The example uses React 19's `useActionState` and a server action, as in Next.js; the
part that matters, the state the action returns, works with any framework.

## Setup

Both parts below use these imports, the repo and the schema:

<<< ../../../examples/react-form/src/form-errors.tsx#setup

## The action

<<< ../../../examples/react-form/src/form-errors.tsx#action

`errorMessages()` returns a plain object, `{ field: ["message", …] }`, with validation
errors and declared constraint violations in the same shape. It is serialisable, so it can
be returned from a server action or an API as it is. It is typed by field:
`ErrorMessages<ReturnType<typeof User.changeset>>` names it for the client, so a misspelt
field is a compile error there too. The values go back as well, so the form keeps what the
user typed.

## The form

<<< ../../../examples/react-form/src/form-errors.tsx#form

- `aria-invalid` and `aria-describedby` tie each message to its input for screen readers.
- `noValidate` leaves the checking to the changeset, so the messages are the same with and
  without JavaScript.
- A nested form (`castAssoc`) has a list of trees under the association's key, one per
  item, in the order of the submitted items.

::: tip Good to know
- The messages are English templates with their values filled in. To translate them, use
  `traverseErrors` with a catalogue: see [Translating error messages](/recipes/translating-errors).
- An error on the record as a whole (from a cross-field validator) is under the key
  `"$base"` (`BASE`).
:::

## See also

- [Errors](/guide/changesets#errors) in the changesets guide
- [Framework integration](/guide/frameworks): Next.js server actions
