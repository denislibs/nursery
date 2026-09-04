/// <reference lib="dom" />
/** Angular adapters. Import from 'nursery/angular'; requires @angular/core >= 17 (signals, DestroyRef). */
import { DestroyRef, effect, inject, signal, type Signal } from '@angular/core';
import { Nursery, type NurseryOptions } from '@nursery/core/nursery';
import { latest } from '@nursery/core/latest';
import { isAbort } from '@nursery/core/signal';
import { on, type OnOptions } from '@nursery/core/events';
import { wrap, type Remote } from '@nursery/core/worker';

/** A nursery that closes when the current injection context is destroyed. Call in a constructor or field initializer. */
export function injectNursery(opts?: NurseryOptions): Nursery {
  const nursery = new Nursery(opts);
  inject(DestroyRef).onDestroy(() => {
    void nursery.close();
  });
  return nursery;
}

/**
 * Angular effect() with a Nursery. Signals read in the synchronous part of `fn` are tracked;
 * each re-run closes the previous nursery.
 */
export function nurseryEffect(fn: (nursery: Nursery) => void | Promise<void>, opts?: NurseryOptions): void {
  effect(onCleanup => {
    const nursery = new Nursery(opts);
    onCleanup(() => {
      void nursery.close();
    });
    void nursery.spawn((_sig, s) => Promise.resolve(fn(s)), { name: 'effect' });
  });
}

export interface InjectAsync<T> {
  data: Signal<T | null>;
  error: Signal<unknown>;
  loading: Signal<boolean>;
}

/** Loads data in a scoped effect. Results of a cancelled run never reach the signals. */
export function injectAsync<T>(fn: (nursery: Nursery) => Promise<T>, opts?: NurseryOptions): InjectAsync<T> {
  const data = signal<T | null>(null);
  const error = signal<unknown>(null);
  const loading = signal(false);
  nurseryEffect(async nursery => {
    loading.set(true);
    error.set(null);
    try {
      const value = await fn(nursery);
      if (!nursery.signal.aborted) {
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
  handler: (event: E, nursery: Nursery) => void | Promise<void>,
  opts?: Omit<OnOptions, 'signal'>,
): void {
  const nursery = injectNursery({ name: `on:${type}` });
  void nursery.spawn(async (sig, s) => {
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
