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
const CALLBACK = Symbol('scopekit.callback');
interface CallbackMarker {
  [CALLBACK]: AnyFn;
}

/**
 * Marks `value` (an argument or a return value) so the listed buffers are moved instead of copied.
 *   remote.process(transfer(buf, [buf]))
 *   return transfer({ pixels }, [pixels.buffer])
 */
export function transfer<T extends object>(value: T, transferables: Transferable[]): T {
  transferLists.set(value, transferables);
  return value;
}

/**
 * Wraps a function so it can be passed to the other side. Calls made there are forwarded back
 * and resolve with the return value. Valid for the duration of the remote call that carried it.
 */
export function callback<F extends AnyFn>(fn: F): F {
  return { [CALLBACK]: fn } as unknown as F;
}

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
  cbId: number;
}

type CallMsg = { t: 'call'; id: number; method: string; args: unknown[]; signals: number };
type AbortMsg = { t: 'abort'; id: number; index: number; reason: unknown };
type OkMsg = { t: 'ok'; id: number; value: unknown };
type ErrMsg = { t: 'err'; id: number; error: SerializedError };
/** Worker → caller: invoke callback cbId that travelled with call id. */
type CbMsg = { t: 'cb'; id: number; cbId: number; callId: number; args: unknown[] };
/** Caller → worker: result of a callback invocation. */
type CbResultMsg = { t: 'cbr'; id: number; callId: number; value?: unknown; error?: SerializedError };
type Msg = CallMsg | AbortMsg | OkMsg | ErrMsg | CbMsg | CbResultMsg;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

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
const isCallbackMarker = (v: unknown): v is CallbackMarker => typeof v === 'object' && v !== null && CALLBACK in v;

interface Encoded {
  args: unknown[];
  signals: AbortSignal[];
  callbacks: AnyFn[];
  transferables: Transferable[];
}

/** Replaces AbortSignals and callbacks (top-level args and top-level fields of plain-object args) with markers. */
function encodeArgs(rawArgs: unknown[]): Encoded {
  const signals: AbortSignal[] = [];
  const callbacks: AnyFn[] = [];
  const transferables: Transferable[] = [];
  const encodeValue = (v: unknown): unknown => {
    if (v instanceof AbortSignal) return { __sk: 'signal', index: signals.push(v) - 1 } satisfies SignalMarker;
    if (isCallbackMarker(v)) return { __sk: 'callback', cbId: callbacks.push(v[CALLBACK]) - 1 } satisfies CallbackRef;
    return v;
  };
  const args = rawArgs.map(arg => {
    if (typeof arg === 'object' && arg !== null) {
      const list = transferLists.get(arg);
      if (list) transferables.push(...list);
    }
    const direct = encodeValue(arg);
    if (direct !== arg) return direct;
    if (isPlainObject(arg)) {
      let copy: Record<string, unknown> | undefined;
      for (const [k, v] of Object.entries(arg)) {
        const enc = encodeValue(v);
        if (enc !== v) {
          copy ??= { ...arg };
          copy[k] = enc;
        }
      }
      return copy ?? arg;
    }
    return arg;
  });
  return { args, signals, callbacks, transferables };
}

function decodeArgs(args: unknown[], signals: AbortSignal[], makeCallback: (cbId: number) => AnyFn): unknown[] {
  const decodeValue = (v: unknown): unknown => {
    if (isSignalMarker(v)) return signals[v.index];
    if (isCallbackRef(v)) return makeCallback(v.cbId);
    return v;
  };
  return args.map(arg => {
    const direct = decodeValue(arg);
    if (direct !== arg) return direct;
    if (isPlainObject(arg)) {
      let copy: Record<string, unknown> | undefined;
      for (const [k, v] of Object.entries(arg)) {
        const dec = decodeValue(v);
        if (dec !== v) {
          copy ??= { ...arg };
          copy[k] = dec;
        }
      }
      return copy ?? arg;
    }
    return arg;
  });
}

function cloneableReason(reason: unknown): unknown {
  if (reason instanceof Error) return serializeError(reason);
  if (reason === undefined || reason === null || typeof reason !== 'object') return reason;
  try {
    return JSON.parse(JSON.stringify(reason)) as unknown;
  } catch {
    return abortError().message;
  }
}

function transferOf(value: unknown): Transferable[] | undefined {
  return typeof value === 'object' && value !== null ? transferLists.get(value) : undefined;
}

/**
 * Worker side. Exposes `api` on the endpoint (defaults to the worker global scope).
 * AbortSignals arrive live; callback() arguments arrive as async functions; transfer() is honoured
 * for return values.
 */
export function expose(api: Record<string, AnyFn>, endpoint: Endpoint = globalThis as unknown as Endpoint): () => void {
  const running = new Map<number, AbortController[]>();
  const cbPending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  let cbCallCounter = 0;
  const post = (msg: OkMsg | ErrMsg, transferables?: Transferable[]) => {
    try {
      endpoint.postMessage(msg, transferables);
    } catch (err) {
      endpoint.postMessage({ t: 'err', id: msg.id, error: serializeError(err) } satisfies ErrMsg);
    }
  };
  const handle = async (ev: MessageEvent) => {
    const msg = ev.data as Msg;
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'abort') {
      const ctrl = running.get(msg.id)?.[msg.index];
      ctrl?.abort(isSerializedError(msg.reason) ? deserializeError(msg.reason) : (msg.reason ?? abortError()));
      return;
    }
    if (msg.t === 'cbr') {
      const p = cbPending.get(msg.callId);
      if (!p) return;
      cbPending.delete(msg.callId);
      if (msg.error) p.reject(deserializeError(msg.error));
      else p.resolve(msg.value);
      return;
    }
    if (msg.t !== 'call') return;
    const controllers = Array.from({ length: msg.signals }, () => new AbortController());
    running.set(msg.id, controllers);
    const makeCallback = (cbId: number): AnyFn => (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        const callId = ++cbCallCounter;
        cbPending.set(callId, { resolve, reject });
        endpoint.postMessage({ t: 'cb', id: msg.id, cbId, callId, args } satisfies CbMsg);
      });
    try {
      const fn = api[msg.method];
      if (typeof fn !== 'function') throw new TypeError(`Unknown remote method: ${msg.method}`);
      const args = decodeArgs(msg.args, controllers.map(c => c.signal), makeCallback);
      const value: unknown = await fn(...args);
      post({ t: 'ok', id: msg.id, value }, transferOf(value));
    } catch (err) {
      post({ t: 'err', id: msg.id, error: serializeError(err) });
    } finally {
      running.delete(msg.id);
    }
  };
  const onMessage = (ev: MessageEvent) => {
    void handle(ev);
  };
  endpoint.addEventListener('message', onMessage);
  endpoint.start?.();
  return () => endpoint.removeEventListener('message', onMessage);
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  cleanup: () => void;
  callbacks: AnyFn[];
}

/**
 * Main-thread side. Every method of T becomes an async function. AbortSignals in the arguments
 * (positional, or as a field of an options object) are forwarded and abort the remote task;
 * callback() arguments are invoked back here; transfer() moves buffers instead of copying.
 */
export function wrap<T>(endpoint: Endpoint): Remote<T> {
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let disposed = false;

  const onMessage = (ev: MessageEvent) => {
    const msg = ev.data as Msg;
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'cb') {
      const p = pending.get(msg.id);
      const fn = p?.callbacks[msg.cbId];
      if (!fn) return;
      Promise.resolve()
        .then(() => fn(...msg.args) as unknown)
        .then(
          value => endpoint.postMessage({ t: 'cbr', id: msg.id, callId: msg.callId, value } satisfies CbResultMsg),
          err => endpoint.postMessage({ t: 'cbr', id: msg.id, callId: msg.callId, error: serializeError(err) } satisfies CbResultMsg),
        );
      return;
    }
    if (msg.t !== 'ok' && msg.t !== 'err') return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    p.cleanup();
    if (msg.t === 'ok') p.resolve(msg.value);
    else p.reject(deserializeError(msg.error));
  };
  endpoint.addEventListener('message', onMessage);
  endpoint.start?.();

  const call = (method: string, rawArgs: unknown[]): Promise<unknown> => {
    if (disposed) return Promise.reject(new Error('Remote proxy is disposed'));
    const { args, signals, callbacks, transferables } = encodeArgs(rawArgs);
    for (const s of signals) if (s.aborted) return Promise.reject(s.reason ?? abortError());
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const listeners: Array<[MaybeSignal, () => void]> = signals.map((s, index) => {
        const onAbort = () => {
          const p = pending.get(id);
          if (!p) return;
          pending.delete(id);
          p.cleanup();
          endpoint.postMessage({ t: 'abort', id, index, reason: cloneableReason(s.reason) } satisfies AbortMsg);
          reject(s.reason ?? abortError());
        };
        s.addEventListener('abort', onAbort, { once: true });
        return [s, onAbort];
      });
      const cleanup = () => {
        for (const [s, l] of listeners) s?.removeEventListener('abort', l);
      };
      pending.set(id, { resolve, reject, cleanup, callbacks });
      try {
        endpoint.postMessage({ t: 'call', id, method, args, signals: signals.length } satisfies CallMsg, transferables);
      } catch (err) {
        pending.delete(id);
        cleanup();
        reject(err);
      }
    });
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    endpoint.removeEventListener('message', onMessage);
    for (const [id, p] of pending) {
      pending.delete(id);
      p.cleanup();
      p.reject(new Error('Remote proxy is disposed'));
    }
  };

  return new Proxy({} as Remote<T>, {
    get(_target, prop) {
      if (prop === Symbol.dispose) return dispose;
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      return (...args: unknown[]) => call(prop, args);
    },
  });
}

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
  for (const a of args) {
    if (a instanceof AbortSignal) found.push(a);
    else if (isPlainObject(a)) for (const v of Object.values(a)) if (v instanceof AbortSignal) found.push(v);
  }
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

  const run = <R>(fn: (remote: Remote<T>, signal: AbortSignal) => Promise<R>, signal?: MaybeSignal): Promise<R> => {
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
        run(remote => (remote as unknown as Record<string, AnyFn>)[prop]!(...args) as Promise<unknown>, signalOf(args));
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
