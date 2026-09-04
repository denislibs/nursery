/// <reference lib="dom" />
/** Vue 3 composables. Import from 'scopekit/vue'; requires vue >= 3.3. */
import {
  onScopeDispose,
  ref,
  shallowRef,
  watch,
  watchEffect,
  type Ref,
  type ShallowRef,
  type WatchSource,
} from 'vue';
import { Scope, type ScopeOptions } from './scope.js';
import { latest } from './latest.js';
import { isAbort } from './signal.js';
import { on, type OnOptions } from './events.js';
import { wrap, type Remote } from './worker.js';

/** A scope that closes when the current effect scope (component) is disposed. */
export function useScope(opts?: ScopeOptions): Scope {
  const scope = new Scope(opts);
  onScopeDispose(() => {
    void scope.close();
  });
  return scope;
}

/**
 * watchEffect with a Scope. Reactive dependencies are collected from the synchronous part of
 * `effect`, so read them before the first await. Each re-run closes the previous scope.
 */
export function useScopedWatch(effect: (scope: Scope) => void | Promise<void>, opts?: ScopeOptions): void {
  watchEffect(onCleanup => {
    const scope = new Scope(opts);
    onCleanup(() => {
      void scope.close();
    });
    void scope.spawn((_sig, s) => Promise.resolve(effect(s)), { name: 'effect' });
  });
}

export interface UseAsync<T> {
  data: ShallowRef<T | null>;
  error: ShallowRef<unknown>;
  loading: Ref<boolean>;
}

/** Loads data in a scoped watch. Results of a cancelled run never reach the refs. */
export function useAsync<T>(fn: (scope: Scope) => Promise<T>, opts?: ScopeOptions): UseAsync<T> {
  const data = shallowRef<T | null>(null);
  const error = shallowRef<unknown>(null);
  const loading = ref(false);
  useScopedWatch(async scope => {
    loading.value = true;
    error.value = null;
    try {
      const value = await fn(scope);
      if (!scope.signal.aborted) {
        data.value = value;
        loading.value = false;
      }
    } catch (err) {
      if (!isAbort(err)) {
        error.value = err;
        loading.value = false;
      }
    }
  }, opts);
  return { data, error, loading };
}

export interface UseLatest<A, R> {
  run: (arg: A, signal?: AbortSignal) => Promise<R>;
  pending: Ref<boolean>;
  cancel: () => void;
}

/** latest() bound to the component: disposal cancels the in-flight call. */
export function useLatest<A, R>(fn: (arg: A, signal: AbortSignal) => Promise<R>): UseLatest<A, R> {
  const wrapped = latest(fn);
  const pending = ref(false);
  onScopeDispose(() => wrapped.cancel());
  const run = async (arg: A, signal?: AbortSignal) => {
    pending.value = true;
    try {
      return await wrapped(arg, signal);
    } finally {
      if (!wrapped.pending) pending.value = false;
    }
  };
  const cancel = () => {
    wrapped.cancel();
    pending.value = false;
  };
  return { run, pending, cancel };
}

/** Consumes DOM events from a ref'd element (or a static target) in a scoped loop. */
export function useEventStream<E extends Event = Event>(
  target: WatchSource<EventTarget | null | undefined> | EventTarget,
  type: string,
  handler: (event: E, scope: Scope) => void | Promise<void>,
  opts?: Omit<OnOptions, 'signal'>,
): void {
  const source: WatchSource<EventTarget | null | undefined> =
    target instanceof EventTarget ? () => target : target;
  watch(
    source,
    (node, _prev, onCleanup) => {
      if (!node) return;
      const scope = new Scope({ name: `on:${type}` });
      onCleanup(() => {
        void scope.close();
      });
      void scope.spawn(async (sig, s) => {
        for await (const e of on<E>(node, type, { ...opts, signal: sig })) await handler(e, s);
      });
    },
    { immediate: true },
  );
}

/** Creates the worker, wraps it, terminates it when the component is disposed. */
export function useWorker<T>(factory: () => Worker): Remote<T> {
  const worker = factory();
  const api = wrap<T>(worker);
  onScopeDispose(() => {
    api[Symbol.dispose]();
    worker.terminate();
  });
  return api;
}
