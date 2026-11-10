---
"egon-orm": patch
---

`util.inspect(error)` and `console.log(error)` of an Egon error no longer show the database's own text, which can quote the value of a redacted field. `ConstraintError.detail` is shown as `(hidden: read error.detail)`, and the cause (the driver's error, and any cause chain) as one line of names and codes, such as `[cause]: error 23505 (hidden: read error.cause)`. The stack, the message, the identifier, the code, the constraint, table and column names and `sql` are shown as before. The properties are unchanged: `error.detail` and `error.cause` still hold the raw text, and `toJSON()` still gives `{ name, code, id }`. Node's printer of an uncaught exception does not use custom inspection and still prints both; see SECURITY.md.
