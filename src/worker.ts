import { abortError, type MaybeSignal } from './signal.js';

/** Anything with postMessage + message events: Worker, MessagePort, DedicatedWorkerGlobalScope. */
export interface Endpoint {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
  start?(): void;
}

type AnyFn = (...args: never[]) => unknown;

export type Remote<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
} & Disposable;

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

type CallMsg = { t: 'call'; id: number; method: string; args: unknown[]; signals: number };
type AbortMsg = { t: 'abort'; id: number; index: number; reason: unknown };
type OkMsg = { t: 'ok'; id: number; value: unknown };
type ErrMsg = { t: 'err'; id: number; error: SerializedError };
type Msg = CallMsg | AbortMsg | OkMsg | ErrMsg;

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

/** Replaces AbortSignals (top-level args and top-level fields of plain-object args) with markers. */
function extractSignals(args: unknown[]): { args: unknown[]; signals: AbortSignal[] } {
  const signals: AbortSignal[] = [];
  const mark = (s: AbortSignal): SignalMarker => ({ __sk: 'signal', index: signals.push(s) - 1 });
  const out = args.map(arg => {
    if (arg instanceof AbortSignal) return mark(arg);
    if (isPlainObject(arg)) {
      let copy: Record<string, unknown> | undefined;
      for (const [k, v] of Object.entries(arg)) {
        if (v instanceof AbortSignal) {
          copy ??= { ...arg };
          copy[k] = mark(v);
        }
      }
      return copy ?? arg;
    }
    return arg;
  });
  return { args: out, signals };
}

function injectSignals(args: unknown[], signals: AbortSignal[]): unknown[] {
  const resolve = (v: unknown) => (isSignalMarker(v) ? signals[v.index] : v);
  return args.map(arg => {
    if (isSignalMarker(arg)) return resolve(arg);
    if (isPlainObject(arg)) {
      let copy: Record<string, unknown> | undefined;
      for (const [k, v] of Object.entries(arg)) {
        if (isSignalMarker(v)) {
          copy ??= { ...arg };
          copy[k] = resolve(v);
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
  return String(reason);
}

/**
 * Worker side. Exposes `api` on the endpoint (defaults to the worker global scope).
 * Every AbortSignal the caller passes arrives as a live AbortSignal here.
 */
export function expose(api: Record<string, AnyFn>, endpoint: Endpoint = globalThis as unknown as Endpoint): () => void {
  const running = new Map<number, AbortController[]>();
  const post = (msg: OkMsg | ErrMsg) => {
    try {
      endpoint.postMessage(msg);
    } catch (err) {
      endpoint.postMessage({ t: 'err', id: msg.id, error: serializeError(err) } satisfies ErrMsg);
    }
  };
  const onMessage = async (ev: MessageEvent) => {
    const msg = ev.data as Msg;
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'abort') {
      const ctrl = running.get(msg.id)?.[msg.index];
      ctrl?.abort(isSerializedError(msg.reason) ? deserializeError(msg.reason) : (msg.reason ?? abortError()));
      return;
    }
    if (msg.t !== 'call') return;
    const controllers = Array.from({ length: msg.signals }, () => new AbortController());
    running.set(msg.id, controllers);
    try {
      const fn = api[msg.method];
      if (typeof fn !== 'function') throw new TypeError(`Unknown remote method: ${msg.method}`);
      const args = injectSignals(msg.args, controllers.map(c => c.signal));
      const value = await (fn as (...a: unknown[]) => unknown)(...args);
      post({ t: 'ok', id: msg.id, value });
    } catch (err) {
      post({ t: 'err', id: msg.id, error: serializeError(err) });
    } finally {
      running.delete(msg.id);
    }
  };
  endpoint.addEventListener('message', onMessage);
  endpoint.start?.();
  return () => endpoint.removeEventListener('message', onMessage);
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  cleanup: () => void;
}

/**
 * Main-thread side. Every method of T becomes an async function; AbortSignals in the arguments
 * (positional, or as a field of an options object) are forwarded and abort the remote task.
 */
export function wrap<T>(endpoint: Endpoint): Remote<T> {
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let disposed = false;

  const onMessage = (ev: MessageEvent) => {
    const msg = ev.data as Msg;
    if (!msg || typeof msg !== 'object' || (msg.t !== 'ok' && msg.t !== 'err')) return;
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
    const { args, signals } = extractSignals(rawArgs);
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
      pending.set(id, { resolve, reject, cleanup });
      try {
        endpoint.postMessage({ t: 'call', id, method, args, signals: signals.length } satisfies CallMsg);
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
