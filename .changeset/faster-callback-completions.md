---
"egon-orm": patch
---

Editor completions and hovers inside query callbacks no longer slow down as the model grows. The bindings that `where`, `orWhere`, `having`, `distinct`, `groupBy`, `orderBy` and the joins' `on` callbacks receive, and the changeset that a changeset's `pipe` passes, are now declared `NoInfer<…>`. Before, inferring the call's type arguments walked from the bindings through every schema reachable through associations, so after each edit the editor checked all of them again. On a model of 200 connected schemas, a completion in a `where` callback took about 250 ms after an edit and now takes about 25 ms, and type-checking a long chain of associations went from about 4.3 s to 1.2 s. The types the callbacks receive and the types the calls return are unchanged.
