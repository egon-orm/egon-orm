# Edge runtimes

Egon runs on Cloudflare Workers with the `nodejs_compat` compatibility flag, with
`@egon-orm/postgres` and the `pg` driver. Nothing in the API changes; three things about
the runtime do: how long a connection may live, whether code can be generated, and how
much a bundle weighs.

## Cloudflare Workers

Turn on Node's APIs, which `pg` needs, in `wrangler.toml`:

```toml
compatibility_flags = ["nodejs_compat"]
```

### A repo per request

A Worker may not use a connection that another request opened: a request that tries fails
or hangs. So create the repo, and with it its pool, in the handler, and close it once
the response is sent with `ctx.waitUntil`:

<<< @/examples/edge.ts#worker

Define schemas at the top of the module, as anywhere else: they are made once, when the
Worker starts, and shared by every request. So are compiled queries: every adapter created
with the same dialect, capabilities, driver codecs and `planCacheSize` shares one plan
cache, so the repo of a later request reuses the plans compiled by earlier ones.

### Hyperdrive

[Hyperdrive](https://developers.cloudflare.com/hyperdrive/) keeps a pool of connections
near your database; a Worker connects to it as to Postgres, so the per-request pool above
costs little. Pass its connection string:

<<< @/examples/edge.ts#hyperdrive

### Code generation

Egon makes rows and decoders with generated functions where the runtime allows it.
Workers allow `new Function` while the Worker starts and refuse it while a request is
handled. Egon tries at the moment it needs a function and falls back to a loop that gives
the same result where the runtime refuses: the row factory and the validator tables of a
schema are generated when the schema is defined (at startup), and what is first needed
during a request (a query's decoder) is built without generated code. Nothing to set: the
`codegen: false` options of `Schema()` and `createRepo` are for environments that should
never be asked, such as a strict Content Security Policy.

### Cancelling a statement

`timeoutMs` and `signal` cancel a running statement with Postgres's cancel request, which
needs `node:net` and `node:tls`. `@egon-orm/postgres` loads them the first time a
statement is cancelled, so the package loads where they are missing. There, cancelling
fails: the statement runs to its end, and the call rejects with
`database.timeoutNotCancelled` (or `database.abortedNotCancelled`), whose `cause` says why;
its connection is not reused.

## Error messages

Thrown errors carry a short message by default: an identifier, a sentence that names what
failed, and a link to what to do about it. The full text ships separately, in
`egon-orm/messages`, so that a Worker does not carry it. In development, turn it on:

<<< @/examples/edge.ts#messages

or call `explain(error)` where you log an error. See [Errors](/reference/errors).

::: warning Errors made before the call
An error constructed before `useFullErrorMessages` runs (a schema that fails while its
module is imported) keeps its short message; `explain(error)` gives its full text.
:::

## The size of a bundle

Measured from the packed packages with esbuild, minified, `pg` left out
(`node scripts/size-report.mjs`):

| Imports | min | gzip |
|---|---:|---:|
| A table, an insert, a select with `where`, `orderBy` and `limit` | 386 KB | 120 KB |
| Schemas only | 51 KB | 17 KB |
| `cast` | 100 KB | 31 KB |
| A query, not run | 121 KB | 38 KB |
| `EgonError` only | 1.6 KB | 0.9 KB |
| `egon-orm/messages` (the full messages, when imported) | 68 KB | 19 KB |

The packages are published one file per module, with `"sideEffects": false`, so a bundler
keeps only the modules an application uses. The example Worker of the repository
(`examples/edge-worker`, which also imports `egon-orm/messages`), with `pg`, is about
570 KiB minified and 178 KiB gzip (October 2026; CI's `edge worker` job prints the current
size in its summary). Cloudflare limits a Worker to 64 MiB uncompressed on every plan,
with no compressed limit, and its global scope must start within 1 second
([Workers limits](https://developers.cloudflare.com/workers/platform/limits/#worker-size),
as of October 2026).

## Not supported yet

- **Vercel Edge** and other runtimes without Node's `net`: `pg` needs a TCP socket.
- **Cloudflare D1**, and **Neon's HTTP driver**: they need adapters of their own.

::: tip Good to know
Coming from an ORM with a long-lived client: on Workers there is no long-lived client.
The repo is cheap to make; what is expensive (schemas, compiled plans) is made once and
shared.
:::
