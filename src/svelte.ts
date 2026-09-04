/**
 * Svelte 5 adapters. Import from 'scopekit/svelte'; requires svelte >= 5.
 * Runes are compiler features, so the reactive re-run stays in your `$effect`; these helpers
 * give it a Scope and tie lifetimes to the component.
 */
import { onDestroy } from 'svelte';
import { writable, type Readable } from 'svelte/store';
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
export function scopedEffect(effect: (scope: Scope) => void | Promise<void>, opts?: ScopeOptions): () => void {
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
