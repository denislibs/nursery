import { abortError, throwIfAborted, type MaybeSignal } from './signal.js';

type G = typeof globalThis & {
  scheduler?: { yield?: () => Promise<void> };
  requestIdleCallback?: (cb: (d: IdleDeadline) => void, opts?: { timeout?: number }) => number;
  cancelIdleCallback?: (id: number) => void;
  requestAnimationFrame?: (cb: (t: number) => void) => number;
  cancelAnimationFrame?: (id: number) => void;
};
const g = globalThis as G;

let channel: MessageChannel | undefined;
let macrotaskWaiters: Array<() => void> = [];

/** A macrotask hop that avoids the nested-setTimeout clamp. Falls back to setTimeout if needed. */
function macrotask(): Promise<void> {
  if (typeof MessageChannel === 'undefined') return new Promise(r => setTimeout(r, 0));
  if (!channel) {
    channel = new MessageChannel();
    channel.port1.onmessage = () => {
      const waiters = macrotaskWaiters;
      macrotaskWaiters = [];
      for (const w of waiters) w();
    };
    // Node keeps the loop alive for open ports; browsers have no unref.
    (channel.port1 as unknown as { unref?: () => void }).unref?.();
    (channel.port2 as unknown as { unref?: () => void }).unref?.();
  }
  return new Promise(r => {
    if (macrotaskWaiters.push(r) === 1) channel!.port2.postMessage(null);
  });
}

/**
 * Gives the browser a chance to handle input and paint. Uses scheduler.yield() where available
 * (continuation keeps its priority), otherwise a plain macrotask hop.
 */
export async function yieldToMain(signal?: MaybeSignal): Promise<void> {
  throwIfAborted(signal);
  if (g.scheduler?.yield) await g.scheduler.yield();
  else await macrotask();
  throwIfAborted(signal);
}

function cancellable<T>(
  signal: MaybeSignal,
  start: (resolve: (v: T) => void) => () => void,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? abortError());
  return new Promise<T>((resolve, reject) => {
    const cancel = start(v => {
      signal?.removeEventListener('abort', onAbort);
      resolve(v);
    });
    const onAbort = () => {
      cancel();
      reject(signal!.reason ?? abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface IdleOptions {
  /** Max ms to wait before the callback is forced (requestIdleCallback timeout). */
  timeout?: number;
  signal?: MaybeSignal;
}

/** Resolves when the browser is idle, with the IdleDeadline. Falls back to a timer (Safari). */
export function idle(opts: IdleOptions = {}): Promise<IdleDeadline> {
  const { timeout, signal } = opts;
  return cancellable<IdleDeadline>(signal, resolve => {
    if (g.requestIdleCallback) {
      const id = g.requestIdleCallback(resolve, timeout === undefined ? undefined : { timeout });
      return () => g.cancelIdleCallback?.(id);
    }
    const start = performance.now();
    const id = setTimeout(
      () => resolve({ didTimeout: false, timeRemaining: () => Math.max(0, 50 - (performance.now() - start)) }),
      0,
    );
    return () => clearTimeout(id);
  });
}

/** Resolves on the next animation frame with its timestamp. Falls back to a ~16ms timer. */
export function frame(signal?: MaybeSignal): Promise<number> {
  return cancellable<number>(signal, resolve => {
    if (g.requestAnimationFrame) {
      const id = g.requestAnimationFrame(resolve);
      return () => g.cancelAnimationFrame?.(id);
    }
    const id = setTimeout(() => resolve(performance.now()), 16);
    return () => clearTimeout(id);
  });
}

export interface ChunkedOptions {
  /** Main-thread time budget in ms between yields. Default 8 (about half a 60fps frame). */
  budget?: number;
  signal?: MaybeSignal;
}

/**
 * Iterates `items` and yields to the main thread whenever the consumer has used up `budget` ms
 * since the last yield. Drop-in for a heavy synchronous loop:
 *   for await (const row of chunked(rows)) process(row);
 */
export async function* chunked<T>(
  items: Iterable<T> | AsyncIterable<T>,
  opts: ChunkedOptions = {},
): AsyncGenerator<T, void, undefined> {
  const { budget = 8, signal } = opts;
  let start = performance.now();
  for await (const item of items) {
    throwIfAborted(signal);
    if (performance.now() - start >= budget) {
      await yieldToMain(signal);
      start = performance.now();
    }
    yield item;
  }
}
