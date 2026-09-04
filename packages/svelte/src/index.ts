/// <reference lib="dom" />
/**
 * Svelte 5 adapters. Import from 'nursery/svelte'; requires svelte >= 5.
 * Runes are compiler features, so the reactive re-run stays in your `$effect`; these helpers
 * give it a Nursery and tie lifetimes to the component.
 */
import { onDestroy } from 'svelte';
import { writable, type Readable } from 'svelte/store';
import { isAbort } from '@nursery/core/signal';
import { Nursery, type NurseryOptions } from '@nursery/core/nursery';
import { latest } from '@nursery/core/latest';
import { on, type OnOptions } from '@nursery/core/events';
import { wrap, type Remote } from '@nursery/core/worker';

/** A nursery that closes when the component is destroyed. */
export function useNursery(opts?: NurseryOptions): Nursery {
  const nursery = new Nursery(opts);
  onDestroy(() => {
    void nursery.close();
  });
  return nursery;
}

/**
 * Runs `effect` with a fresh Nursery and returns the cleanup that closes it. Use inside $effect:
 *   $effect(() => nurseryEffect(async nursery => { user = await load(id, nursery) }));
 * Read reactive state synchronously, before the first await, so the effect tracks it.
 */
export function nurseryEffect(
  effect: (nursery: Nursery) => void | Promise<void>,
  opts?: NurseryOptions,
): () => void {
  const nursery = new Nursery(opts);
  void nursery.spawn((_sig, s) => Promise.resolve(effect(s)), { name: 'effect' });
  return () => {
    void nursery.close();
  };
}

export interface UseLatest<A, R> {
  run: (arg: A, signal?: AbortSignal) => Promise<R>;
  /** Store: true while a call is in flight. */
  pending: Readable<boolean>;
  cancel: () => void;
}

/** latest() bound to the component: destruction cancels the in-flight call. */
export function useLatest<A, R>(fn: (arg: A, signal: AbortSignal) => Promise<R>): UseLatest<A, R> {
  const wrapped = latest(fn);
  const pending = writable(false);
  onDestroy(() => wrapped.cancel());
  const run = async (arg: A, signal?: AbortSignal) => {
    pending.set(true);
    try {
      return await wrapped(arg, signal);
    } finally {
      if (!wrapped.pending) pending.set(false);
    }
  };
  const cancel = () => {
    wrapped.cancel();
    pending.set(false);
  };
  return { run, pending: { subscribe: pending.subscribe }, cancel };
}

/**
 * Consumes DOM events in a scoped loop and returns the cleanup. Use inside $effect so it
 * re-binds when the element changes:
 *   $effect(() => eventStream(button, 'click', e => ...));
 */
export function eventStream<E extends Event = Event>(
  target: EventTarget | null | undefined,
  type: string,
  handler: (event: E, nursery: Nursery) => void | Promise<void>,
  opts?: Omit<OnOptions, 'signal'>,
): () => void {
  if (!target) return () => {};
  const nursery = new Nursery({ name: `on:${type}` });
  void nursery.spawn(async (sig, s) => {
    for await (const e of on<E>(target, type, { ...opts, signal: sig })) await handler(e, s);
  });
  return () => {
    void nursery.close();
  };
}

/** Creates the worker, wraps it, terminates it when the component is destroyed. */
export function useWorker<T>(factory: () => Worker): Remote<T> {
  const worker = factory();
  const api = wrap<T>(worker);
  onDestroy(() => {
    api[Symbol.dispose]();
    worker.terminate();
  });
  return api;
}

export type AsyncStoreState<T> =
  | { status: 'loading' }
  | { status: 'success'; data: T }
  | { status: 'error'; error: unknown };

export interface AsyncStore<T> extends Readable<AsyncStoreState<T>> {
  /** Cancels the in-flight run (if any) and starts a new one. Call it from $effect to react to state. */
  refresh(): void;
  /** The component-lifetime nursery every run is a child of. */
  readonly nursery: Nursery;
}

/**
 * Store-based async state for Svelte, since runes are compile-time and cannot live in a library.
 * Runs `fn` once immediately; call `refresh()` inside `$effect` to re-run when reactive inputs change:
 *   const user = asyncStore(nursery => load(id, nursery));
 *   $effect(() => { void id; user.refresh(); });
 */
export function asyncStore<T>(fn: (nursery: Nursery) => Promise<T>, opts?: NurseryOptions): AsyncStore<T> {
  const parent = useNursery(opts);
  const store = writable<AsyncStoreState<T>>({ status: 'loading' });
  let current: Nursery | undefined;
  const refresh = () => {
    void current?.close();
    const run = parent.child({ name: 'asyncStore.run' });
    current = run;
    store.update(s => (s.status === 'loading' ? s : { status: 'loading' }));
    void run.spawn(async (_sig, s) => {
      try {
        const data = await fn(s);
        if (!s.signal.aborted) store.set({ status: 'success', data });
      } catch (error) {
        if (!isAbort(error)) store.set({ status: 'error', error });
      }
    });
  };
  refresh();
  return { subscribe: store.subscribe, refresh, nursery: parent };
}
