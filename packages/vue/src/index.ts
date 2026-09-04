/// <reference lib="dom" />
/** Vue 3 composables. Import from 'nursery/vue'; requires vue >= 3.3. */
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
import { Nursery, type NurseryOptions } from '@nursery/core/nursery';
import { latest } from '@nursery/core/latest';
import { isAbort } from '@nursery/core/signal';
import { on, type OnOptions } from '@nursery/core/events';
import { wrap, type Remote } from '@nursery/core/worker';

/** A nursery that closes when the current effect scope (component) is disposed. */
export function useNursery(opts?: NurseryOptions): Nursery {
  const nursery = new Nursery(opts);
  onScopeDispose(() => {
    void nursery.close();
  });
  return nursery;
}

/**
 * watchEffect with a Nursery. Reactive dependencies are collected from the synchronous part of
 * `effect`, so read them before the first await. Each re-run closes the previous nursery.
 */
export function useNurseryWatch(
  effect: (nursery: Nursery) => void | Promise<void>,
  opts?: NurseryOptions,
): void {
  watchEffect(onCleanup => {
    const nursery = new Nursery(opts);
    onCleanup(() => {
      void nursery.close();
    });
    void nursery.spawn((_sig, s) => Promise.resolve(effect(s)), { name: 'effect' });
  });
}

export interface UseAsync<T> {
  data: ShallowRef<T | null>;
  error: ShallowRef<unknown>;
  loading: Ref<boolean>;
}

/** Loads data in a scoped watch. Results of a cancelled run never reach the refs. */
export function useAsync<T>(fn: (nursery: Nursery) => Promise<T>, opts?: NurseryOptions): UseAsync<T> {
  const data = shallowRef<T | null>(null);
  const error = shallowRef<unknown>(null);
  const loading = ref(false);
  useNurseryWatch(async nursery => {
    loading.value = true;
    error.value = null;
    try {
      const value = await fn(nursery);
      if (!nursery.signal.aborted) {
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
  handler: (event: E, nursery: Nursery) => void | Promise<void>,
  opts?: Omit<OnOptions, 'signal'>,
): void {
  const source: WatchSource<EventTarget | null | undefined> =
    target instanceof EventTarget ? () => target : target;
  watch(
    source,
    (node, _prev, onCleanup) => {
      if (!node) return;
      const nursery = new Nursery({ name: `on:${type}` });
      onCleanup(() => {
        void nursery.close();
      });
      void nursery.spawn(async (sig, s) => {
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
