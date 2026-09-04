import { anySignal, abortError, type MaybeSignal } from './signal.js';

export interface LatestFn<A, R> {
  (arg: A, signal?: MaybeSignal): Promise<R>;
  /** Abort the in-flight call, if any. */
  cancel(): void;
  /** True while a call is in flight. */
  readonly pending: boolean;
}

/**
 * "Take latest" wrapper: every new call aborts the previous in-flight one.
 * The classic fix for stale search results overwriting fresh ones.
 */
export function latest<A, R>(fn: (arg: A, signal: AbortSignal) => Promise<R>): LatestFn<A, R> {
  let current: AbortController | undefined;
  const wrapped = ((arg: A, signal?: MaybeSignal) => {
    current?.abort(abortError('Superseded by a newer call'));
    const ctrl = new AbortController();
    current = ctrl;
    const combined = anySignal([ctrl.signal, signal]);
    return fn(arg, combined).finally(() => {
      if (current === ctrl) current = undefined;
    });
  }) as LatestFn<A, R>;
  wrapped.cancel = () => {
    current?.abort(abortError('Cancelled'));
    current = undefined;
  };
  Object.defineProperty(wrapped, 'pending', { get: () => current !== undefined });
  return wrapped;
}

export interface SingleFlightOptions<A> {
  /** Derives the dedupe key from the argument. Default: the argument itself. */
  key?: (arg: A) => unknown;
}

/**
 * Deduplicates concurrent calls with the same key: they all await one execution.
 * Nothing is cached once the flight settles.
 */
export function singleFlight<A, R>(
  fn: (arg: A) => Promise<R>,
  opts: SingleFlightOptions<A> = {},
): (arg: A) => Promise<R> {
  const keyOf = opts.key ?? ((a: A) => a);
  const inflight = new Map<unknown, Promise<R>>();
  return (arg: A) => {
    const key = keyOf(arg);
    const existing = inflight.get(key);
    if (existing) return existing;
    const p = fn(arg).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };
}
