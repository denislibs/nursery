/**
 * Svelte 5 adapters. Import from 'scopekit/svelte'; requires svelte >= 5.
 * Runes are compiler features, so the reactive re-run stays in your `$effect`; these helpers
 * give it a Scope and tie lifetimes to the component.
 */
import { onDestroy } from 'svelte';
import { writable, type Readable } from 'svelte/store';
import { isAbort } from './signal.js';
import { Scope, type ScopeOptions } from './scope.js';
import { latest } from './latest.js';
import { on, type OnOptions } from './events.js';
import { wrap, type Remote } from './worker.js';

/** A scope that closes when the component is destroyed. */
export function useScope(opts?: ScopeOptions): Scope {
  const scope = new Scope(opts);
  onDestroy(() => {
    void scope.close();
  });
  return scope;
}

/**
 * Runs `effect` with a fresh Scope and returns the cleanup that closes it. Use inside $effect:
 *   $effect(() => scopedEffect(async scope => { user = await load(id, scope) }));
 * Read reactive state synchronously, before the first await, so the effect tracks it.
 */
export function scopedEffect(
  effect: (scope: Scope) => void | Promise<void>,
  opts?: ScopeOptions,
): () => void {
  const scope = new Scope(opts);
  void scope.spawn((_sig, s) => Promise.resolve(effect(s)), { name: 'effect' });
  return () => {
    void scope.close();
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
  handler: (event: E, scope: Scope) => void | Promise<void>,
  opts?: Omit<OnOptions, 'signal'>,
): () => void {
  if (!target) return () => {};
  const scope = new Scope({ name: `on:${type}` });
  void scope.spawn(async (sig, s) => {
    for await (const e of on<E>(target, type, { ...opts, signal: sig })) await handler(e, s);
  });
  return () => {
    void scope.close();
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
  /** The component-lifetime scope every run is a child of. */
  readonly scope: Scope;
}

/**
 * Store-based async state for Svelte, since runes are compile-time and cannot live in a library.
 * Runs `fn` once immediately; call `refresh()` inside `$effect` to re-run when reactive inputs change:
 *   const user = asyncStore(scope => load(id, scope));
 *   $effect(() => { void id; user.refresh(); });
 */
export function asyncStore<T>(fn: (scope: Scope) => Promise<T>, opts?: ScopeOptions): AsyncStore<T> {
  const parent = useScope(opts);
  const store = writable<AsyncStoreState<T>>({ status: 'loading' });
  let current: Scope | undefined;
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
  return { subscribe: store.subscribe, refresh, scope: parent };
}
