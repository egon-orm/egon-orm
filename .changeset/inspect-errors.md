---
"egon-orm": patch
---

`util.inspect(error)` and `console.log(error)` of an Egon error no longer show the database's own text, which can quote the value of a redacted field. `ConstraintError.detail` is shown as `(hidden: read error.detail)`. Every cause, and every link of a cause chain, is shown on one line by its name and code only, such as `[cause]: error 23505 (hidden: read error.cause)`: this applies to every cause, including errors that are not the database's (a `TypeError` thrown in a migration's `up()`, for example), whose message and stack are no longer shown; `console.log(error.cause)` shows them. The error's own stack and message, its identifier, code, constraint, table and column names and `sql` are shown as before. The properties are unchanged: `error.detail` and `error.cause` still hold the raw text, and `toJSON()` still gives `{ name, code, id }`. Node's printer of an uncaught exception does not use custom inspection and still prints both; see SECURITY.md.
