/**
 * The protocol's cancel request: what libpq's `PQcancel` and `pg` send to stop a running
 * statement. A new socket to the server carries 16 bytes (length, the cancel code, the
 * backend's process id and secret key) and is closed by the server once it has acted on
 * them. It needs no authentication and no free connection slot, and a pooler that
 * forwards cancel requests (PgBouncer does) passes it on to the right backend.
 *
 * When the connection uses TLS, so does the cancel request: the socket asks for TLS first
 * (an SSLRequest, or a direct TLS handshake with `sslNegotiation: "direct"`) with the
 * connection's own TLS options, and the request is never sent in plain text if TLS cannot
 * be set up.
 *
 * `node:net` and `node:tls` are loaded the first time a cancel request is sent, not when
 * the module loads: the package then loads on runtimes that lack them, and only
 * cancellation is unavailable there (the request fails, so the adapter lets the statement
 * finish and does not reuse its connection).
 *
 * @module
 */
import type { Socket } from "node:net";
import type { ConnectionOptions, TLSSocket } from "node:tls";

/** The parts of `node:net` and `node:tls` a cancel request uses. */
export interface SocketModules {
  readonly connect: typeof import("node:net").connect;
  readonly isIP: typeof import("node:net").isIP;
  readonly connectTls: typeof import("node:tls").connect;
}

/** The modules once loaded, or the loading under way. */
let modules: Promise<SocketModules> | undefined;

/**
 * Loads `node:net` and `node:tls`, once. Rejects, and lets a later call try again, when the
 * runtime does not provide them.
 *
 * @example
 * ```ts
 * const { connect } = await loadSocketModules();
 * ```
 */
export function loadSocketModules(): Promise<SocketModules> {
  modules ??= Promise.all([import("node:net"), import("node:tls")]).then(
    ([net, tls]) => ({ connect: net.connect, isIP: net.isIP, connectTls: tls.connect }),
    (cause: unknown) => {
      modules = undefined;
      throw new Error(
        "Cancelling a statement needs node:net and node:tls, which this runtime does not provide (on Cloudflare Workers, enable the nodejs_compat flag).",
        { cause },
      );
    },
  );
  return modules;
}

/** Where to send a cancel request, and the key of the backend whose statement it stops. */
export interface CancelTarget {
  /**
   * Where to connect: the address the connection is actually connected to (so that DNS
   * round-robin or a load balancer cannot send the request to another server), else the
   * configured host. A Unix-socket directory starts with `/`.
   */
  readonly host: string;
  readonly port: number;
  /** The configured host name, which a TLS certificate is checked against. */
  readonly serverName: string;
  readonly processId: number;
  readonly secretKey: number;
  /** The connection's TLS settings: `false` for none, `true` or options for `node:tls`. */
  readonly ssl: boolean | ConnectionOptions;
  /** `"direct"` starts TLS at once (Postgres 17+); `"postgres"` asks with an SSLRequest first. */
  readonly sslNegotiation: "postgres" | "direct";
}

/** The protocol's code for a cancel request (1234 in the high 16 bits, 5678 in the low). */
const CANCEL_REQUEST_CODE = 80_877_102;
/** The protocol's code for an SSLRequest (1234, 5679). */
const SSL_REQUEST_CODE = 80_877_103;

/** The 16 bytes of a cancel request. */
export function cancelRequestMessage(processId: number, secretKey: number): Buffer {
  const message = Buffer.alloc(16);
  message.writeInt32BE(16, 0);
  message.writeInt32BE(CANCEL_REQUEST_CODE, 4);
  message.writeInt32BE(processId | 0, 8);
  message.writeInt32BE(secretKey | 0, 12);
  return message;
}

/** The 8 bytes of an SSLRequest. */
export function sslRequestMessage(): Buffer {
  const message = Buffer.alloc(8);
  message.writeInt32BE(8, 0);
  message.writeInt32BE(SSL_REQUEST_CODE, 4);
  return message;
}

/** The options `pg` itself gives `tls.connect` for a connection with these settings. */
function tlsOptions(target: CancelTarget, socket: Socket, isIP: SocketModules["isIP"]): ConnectionOptions {
  const options: ConnectionOptions = { socket, host: target.serverName };
  if (target.ssl !== true && target.ssl !== false) {
    Object.assign(options, target.ssl);
    // pg makes `key` (a client certificate's private key) non-enumerable so that it does
    // not show up in logs, and Object.assign skips it; pg copies it explicitly, so must we.
    // It is the only TLS option pg treats that way.
    // An own property only: a `key` planted on Object.prototype is no private key.
    if (Object.hasOwn(target.ssl, "key")) options.key = target.ssl.key;
  }
  if (target.sslNegotiation === "direct") options.ALPNProtocols = ["postgresql"];
  // SNI must not be an IP address (RFC 6066, section 3).
  if (isIP(target.serverName) === 0) options.servername = target.serverName;
  return options;
}

/**
 * Sends a cancel request. Resolves when the server has closed the socket after receiving
 * it; rejects when the server cannot be reached, refuses TLS that the connection uses,
 * fails the TLS handshake, closes the socket before the request was sent, or does not
 * finish within `timeoutMs`. The server never says whether a statement was cancelled: a
 * backend that is idle by then ignores the request.
 *
 * Also rejects when the runtime has no `node:net` or `node:tls` (see the module comment).
 * `load` gives the socket modules; tests replace it.
 */
export async function sendCancelRequest(
  target: CancelTarget,
  timeoutMs: number,
  load: () => Promise<SocketModules> = loadSocketModules,
): Promise<void> {
  const { connect, isIP, connectTls } = await load();
  return new Promise<void>((resolve, reject) => {
    const socket: Socket = target.host.startsWith("/")
      ? connect(`${target.host}/.s.PGSQL.${target.port}`)
      : connect(target.port, target.host);
    let secure: TLSSocket | undefined;
    let sent = false;
    let settled = false;
    const finish = (error: Error | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      secure?.destroy();
      socket.destroy();
      if (error === undefined) resolve();
      else reject(error);
    };
    const timer = setTimeout(
      () => finish(new Error(`The cancel request got no answer within ${timeoutMs} ms.`)),
      timeoutMs,
    );
    const closed = (): void =>
      finish(
        sent ? undefined : new Error("The server closed the connection before the cancel request was sent."),
      );
    const send = (to: Socket): void => {
      sent = true;
      to.end(cancelRequestMessage(target.processId, target.secretKey));
      // The server sends nothing back; reading keeps the socket flowing until it closes.
      to.resume();
    };
    const upgrade = (): void => {
      let tls: TLSSocket;
      try {
        tls = connectTls(tlsOptions(target, socket, isIP));
      } catch (error) {
        finish(error as Error);
        return;
      }
      secure = tls;
      tls.once("secureConnect", () => send(tls));
      tls.once("error", finish);
      tls.once("close", closed);
    };
    socket.once("error", finish);
    socket.once("close", closed);
    socket.once("connect", () => {
      if (target.ssl === false) {
        send(socket);
      } else if (target.sslNegotiation === "direct") {
        upgrade();
      } else {
        socket.once("data", (answer: Buffer) => {
          if (answer.length === 1 && answer[0] === 0x53 /* S */) {
            upgrade();
          } else {
            // Never fall back to plain text when the connection itself uses TLS.
            finish(new Error("The server refused TLS for the cancel request, so it was not sent."));
          }
        });
        socket.write(sslRequestMessage());
      }
    });
  });
}
