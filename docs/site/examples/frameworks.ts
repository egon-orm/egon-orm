// The checked sources of the code blocks in guide/frameworks.md. Each `#region` is included
// in the page by name; everything outside a region is the scaffolding that makes the regions
// compile. Type-checked against Express 5, Fastify 5 and Hono 4; not run.
import { postgres } from "@egon-orm/postgres";
import {
  belongsTo,
  cast,
  createRepo,
  DatabaseError,
  type ErrorMessages,
  from,
  InvalidChangesetError,
  type Json,
  type JsonReturn,
  type Loaded,
  NoResultsError,
  type PreloadSpec,
  type Repo,
  Schema,
  t,
} from "egon-orm";
import express, { type ErrorRequestHandler, type Express } from "express";
import Fastify from "fastify";
import { Hono } from "hono";

class Post extends Schema("posts", {
  id: t.integer().primaryKey().dbGenerated(),
  title: t.string(),
}) {
  static changeset(post: Post | typeof Post, params: unknown) {
    return cast(post, params, ["title"]).validateRequired(["title"]);
  }
}

class Writer extends Schema("writers", {
  id: t.integer().primaryKey().dbGenerated(),
  name: t.string(),
  passwordHash: t.string().redact(),
}) {}

class Article extends Schema("articles", {
  id: t.integer().primaryKey().dbGenerated(),
  writerId: t.integer(),
  title: t.string(),
  publishedAt: t.timestamp().nullable(),
}) {
  static writer = belongsTo(() => Writer);
}

// #region repo
// db.ts: one repo for the whole process, created when the module is first imported.
export const repo = createRepo({
  adapter: postgres({ connectionString: process.env.DATABASE_URL, pool: { max: 10 } }),
});
// #endregion repo

export function expressApp(): Express {
  // #region express
  const app = express();
  app.use(express.json());

  app.get("/posts/:id", async (req, res) => {
    const post = await repo.getOrThrow(Post, Number(req.params.id), {
      context: { requestId: req.get("x-request-id") },
    });
    res.json(post);
  });

  app.post("/posts", async (req, res) => {
    const result = await repo.insert(Post.changeset(Post, req.body));
    if (!result.success) {
      res.status(422).json({ errors: result.error.errorMessages() });
      return;
    }
    res.status(201).json(result.data);
  });

  // Errors the library throws, mapped to responses once (Express 5 passes rejected promises here).
  const errors: ErrorRequestHandler = (error, _req, res, next) => {
    if (error instanceof NoResultsError) res.status(404).json({ error: "not found" });
    else if (error instanceof InvalidChangesetError)
      res.status(422).json({ errors: error.changeset.errorMessages() });
    else if (error instanceof DatabaseError && error.code === "timeout")
      res.status(503).json({ error: "try again" });
    else next(error);
  };
  app.use(errors);
  // #endregion express
  return app;
}

export function fastifyApp() {
  // #region fastify
  const app = Fastify({ logger: true });

  // Slow statements go to Fastify's logger, with the call's context (the request id below).
  const stopListening = repo.on("query", (event) => {
    if (event.durationMs > 200)
      app.log.warn({ sql: event.sql, ms: event.durationMs, ...event.context }, "slow query");
  });

  app.get<{ Params: { id: string } }>("/posts/:id", async (request, reply) => {
    const post = await repo.get(Post, Number(request.params.id), { context: { requestId: request.id } });
    return post ?? reply.code(404).send({ error: "not found" });
  });

  // The repo outlives the app (tests may build several): only the listener goes with it.
  // Close the repo itself at shutdown (below).
  app.addHook("onClose", async () => stopListening());
  // #endregion fastify
  return app;
}

export function honoApp() {
  // #region hono
  const app = new Hono();

  app.get("/posts", async (c) => {
    const posts = await repo.all(
      from(Post, "p")
        .orderBy(({ p }) => p.id.desc())
        .limit(20),
      { signal: c.req.raw.signal }, // a client that goes away cancels the query
    );
    return c.json(posts);
  });

  // One transaction for one request, when the handler needs it: passed on explicitly.
  app.post("/posts/batch", async (c) => {
    const titles = await c.req.json<string[]>();
    const created = await repo.transactionOrThrow(async (tx) => {
      const rows: Post[] = [];
      for (const title of titles) rows.push(await tx.insertOrThrow(Post.changeset(Post, { title })));
      return rows;
    });
    return c.json(created, 201);
  });

  app.onError((error, c) =>
    error instanceof InvalidChangesetError
      ? c.json({ errors: error.changeset.errorMessages() }, 422)
      : c.json({ error: "internal error" }, 500),
  );
  // #endregion hono
  return app;
}

export function shutdown() {
  const app = expressApp();
  // #region shutdown
  const server = app.listen(3000);

  async function stop(signal: string) {
    process.stderr.write(`${signal}: shutting down\n`);
    // Stop accepting connections, and wait until the running requests have finished...
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    // ...then close the pool: no request is left to need it.
    await repo.close();
  }
  process.once("SIGTERM", () => void stop("SIGTERM"));
  process.once("SIGINT", () => void stop("SIGINT"));
  // #endregion shutdown
}

// #region nextjs-repo
// lib/db.ts in a Next.js app. In development the module is evaluated again on every change;
// keeping the repo on globalThis keeps one pool instead of one per reload.
const globalForDb = globalThis as typeof globalThis & { egonRepo?: Repo };

export const db =
  globalForDb.egonRepo ?? createRepo({ adapter: postgres({ connectionString: process.env.DATABASE_URL }) });

if (process.env.NODE_ENV !== "production") globalForDb.egonRepo = db;
// #endregion nextjs-repo

// #region nextjs-action
// app/posts/actions.ts
// "use server";
export async function createPost(_state: unknown, form: FormData) {
  const result = await db.insert(Post.changeset(Post, { title: form.get("title") }));
  if (!result.success) return { errors: result.error.errorMessages() }; // plain data: crosses to the client
  return { id: result.data.id };
}
// #endregion nextjs-action

// #region typing-from-function
// The response type comes from the function that makes it, preloads included.
export async function loadArticle(id: number) {
  return db.getByOrThrow(from(Article, "a").preload("writer"), { id });
}
export type ArticleResponse = JsonReturn<typeof loadArticle>;
// { id: number; writerId: number; title: string; publishedAt: string | null;
//   writer: { id: number; name: string } }
// #endregion typing-from-function

// #region typing-from-schema
// Named from the schema: the row type with its preloads...
export type ArticleWithWriter = Json<Loaded<typeof Article, "writer">>;

// ...or one spec, used by the query and by the type, so that the two cannot drift apart.
const listPreloads = { writer: true } as const satisfies PreloadSpec<typeof Article>;
export type ArticleListItem = Json<Loaded<typeof Article, typeof listPreloads>>;
export const listArticles = () => db.all(from(Article, "a").preload(listPreloads));
// #endregion typing-from-schema

// #region typing-errors
// What createPost returns, on the client: the errors are typed by field.
export type CreatePostState = JsonReturn<typeof createPost>;
export type PostErrors = ErrorMessages<ReturnType<typeof Post.changeset>>;
// #endregion typing-errors

// #region serverless
// A function handler: the repo lives outside it, so warm invocations reuse the connection.
const serverlessRepo = createRepo({
  adapter: postgres({
    connectionString: process.env.DATABASE_URL,
    pool: { max: 1, idleTimeoutMs: 10_000, connectionTimeoutMs: 5_000 },
    applicationName: "my-function",
  }),
});

export async function handler(event: { pathParameters?: { id?: string } }) {
  const post = await serverlessRepo.get(Post, Number(event.pathParameters?.id), { timeoutMs: 5_000 });
  return post === null ? { statusCode: 404, body: "" } : { statusCode: 200, body: JSON.stringify(post) };
}
// #endregion serverless
