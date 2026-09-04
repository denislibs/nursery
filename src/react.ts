/** React adapters. Import from 'scopekit/react'; requires react >= 18. */
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useState,
  type DependencyList,
  type ReactNode,
} from 'react';
import { Scope, type ScopeOptions } from './scope.js';
import { latest, type LatestFn } from './latest.js';
import { isAbort } from './signal.js';
import { on, type OnOptions } from './events.js';
import { wrap, type Remote } from './worker.js';

export const ScopeContext = createContext<Scope | null>(null);

/** Makes `scope` the parent of every scope created by the hooks below. */
export function ScopeProvider({ scope, children }: { scope: Scope; children?: ReactNode }) {
  return createElement(ScopeContext.Provider, { value: scope }, children);
}

const make = (parent: Scope | null, opts?: ScopeOptions) => (parent ? parent.child(opts) : new Scope(opts));

/**
 * A scope that lives as long as the component is mounted. Child of the nearest ScopeProvider.
 * The scope is created during render as a detached child and adopted by the parent in the
 * effect, so a render that React discards (StrictMode, Suspense) never pollutes
 * `parent.children`. Under StrictMode the first scope is closed and replaced on the remount.
 */
export function useScope(opts?: ScopeOptions): Scope {
  const parent = useContext(ScopeContext);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const create = () => (parent ? parent.child(optsRef.current, { detached: true }) : new Scope(optsRef.current));
  const ref = useRef<Scope | null>(null);
  ref.current ??= create();
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (ref.current!.closed) {
      ref.current = create(); // StrictMode ran the cleanup once already
      rerender();
    }
    const current = ref.current!;
    parent?.adopt(current);
    return () => {
      void current.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parent]);
  return ref.current;
}

/**
 * useEffect with a Scope. Each run gets a fresh scope; the previous one is closed on cleanup,
 * so work from a stale run is cancelled. Failures are reported through Scope.onUnhandled.
 */
export function useScopedEffect(
  effect: (scope: Scope) => void | Promise<void>,
  deps: DependencyList,
  opts?: ScopeOptions,
): void {
  const parent = useContext(ScopeContext);
  const effectRef = useRef(effect);
  effectRef.current = effect;
  useEffect(() => {
    const scope = make(parent, opts);
    void scope.spawn((_sig, s) => Promise.resolve(effectRef.current(s)), { name: 'effect' });
    return () => {
      void scope.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parent, ...deps]);
}

export type AsyncState<T> =
  | { status: 'loading' }
  | { status: 'success'; data: T }
  | { status: 'error'; error: unknown };

/** Loads data in a scoped effect. Results of a cancelled run never reach state. */
export function useAsync<T>(fn: (scope: Scope) => Promise<T>, deps: DependencyList, opts?: ScopeOptions): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' });
  useScopedEffect(
    async scope => {
      setState(s => (s.status === 'loading' ? s : { status: 'loading' }));
      try {
        const data = await fn(scope);
        if (!scope.signal.aborted) setState({ status: 'success', data });
      } catch (error) {
        if (!isAbort(error)) setState({ status: 'error', error });
      }
    },
    deps,
    opts,
  );
  return state;
}

export interface UseLatest<A, R> {
  /** Starts a call; the previous in-flight call is aborted. */
  run: (arg: A, signal?: AbortSignal) => Promise<R>;
  /** True while a call is in flight (reactive). */
  pending: boolean;
  cancel: () => void;
}

/** latest() bound to the component: unmount cancels the in-flight call. */
export function useLatest<A, R>(fn: (arg: A, signal: AbortSignal) => Promise<R>): UseLatest<A, R> {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const wrappedRef = useRef<LatestFn<A, R> | null>(null);
  wrappedRef.current ??= latest<A, R>((arg, signal) => fnRef.current(arg, signal));
  const [pending, setPending] = useState(false);
  useEffect(() => () => wrappedRef.current?.cancel(), []);
  const run = useCallback(async (arg: A, signal?: AbortSignal) => {
    setPending(true);
    try {
      return await wrappedRef.current!(arg, signal);
    } finally {
      if (!wrappedRef.current!.pending) setPending(false);
    }
  }, []);
  const cancel = useCallback(() => {
    wrappedRef.current!.cancel();
    setPending(false);
  }, []);
  return { run, pending, cancel };
}

/** Consumes DOM events in a scoped loop; events arriving during an async handler are queued. */
export function useEventStream<E extends Event = Event>(
  target: EventTarget | null | undefined,
  type: string,
  handler: (event: E, scope: Scope) => void | Promise<void>,
  deps: DependencyList = [],
  opts?: Omit<OnOptions, 'signal'>,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useScopedEffect(
    async scope => {
      if (!target) return;
      for await (const e of on<E>(target, type, { ...opts, signal: scope.signal })) {
        await handlerRef.current(e, scope);
      }
    },
    [target, type, ...deps],
  );
}

interface WorkerEntry<T> {
  worker: Worker;
  api: Remote<T>;
  disposed: boolean;
}

/**
 * Creates the worker once per mount, wraps it, terminates it on unmount. The returned proxy is
 * stable across renders and keeps working through a StrictMode remount (a new worker is spun up).
 */
export function useWorker<T>(factory: () => Worker): Remote<T> {
  const factoryRef = useRef(factory);
  factoryRef.current = factory;
  const entry = useRef<WorkerEntry<T> | null>(null);
  const create = (): WorkerEntry<T> => {
    const worker = factoryRef.current();
    return { worker, api: wrap<T>(worker), disposed: false };
  };
  entry.current ??= create();
  const stable = useRef<Remote<T> | null>(null);
  stable.current ??= new Proxy({} as Remote<T>, {
    get(_t, prop) {
      const api = entry.current!.api as unknown as Record<PropertyKey, unknown>;
      return api[prop];
    },
  });
  useEffect(() => {
    if (entry.current!.disposed) entry.current = create(); // StrictMode remount
    const current = entry.current!;
    return () => {
      current.api[Symbol.dispose]();
      current.worker.terminate();
      current.disposed = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return stable.current;
}
