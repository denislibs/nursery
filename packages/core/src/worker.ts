/// <reference lib="dom" />
import './polyfill.js';
import { abortError, anySignal, type MaybeSignal } from './signal.js';
import { Queue } from './limit.js';

/** Anything with postMessage + message events: Worker, MessagePort, DedicatedWorkerGlobalScope. */
export interface Endpoint {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
  start?(): void;
}

// oxlint-disable-next-line typescript/no-explicit-any
type AnyFn = (...args: any[]) => any;

export type Remote<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
} & Disposable;

const transferLists = new WeakMap<object, Transferable[]>();
const CALLBACK = Symbol('nursery.callback');
interface CallbackMarker {
  [CALLBACK]: AnyFn;
}

/**
 * Marks `value` (an argument, a return value, or something nested in them) so the listed
 * buffers are moved instead of copied.
 *   remote.process(transfer(buf, [buf]))
 *   return transfer({ pixels }, [pixels.buffer])
 */
export function transfer<T extends object>(value: T, transferables: Transferable[]): T {
  transferLists.set(value, transferables);
  return value;
}

/**
 * Wraps a function so it can travel to the other side (anywhere in the arguments, including
 * nested objects and arrays). Calls made there come back here and resolve with the return value.
 * Valid for the duration of the remote call that carried it. Callbacks may carry callbacks.
 */
export function callback<F extends AnyFn>(fn: F): F {
  return { [CALLBACK]: fn } as unknown as F;
}

// ---- wire format -----------------------------------------------------------------------

interface SerializedError {
  __sk: 'error';
  name: string;
  message: string;
  stack?: string;
}
interface SignalMarker {
  __sk: 'signal';
  index: number;
}
interface CallbackRef {
  __sk: 'callback';
  owner: string;
  cbId: number;
}

type CallMsg = { t: 'call'; id: number; method: string; args: unknown[]; signals: number };
type AbortMsg = { t: 'abort'; id: number; index: number; reason: unknown };
type OkMsg = { t: 'ok'; id: number; value: unknown };
type ErrMsg = { t: 'err'; id: number; error: SerializedError };
/** Invoke the callback `cbId` that the receiver registered under `owner`. */
type CbMsg = { t: 'cb'; owner: string; cbId: number; callId: number; args: unknown[] };
type CbResultMsg = { t: 'cbr'; callId: number; value?: unknown; error?: SerializedError };
type Msg = CallMsg | AbortMsg | OkMsg | ErrMsg | CbMsg | CbResultMsg;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' &&
  v !== null &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) return { __sk: 'error', name: err.name, message: err.message, stack: err.stack };
  return { __sk: 'error', name: 'Error', message: String(err) };
}

function deserializeError(e: SerializedError): Error {
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return new DOMException(e.message, e.name);
  const err = new Error(e.message);
  err.name = e.name;
  if (e.stack) err.stack = e.stack;
  return err;
}

const isSerializedError = (v: unknown): v is SerializedError => isPlainObject(v) && v['__sk'] === 'error';
const isSignalMarker = (v: unknown): v is SignalMarker => isPlainObject(v) && v['__sk'] === 'signal';
const isCallbackRef = (v: unknown): v is CallbackRef => isPlainObject(v) && v['__sk'] === 'callback';
const isCallbackMarker = (v: unknown): v is CallbackMarker =>
  typeof v === 'object' && v !== null && CALLBACK in v;

function cloneableReason(reason: unknown): unknown {
  if (reason instanceof Error) return serializeError(reason);
  if (reason === undefined || reason === null || typeof reason !== 'object') return reason;
  try {
    return JSON.parse(JSON.stringify(reason)) as unknown;
  } catch {
    return abortError().message;
  }
}

// ---- peer: the symmetric half of the protocol ---------------------------------------------

interface Encoded {
  value: unknown;
  signals: AbortSignal[];
  transferables: Transferable[];
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  cleanup: () => void;
}

/**
 * One side of the link. Both expose() and wrap() are a Peer: each can send calls, execute
 * calls, invoke the other side's callbacks and serve its own.
 */
class Peer {
  #endpoint: Endpoint;
  #api: Record<string, AnyFn> | undefined;
  #nextCall = 1;
  #nextCb = 1;
  #nextCbCall = 1;
  #pending = new Map<number, Pending>();
  #running = new Map<number, AbortController[]>();
  #callbacks = new Map<string, Map<number, AnyFn>>(); // owner → cbId → fn
  #cbPending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  #disposed = false;
  #onMessage = (ev: MessageEvent) => {
    const msg = ev.data as Msg;
    if (!msg || typeof msg !== 'object') return;
    void this.#handle(msg);
  };

  constructor(endpoint: Endpoint, api?: Record<string, AnyFn>) {
    this.#endpoint = endpoint;
    this.#api = api;
    endpoint.addEventListener('message', this.#onMessage);
    endpoint.start?.();
  }

  call(method: string, rawArgs: unknown[]): Promise<unknown> {
    if (this.#disposed) return Promise.reject(new Error('Remote proxy is disposed'));
    const id = this.#nextCall++;
    const owner = `out:${id}`;
    const { value: args, signals, transferables } = this.#encode(rawArgs, owner);
    for (const s of signals) {
      if (s.aborted) {
        this.#callbacks.delete(owner);
        return Promise.reject(s.reason ?? abortError());
      }
    }
    return new Promise((resolve, reject) => {
      const listeners: Array<[AbortSignal, () => void]> = signals.map((s, index) => {
        const onAbort = () => {
          const p = this.#pending.get(id);
          if (!p) return;
          this.#pending.delete(id);
          p.cleanup();
          this.#post({ t: 'abort', id, index, reason: cloneableReason(s.reason) } satisfies AbortMsg);
          reject(s.reason ?? abortError());
        };
        s.addEventListener('abort', onAbort, { once: true });
        return [s, onAbort];
      });
      const cleanup = () => {
        for (const [s, l] of listeners) s.removeEventListener('abort', l);
        this.#callbacks.delete(owner);
      };
      this.#pending.set(id, { resolve, reject, cleanup });
      try {
        this.#post(
          { t: 'call', id, method, args: args as unknown[], signals: signals.length } satisfies CallMsg,
          transferables,
        );
      } catch (err) {
        this.#pending.delete(id);
        cleanup();
        reject(err);
      }
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#endpoint.removeEventListener('message', this.#onMessage);
    for (const [id, p] of this.#pending) {
      this.#pending.delete(id);
      p.cleanup();
      p.reject(new Error('Remote proxy is disposed'));
    }
    for (const [id, p] of this.#cbPending) {
      this.#cbPending.delete(id);
      p.reject(new Error('Remote proxy is disposed'));
    }
    this.#callbacks.clear();
  }

  #post(msg: Msg, transferables?: Transferable[]): void {
    this.#endpoint.postMessage(msg, transferables && transferables.length > 0 ? transferables : undefined);
  }

  /** Replaces signals and callback markers with wire refs, collecting transfer lists, recursively. */
  #encode(root: unknown, owner: string): Encoded {
    const signals: AbortSignal[] = [];
    const transferables: Transferable[] = [];
    const registry = () => {
      let m = this.#callbacks.get(owner);
      if (!m) {
        m = new Map();
        this.#callbacks.set(owner, m);
      }
      return m;
    };
    const walk = (v: unknown): unknown => {
      if (v instanceof AbortSignal)
        return { __sk: 'signal', index: signals.push(v) - 1 } satisfies SignalMarker;
      if (isCallbackMarker(v)) {
        const cbId = this.#nextCb++;
        registry().set(cbId, v[CALLBACK]);
        return { __sk: 'callback', owner, cbId } satisfies CallbackRef;
      }
      if (typeof v !== 'object' || v === null) return v;
      const list = transferLists.get(v);
      if (list) transferables.push(...list);
      if (Array.isArray(v)) {
        let copy: unknown[] | undefined;
        v.forEach((item, i) => {
          const enc = walk(item);
          if (enc !== item) {
            copy ??= [...v];
            copy[i] = enc;
          }
        });
        return copy ?? v;
      }
      if (isPlainObject(v)) {
        let copy: Record<string, unknown> | undefined;
        for (const [k, item] of Object.entries(v)) {
          const enc = walk(item);
          if (enc !== item) {
            copy ??= { ...v };
            copy[k] = enc;
          }
        }
        return copy ?? v;
      }
      return v;
    };
    return { value: walk(root), signals, transferables };
  }

  /** Turns wire refs back into live signals and callable proxies, recursively. */
  #decode(root: unknown, signals: AbortSignal[], owner: string): unknown {
    const walk = (v: unknown): unknown => {
      if (isSignalMarker(v)) return signals[v.index];
      if (isCallbackRef(v)) return this.#remoteCallback(v, owner);
      if (typeof v !== 'object' || v === null) return v;
      if (Array.isArray(v)) {
        let copy: unknown[] | undefined;
        v.forEach((item, i) => {
          const dec = walk(item);
          if (dec !== item) {
            copy ??= [...v];
            copy[i] = dec;
          }
        });
        return copy ?? v;
      }
      if (isPlainObject(v)) {
        let copy: Record<string, unknown> | undefined;
        for (const [k, item] of Object.entries(v)) {
          const dec = walk(item);
          if (dec !== item) {
            copy ??= { ...v };
            copy[k] = dec;
          }
        }
        return copy ?? v;
      }
      return v;
    };
    return walk(root);
  }

  /** A local async function that invokes the other side's callback `ref`. Nested callbacks it sends belong to `owner`. */
  #remoteCallback(ref: CallbackRef, owner: string): AnyFn {
    return (...rawArgs: unknown[]) => {
      const p = new Promise((resolve, reject) => {
        const callId = this.#nextCbCall++;
        const { value: args, transferables } = this.#encode(rawArgs, owner);
        this.#cbPending.set(callId, { resolve, reject });
        try {
          this.#post(
            { t: 'cb', owner: ref.owner, cbId: ref.cbId, callId, args: args as unknown[] } satisfies CbMsg,
            transferables,
          );
        } catch (err) {
          this.#cbPending.delete(callId);
          reject(err);
        }
      });
      // Fire-and-forget callbacks (progress reports) must not surface as unhandled rejections on dispose.
      p.catch(() => {});
      return p;
    };
  }

  async #handle(msg: Msg): Promise<void> {
    switch (msg.t) {
      case 'call':
        return this.#execute(msg);
      case 'abort': {
        const ctrl = this.#running.get(msg.id)?.[msg.index];
        ctrl?.abort(
          isSerializedError(msg.reason) ? deserializeError(msg.reason) : (msg.reason ?? abortError()),
        );
        return;
      }
      case 'ok':
      case 'err': {
        const p = this.#pending.get(msg.id);
        if (!p) return;
        this.#pending.delete(msg.id);
        p.cleanup();
        if (msg.t === 'ok') p.resolve(this.#decode(msg.value, [], `out:${msg.id}`));
        else p.reject(deserializeError(msg.error));
        return;
      }
      case 'cb': {
        const fn = this.#callbacks.get(msg.owner)?.get(msg.cbId);
        if (!fn) return;
        try {
          const args = this.#decode(msg.args, [], msg.owner) as unknown[];
          const value: unknown = await fn(...args);
          const { value: encoded, transferables } = this.#encode(value, msg.owner);
          this.#post({ t: 'cbr', callId: msg.callId, value: encoded } satisfies CbResultMsg, transferables);
        } catch (err) {
          this.#post({ t: 'cbr', callId: msg.callId, error: serializeError(err) } satisfies CbResultMsg);
        }
        return;
      }
      case 'cbr': {
        const p = this.#cbPending.get(msg.callId);
        if (!p) return;
        this.#cbPending.delete(msg.callId);
        if (msg.error) p.reject(deserializeError(msg.error));
        else p.resolve(this.#decode(msg.value, [], ''));
        return;
      }
    }
  }

  async #execute(msg: CallMsg): Promise<void> {
    const owner = `in:${msg.id}`;
    const controllers = Array.from({ length: msg.signals }, () => new AbortController());
    this.#running.set(msg.id, controllers);
    try {
      const fn = this.#api?.[msg.method];
      if (typeof fn !== 'function') throw new TypeError(`Unknown remote method: ${msg.method}`);
      const args = this.#decode(
        msg.args,
        controllers.map(c => c.signal),
        owner,
      ) as unknown[];
      const value: unknown = await fn(...args);
      const { value: encoded, transferables } = this.#encode(value, owner);
      try {
        this.#post({ t: 'ok', id: msg.id, value: encoded } satisfies OkMsg, transferables);
      } catch (err) {
        this.#post({ t: 'err', id: msg.id, error: serializeError(err) } satisfies ErrMsg);
      }
    } catch (err) {
      this.#post({ t: 'err', id: msg.id, error: serializeError(err) } satisfies ErrMsg);
    } finally {
      this.#running.delete(msg.id);
      this.#callbacks.delete(owner);
    }
  }
}

// ---- public API ---------------------------------------------------------------------------

/**
 * Worker side. Exposes `api` on the endpoint (defaults to the worker global nursery).
 * AbortSignals arrive live; callback() arguments arrive as async functions; transfer() is honoured
 * for arguments, return values and callback traffic, at any nesting depth.
 */
export function expose(
  api: Record<string, AnyFn>,
  endpoint: Endpoint = globalThis as unknown as Endpoint,
): () => void {
  const peer = new Peer(endpoint, api);
  return () => peer.dispose();
}

/**
 * Main-thread side. Every method of T becomes an async function. AbortSignals in the arguments
 * are forwarded and abort the remote task; callback() arguments are invoked back here;
 * transfer() moves buffers instead of copying.
 */
export function wrap<T>(endpoint: Endpoint): Remote<T> {
  const peer = new Peer(endpoint);
  return new Proxy({} as Remote<T>, {
    get(_target, prop) {
      if (prop === Symbol.dispose) return () => peer.dispose();
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      return (...args: unknown[]) => peer.call(prop, args);
    },
  });
}

// ---- pool ---------------------------------------------------------------------------------

export interface PoolOptions {
  /** Max workers, created lazily. Default navigator.hardwareConcurrency or 4. */
  size?: number;
  /** Aborts running calls and rejects queued ones. */
  signal?: MaybeSignal;
}

/** A worker-like endpoint the pool can terminate. */
export interface PoolEndpoint extends Endpoint {
  terminate?(): void;
  close?(): void;
}

export interface Pool<T> extends Disposable {
  /** Remote API: every call is queued and dispatched to the least busy worker. */
  readonly api: Remote<T>;
  /** Runs `fn` with a remote of a specific worker, under the pool's concurrency limit. */
  run<R>(fn: (remote: Remote<T>, signal: AbortSignal) => Promise<R>, signal?: MaybeSignal): Promise<R>;
  /** Workers created so far. */
  readonly size: number;
  /** Calls currently executing. */
  readonly pending: number;
  /** Calls waiting for a free worker. */
  readonly queued: number;
  dispose(): void;
}

function signalOf(args: unknown[]): AbortSignal | undefined {
  const found: AbortSignal[] = [];
  const walk = (v: unknown) => {
    if (v instanceof AbortSignal) found.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (isPlainObject(v)) Object.values(v).forEach(walk);
  };
  args.forEach(walk);
  return found.length === 0 ? undefined : found.length === 1 ? found[0] : anySignal(found);
}

/**
 * Pool of workers behind one Remote<T>. Workers are created lazily from `factory`;
 * calls queue when every worker is busy; an AbortSignal in the arguments cancels a queued
 * call and, once running, the remote task.
 */
export function createPool<T>(factory: () => PoolEndpoint, opts: PoolOptions = {}): Pool<T> {
  const size = Math.max(1, opts.size ?? (globalThis.navigator?.hardwareConcurrency || 4));
  const workers: Array<{ endpoint: PoolEndpoint; remote: Remote<T>; active: number }> = [];
  const queue = new Queue({ concurrency: size, signal: opts.signal });
  let disposed = false;

  const acquire = () => {
    let best = workers.length > 0 ? workers.reduce((a, b) => (b.active < a.active ? b : a)) : undefined;
    if ((!best || best.active > 0) && workers.length < size) {
      const endpoint = factory();
      best = { endpoint, remote: wrap<T>(endpoint), active: 0 };
      workers.push(best);
    }
    return best!;
  };

  const run = <R>(
    fn: (remote: Remote<T>, signal: AbortSignal) => Promise<R>,
    signal?: MaybeSignal,
  ): Promise<R> => {
    if (disposed) return Promise.reject(new Error('Worker pool is disposed'));
    return queue.add(async sig => {
      const w = acquire();
      w.active++;
      try {
        return await fn(w.remote, sig);
      } finally {
        w.active--;
      }
    }, signal);
  };

  const api = new Proxy({} as Remote<T>, {
    get(_t, prop) {
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      return (...args: unknown[]) =>
        run(
          remote => (remote as unknown as Record<string, AnyFn>)[prop]!(...args) as Promise<unknown>,
          signalOf(args),
        );
    },
  });

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    queue.clear();
    for (const w of workers) {
      w.remote[Symbol.dispose]();
      if (w.endpoint.terminate) w.endpoint.terminate();
      else w.endpoint.close?.();
    }
    workers.length = 0;
  };

  return {
    api,
    run,
    get size() {
      return workers.length;
    },
    get pending() {
      return queue.pending;
    },
    get queued() {
      return queue.size;
    },
    dispose,
    [Symbol.dispose]: dispose,
  };
}
