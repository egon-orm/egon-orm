/**
 * The adapter's event emitter: synchronous, and free when nobody listens. The adapter
 * reads one boolean per event kind before it measures or builds anything.
 *
 * @module
 */
import type { AdapterEvents, ParamSlot, QueryEvent } from "../contracts/adapter.js";
import { REDACTED } from "../internal/inspect.js";
import { own } from "../internal/own.js";

/**
 * Options of a `query` listener.
 *
 * @example
 * ```ts
 * const options: QueryListenerOptions = { params: true };
 * ```
 */
export interface QueryListenerOptions {
  /**
   * Include the parameter values in {@link QueryEvent.params}. A value bound to a redacted
   * field appears as `**redacted**`, and so does every value of an execution that was not
   * given its slots. Without this option `params` is `undefined`.
   */
  readonly params?: boolean;
}

type Listener<E extends keyof AdapterEvents> = (payload: AdapterEvents[E]) => void;

/**
 * Calls one listener, isolating the caller from it. A listener that throws must not fail
 * the statement it is reporting, nor stop the other listeners; its error is rethrown on a
 * later microtask, where it surfaces as an uncaught exception instead of being lost.
 */
function call<T>(listener: (payload: T) => void, payload: T): void {
  try {
    listener(payload);
  } catch (error) {
    queueMicrotask(() => {
      throw error;
    });
  }
}

/** Replaces each parameter bound to a redacted slot (all of them without slots) with {@link REDACTED}. */
export function redactParams(params: readonly unknown[], slots: readonly ParamSlot[] | undefined): unknown[] {
  const out = new Array<unknown>(params.length);
  for (let i = 0; i < params.length; i++) {
    out[i] = slots === undefined || slots[i]?.redact !== false ? REDACTED : params[i];
  }
  return out;
}

/**
 * The listeners of one adapter. Listener arrays are replaced, never mutated, so a listener
 * that unsubscribes during an emit does not disturb that emit.
 */
export class Telemetry {
  /** Whether anyone listens to `query` (with or without parameters). Read before measuring. */
  query = false;
  connect = false;
  disconnect = false;
  poolExhausted = false;

  private queryListeners: readonly Listener<"query">[] = [];
  private queryParamListeners: readonly Listener<"query">[] = [];
  private connectListeners: readonly Listener<"connect">[] = [];
  private disconnectListeners: readonly Listener<"disconnect">[] = [];
  private poolExhaustedListeners: readonly Listener<"poolExhausted">[] = [];

  /** Subscribes; returns the function that unsubscribes (idempotent). */
  on<E extends keyof AdapterEvents>(
    event: E,
    listener: Listener<E>,
    options: QueryListenerOptions | undefined,
  ): () => void {
    if (typeof listener !== "function") {
      throw new TypeError(`adapter.on("${String(event)}", listener): the listener must be a function.`);
    }
    const key = this.keyOf(event, options);
    // Wrapped so that subscribing the same function twice gives two independent subscriptions.
    const entry: Listener<E> = (payload) => listener(payload);
    this.set(key, [...this.get(key), entry]);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.set(
        key,
        this.get(key).filter((other) => other !== entry),
      );
    };
  }

  /**
   * Reports one executed statement. `params` and `slots` are read only when a listener
   * asked for parameters.
   */
  emitQuery(
    sql: string,
    params: readonly unknown[],
    slots: readonly ParamSlot[] | undefined,
    durationMs: number,
    queueMs: number,
    rowCount: number,
    error: unknown,
    context: unknown,
  ): void {
    const plain = this.queryListeners;
    if (plain.length > 0) {
      const event: QueryEvent = {
        sql,
        paramCount: params.length,
        durationMs,
        queueMs,
        rowCount,
        error,
        params: undefined,
        context,
      };
      for (const listener of plain) call(listener, event);
    }
    const withParams = this.queryParamListeners;
    if (withParams.length > 0) {
      const event: QueryEvent = {
        sql,
        paramCount: params.length,
        durationMs,
        queueMs,
        rowCount,
        error,
        params: redactParams(params, slots),
        context,
      };
      for (const listener of withParams) call(listener, event);
    }
  }

  /** Reports a pool event. */
  emitPool(event: "connect" | "disconnect" | "poolExhausted", payload: AdapterEvents[typeof event]): void {
    const listeners =
      event === "connect"
        ? this.connectListeners
        : event === "disconnect"
          ? this.disconnectListeners
          : this.poolExhaustedListeners;
    for (const listener of listeners) call(listener, payload);
  }

  private keyOf(event: keyof AdapterEvents, options: QueryListenerOptions | undefined): ListenerKey {
    switch (event) {
      case "query":
        return own(options, "params") === true ? "queryParams" : "query";
      case "connect":
      case "disconnect":
      case "poolExhausted":
        if (options !== undefined) {
          throw new TypeError(
            `adapter.on("${event}", listener, options): only "query" listeners take options.`,
          );
        }
        return event;
      default:
        throw new TypeError(
          `adapter.on(${JSON.stringify(event)}): unknown event. The events are "query", "connect", "disconnect" and "poolExhausted".`,
        );
    }
  }

  private get<E extends keyof AdapterEvents>(key: ListenerKey): readonly Listener<E>[] {
    switch (key) {
      case "query":
        return this.queryListeners as readonly Listener<E>[];
      case "queryParams":
        return this.queryParamListeners as readonly Listener<E>[];
      case "connect":
        return this.connectListeners as readonly Listener<E>[];
      case "disconnect":
        return this.disconnectListeners as readonly Listener<E>[];
      case "poolExhausted":
        return this.poolExhaustedListeners as readonly Listener<E>[];
    }
  }

  private set(key: ListenerKey, listeners: readonly ((payload: never) => void)[]): void {
    switch (key) {
      case "query":
        this.queryListeners = listeners as readonly Listener<"query">[];
        break;
      case "queryParams":
        this.queryParamListeners = listeners as readonly Listener<"query">[];
        break;
      case "connect":
        this.connectListeners = listeners as readonly Listener<"connect">[];
        this.connect = listeners.length > 0;
        break;
      case "disconnect":
        this.disconnectListeners = listeners as readonly Listener<"disconnect">[];
        this.disconnect = listeners.length > 0;
        break;
      case "poolExhausted":
        this.poolExhaustedListeners = listeners as readonly Listener<"poolExhausted">[];
        this.poolExhausted = listeners.length > 0;
        break;
    }
    this.query = this.queryListeners.length > 0 || this.queryParamListeners.length > 0;
  }
}

type ListenerKey = "query" | "queryParams" | "connect" | "disconnect" | "poolExhausted";
