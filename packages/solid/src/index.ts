/// <reference lib="dom" />
/** SolidJS adapters. Import from 'nursery/solid'; requires solid-js >= 1.7. */
import { createEffect, createSignal, onCleanup, type Accessor } from 'solid-js';
import { Nursery, type NurseryOptions } from '@nursery/core/nursery';
import { latest } from '@nursery/core/latest';
import { isAbort } from '@nursery/core/signal';
import { on, type OnOptions } from '@nursery/core/events';
import { wrap, type Remote } from '@nursery/core/worker';

/** A nursery that closes when the owning reactive root is disposed. */
export function createNursery(opts?: NurseryOptions): Nursery {
  const nursery = new Nursery(opts);
  onCleanup(() => {
    void nursery.close();
  });
  return nursery;
}

/**
 * createEffect with a Nursery. Signals read in the synchronous part of `effect` are tracked;
 * each re-run closes the previous nursery.
 */
export function nurseryEffect(
  effect: (nursery: Nursery) => void | Promise<void>,
  opts?: NurseryOptions,
): void {
  createEffect(() => {
    const nursery = new Nursery(opts);
    onCleanup(() => {
      void nursery.close();
    });
    void nursery.spawn((_sig, s) => Promise.resolve(effect(s)), { name: 'effect' });
  });
}

export interface CreateAsync<T> {
  data: Accessor<T | null>;
  error: Accessor<unknown>;
  loading: Accessor<boolean>;
}

/** Loads data in a scoped effect. Results of a cancelled run never reach the signals. */
export function createAsync<T>(fn: (nursery: Nursery) => Promise<T>, opts?: NurseryOptions): CreateAsync<T> {
  const [data, setData] = createSignal<T | null>(null);
  const [error, setError] = createSignal<unknown>(null);
  const [loading, setLoading] = createSignal(false);
  nurseryEffect(async nursery => {
    setLoading(true);
    setError(null);
    try {
      const value = await fn(nursery);
      if (!nursery.signal.aborted) {
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
  handler: (event: E, nursery: Nursery) => void | Promise<void>,
  opts?: Omit<OnOptions, 'signal'>,
): void {
  const nursery = createNursery({ name: `on:${type}` });
  void nursery.spawn(async (sig, s) => {
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
