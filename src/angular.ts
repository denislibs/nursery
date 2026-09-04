/// <reference lib="dom" />
/** Angular adapters. Import from 'scopekit/angular'; requires @angular/core >= 17 (signals, DestroyRef). */
import { DestroyRef, effect, inject, signal, type Signal } from '@angular/core';
import { Scope, type ScopeOptions } from './scope.js';
import { latest } from './latest.js';
import { isAbort } from './signal.js';
import { on, type OnOptions } from './events.js';
import { wrap, type Remote } from './worker.js';

/** A scope that closes when the current injection context is destroyed. Call in a constructor or field initializer. */
export function injectScope(opts?: ScopeOptions): Scope {
  const scope = new Scope(opts);
  inject(DestroyRef).onDestroy(() => {
    void scope.close();
  });
  return scope;
}

/**
 * Angular effect() with a Scope. Signals read in the synchronous part of `fn` are tracked;
 * each re-run closes the previous scope.
 */
export function scopedEffect(fn: (scope: Scope) => void | Promise<void>, opts?: ScopeOptions): void {
  effect(onCleanup => {
    const scope = new Scope(opts);
    onCleanup(() => {
      void scope.close();
    });
    void scope.spawn((_sig, s) => Promise.resolve(fn(s)), { name: 'effect' });
  });
}

export interface InjectAsync<T> {
  data: Signal<T | null>;
  error: Signal<unknown>;
  loading: Signal<boolean>;
}

/** Loads data in a scoped effect. Results of a cancelled run never reach the signals. */
export function injectAsync<T>(fn: (scope: Scope) => Promise<T>, opts?: ScopeOptions): InjectAsync<T> {
  const data = signal<T | null>(null);
  const error = signal<unknown>(null);
  const loading = signal(false);
  scopedEffect(async scope => {
    loading.set(true);
    error.set(null);
    try {
      const value = await fn(scope);
      if (!scope.signal.aborted) {
        data.set(value);
        loading.set(false);
      }
    } catch (err) {
      if (!isAbort(err)) {
        error.set(err);
        loading.set(false);
      }
    }
  }, opts);
  return { data: data.asReadonly(), error: error.asReadonly(), loading: loading.asReadonly() };
}

export interface InjectLatest<A, R> {
  run: (arg: A, signal?: AbortSignal) => Promise<R>;
  pending: Signal<boolean>;
  cancel: () => void;
}

/** latest() bound to the injection context: destruction cancels the in-flight call. */
export function injectLatest<A, R>(fn: (arg: A, signal: AbortSignal) => Promise<R>): InjectLatest<A, R> {
  const wrapped = latest(fn);
  const pending = signal(false);
  inject(DestroyRef).onDestroy(() => wrapped.cancel());
  const run = async (arg: A, sig?: AbortSignal) => {
    pending.set(true);
    try {
      return await wrapped(arg, sig);
    } finally {
      if (!wrapped.pending) pending.set(false);
    }
  };
  const cancel = () => {
    wrapped.cancel();
    pending.set(false);
  };
  return { run, pending: pending.asReadonly(), cancel };
}

/** Consumes DOM events in a scoped loop for the lifetime of the injection context. */
export function injectEventStream<E extends Event = Event>(
  target: EventTarget,
  type: string,
  handler: (event: E, scope: Scope) => void | Promise<void>,
  opts?: Omit<OnOptions, 'signal'>,
): void {
  const scope = injectScope({ name: `on:${type}` });
  void scope.spawn(async (sig, s) => {
    for await (const e of on<E>(target, type, { ...opts, signal: sig })) await handler(e, s);
  });
}

/** Creates the worker, wraps it, terminates it on destroy. */
export function injectWorker<T>(factory: () => Worker): Remote<T> {
  const worker = factory();
  const api = wrap<T>(worker);
  inject(DestroyRef).onDestroy(() => {
    api[Symbol.dispose]();
    worker.terminate();
  });
  return api;
}
