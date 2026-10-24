# @egon-orm/zod

[Zod](https://zod.dev) schemas derived from [Egon ORM](https://www.npmjs.com/package/egon-orm)
schemas, and `castWith`, which casts and validates input in one call.

Egon's changesets accept any Standard Schema validator (Zod, Valibot, ArkType, Yup) without
this package. Use it to derive a Zod schema from an Egon schema instead of writing the
fields twice.

## Install

```sh
npm install egon-orm @egon-orm/zod zod
```

`zod` 4.6.6 or later is a peer dependency.

## Example

<!-- example: docs/site/examples/readme/zod.ts#example -->
```ts
import { castWith, toZod } from "@egon-orm/zod";
import { Schema, t } from "egon-orm";
import { z } from "zod";

class User extends Schema("users", {
  id: t.integer().primaryKey().dbGenerated(),
  email: t.string(),
  name: t.string().nullable(),
}) {}

// A Zod schema derived from the Egon schema, with one rule added.
const SignUp = toZod(User, { mode: "insert", pick: ["email", "name"] }).extend({
  email: z.string().email(),
});
type SignUp = z.infer<typeof SignUp>; // { email: string; name?: string | null }

// Cast the picked fields and validate them with SignUp, in one call.
const cs = castWith(User, { email: "not an email" }, SignUp);
cs.valid; // false
```

## Documentation

[Validation](https://egon-orm.github.io/egon-orm/guide/validation#deriving-zod-schemas-from-a-schema-class)
covers `toZod`, its modes and hints, and `castWith`. The full documentation is at
https://egon-orm.github.io/egon-orm/.

MIT licence.
