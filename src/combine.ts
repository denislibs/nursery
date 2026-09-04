import { anySignal, linkSignals, isAbort, sleep, timeoutError, throwIfAborted, type MaybeSignal } from './signal.js';

/** A cancellable unit of work: receives a signal, returns a promise. */
export type Task<T> = (signal: AbortSignal) => Promise<T>;

/**
 * Runs `task` with a signal that aborts after `ms` (TimeoutError) or when `signal` aborts.
 * The timer is always cleared once the task settles.
 */
export async function withTimeout<T>(task: Task<T>, ms: number, signal?: MaybeSignal): Promise<T> {
  throwIfAborted(signal);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(timeoutError(`Timed out after ${ms}ms`)), ms);
  const combined = anySignal([ctrl.signal, signal]);
  try {
    return await task(combined);
  } finally {
    clearTimeout(timer);
  }
}

export interface RetryOptions {
  /** Extra attempts after the first one. Default 3. */
  retries?: number;
  /** Base delay in ms before the first retry. Default 100. */
  delay?: number;
  /** Multiplier applied to the delay after each attempt. Default 2. */
  factor?: number;
  /** Upper bound for a single delay. Default 30_000. */
  maxDelay?: number;
  /** Random jitter fraction in [0, 1] applied to each delay. Default 0. */
  jitter?: number;
  /**
   * Return false to stop retrying for this error, true to retry with the computed backoff,
   * or a number of ms to retry after exactly that delay. Outer aborts are never retried.
   */
  retryOn?: (err: unknown, attempt: number) => boolean | number;
  /** Per-attempt timeout in ms. A timed-out attempt counts as a retryable failure. */
  attemptTimeout?: number;
  signal?: MaybeSignal;
}

/** Retries `task` with exponential backoff. Never retries an outer abort. */
export async function retry<T>(task: Task<T>, opts: RetryOptions = {}): Promise<T> {
  const { retries = 3, delay = 100, factor = 2, maxDelay = 30_000, jitter = 0, retryOn, attemptTimeout, signal } = opts;
  let wait = delay;
  for (let attempt = 0; ; attempt++) {
    throwIfAborted(signal);
    const attemptCtrl = new AbortController();
    const link = linkSignals([attemptCtrl.signal, signal]);
    const timer = attemptTimeout === undefined
      ? undefined
      : setTimeout(() => attemptCtrl.abort(timeoutError(`Attempt timed out after ${attemptTimeout}ms`)), attemptTimeout);
    try {
      return await task(link.signal);
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err;
      const timedOut = attemptCtrl.signal.aborted;
      const verdict = attempt < retries && (timedOut || !isAbort(err)) ? (retryOn?.(err, attempt) ?? true) : false;
      if (verdict === false) throw err;
      const jittered = wait * (1 + (Math.random() * 2 - 1) * jitter);
      const delayMs = typeof verdict === 'number' ? verdict : Math.min(jittered, maxDelay);
      await sleep(delayMs, signal);
      wait *= factor;
    } finally {
      clearTimeout(timer);
      link.unlink();
    }
  }
}

/** First task to settle wins; every other task is aborted with AbortError. */
export async function race<T>(tasks: readonly Task<T>[], signal?: MaybeSignal): Promise<T> {
  throwIfAborted(signal);
  const ctrl = new AbortController();
  const combined = anySignal([ctrl.signal, signal]);
  try {
    return await Promise.race(tasks.map(t => t(combined)));
  } finally {
    ctrl.abort(new DOMException('Lost the race', 'AbortError'));
  }
}

export interface Settled<T> {
  fulfilled: T[];
  rejected: unknown[];
}

/** Like Promise.allSettled but pre-sorted into two lists. */
export async function settle<T>(promises: readonly (Promise<T> | T)[]): Promise<Settled<T>> {
  const results = await Promise.allSettled(promises);
  const out: Settled<T> = { fulfilled: [], rejected: [] };
  for (const r of results) {
    if (r.status === 'fulfilled') out.fulfilled.push(r.value);
    else out.rejected.push(r.reason);
  }
  return out;
}
