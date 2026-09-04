/// <reference lib="dom" />
/** SolidJS adapters. Import from 'scopekit/solid'; requires solid-js >= 1.7. */
import { createEffect, createSignal, onCleanup, type Accessor } from 'solid-js';
import { Scope, type ScopeOptions } from './scope.js';
import { latest } from './latest.js';
import { isAbort } from './signal.js';
import { on, type OnOptions } from './events.js';
import { wrap, type Remote } from './worker.js';

/** A scope that closes when the owning reactive root is disposed. */
export function createScope(opts?: ScopeOptions): Scope {
  const scope = new Scope(opts);
  onCleanup(() => {
    void scope.close();
  });
  return scope;
}

/**
 * createEffect with a Scope. Signals read in the synchronous part of `effect` are tracked;
 * each re-run closes the previous scope.
 */
export function scopedEffect(effect: (scope: Scope) => void | Promise<void>, opts?: ScopeOptions): void {
  createEffect(() => {
    const scope = new Scope(opts);
    onCleanup(() => {
      void scope.close();
    });
    void scope.spawn((_sig, s) => Promise.resolve(effect(s)), { name: 'effect' });
  });
}

export interface CreateAsync<T> {
  data: Accessor<T | null>;
  error: Accessor<unknown>;
  loading: Accessor<boolean>;
}

/** Loads data in a scoped effect. Results of a cancelled run never reach the signals. */
export function createAsync<T>(fn: (scope: Scope) => Promise<T>, opts?: ScopeOptions): CreateAsync<T> {
  const [data, setData] = createSignal<T | null>(null);
  const [error, setError] = createSignal<unknown>(null);
  const [loading, setLoading] = createSignal(false);
  scopedEffect(async scope => {
    setLoading(true);
    setError(null);
    try {
      const value = await fn(scope);
      if (!scope.signal.aborted) {
        setData(() => value);
        setLoading(false);
      }
    } catch (err) {
      if (!isAbort(err)) {
        setError(() => err);
        setLoading(false);
      }
    }
  }, opts);
  return { data, error, loading };
}

export interface CreateLatest<A, R> {
  run: (arg: A, signal?: AbortSignal) => Promise<R>;
  pending: Accessor<boolean>;
  cancel: () => void;
}

/** latest() bound to the reactive root: disposal cancels the in-flight call. */
export function createLatest<A, R>(fn: (arg: A, signal: AbortSignal) => Promise<R>): CreateLatest<A, R> {
  const wrapped = latest(fn);
  const [pending, setPending] = createSignal(false);
  onCleanup(() => wrapped.cancel());
  const run = async (arg: A, signal?: AbortSignal) => {
    setPending(true);
    try {
      return await wrapped(arg, signal);
    } finally {
      if (!wrapped.pending) setPending(false);
    }
  };
  const cancel = () => {
    wrapped.cancel();
    setPending(false);
  };
  return { run, pending, cancel };
}

/** Consumes DOM events in a scoped loop for the lifetime of the reactive root. */
export function createEventStream<E extends Event = Event>(
  target: EventTarget,
  type: string,
  handler: (event: E, scope: Scope) => void | Promise<void>,
  opts?: Omit<OnOptions, 'signal'>,
): void {
  const scope = createScope({ name: `on:${type}` });
  void scope.spawn(async (sig, s) => {
    for await (const e of on<E>(target, type, { ...opts, signal: sig })) await handler(e, s);
  });
}

/** Creates the worker, wraps it, terminates it on disposal. */
export function createWorker<T>(factory: () => Worker): Remote<T> {
  const worker = factory();
  const api = wrap<T>(worker);
  onCleanup(() => {
    api[Symbol.dispose]();
    worker.terminate();
  });
  return api;
}
