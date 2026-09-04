/// <reference lib="dom" />
import { abortError, throwIfAborted, type MaybeSignal } from './signal.js';

export type TaskPriority = 'user-blocking' | 'user-visible' | 'background';

type G = typeof globalThis & {
  navigator?: { scheduling?: { isInputPending?: () => boolean } };
  scheduler?: {
    yield?: () => Promise<void>;
    postTask?: <T>(
      fn: () => T | Promise<T>,
      opts?: { priority?: TaskPriority; signal?: AbortSignal; delay?: number },
    ) => Promise<T>;
  };
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
    channel.port1.addEventListener('message', () => {
      const waiters = macrotaskWaiters;
      macrotaskWaiters = [];
      for (const w of waiters) w();
    });
    channel.port1.start();
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

export interface PostTaskOptions {
  /** Default 'user-visible', like the platform. */
  priority?: TaskPriority;
  signal?: MaybeSignal;
  /** Minimum delay in ms before the task may run. */
  delay?: number;
}

const PRIORITY_ORDER: TaskPriority[] = ['user-blocking', 'user-visible', 'background'];
const fallbackQueues: Record<TaskPriority, Array<() => void>> = {
  'user-blocking': [],
  'user-visible': [],
  background: [],
};
let fallbackScheduled = false;

function drainFallback(): void {
  fallbackScheduled = false;
  for (const p of PRIORITY_ORDER) {
    const jobs = fallbackQueues[p].splice(0);
    for (const job of jobs) job();
  }
}

/**
 * Runs `fn` as a scheduled task with a priority. Uses scheduler.postTask where available;
 * otherwise a macrotask queue that still honours priority order among queued tasks.
 */
export function postTask<T>(fn: () => T | Promise<T>, opts: PostTaskOptions = {}): Promise<T> {
  const { priority = 'user-visible', signal, delay } = opts;
  if (signal?.aborted) return Promise.reject(signal.reason ?? abortError());
  if (g.scheduler?.postTask) {
    return g.scheduler.postTask(fn, { priority, signal: signal ?? undefined, delay });
  }
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      if (signal?.aborted) return reject(signal.reason ?? abortError());
      try {
        resolve(fn());
      } catch (err) {
        reject(err);
      }
    };
    const enqueue = () => {
      fallbackQueues[priority].push(run);
      if (!fallbackScheduled) {
        fallbackScheduled = true;
        void macrotask().then(drainFallback);
      }
    };
    if (delay) setTimeout(enqueue, delay);
    else enqueue();
  });
}

function cancellable<T>(signal: MaybeSignal, start: (resolve: (v: T) => void) => () => void): Promise<T> {
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
      () =>
        resolve({ didTimeout: false, timeRemaining: () => Math.max(0, 50 - (performance.now() - start)) }),
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

const FALLBACK_FRAME_MS = 1000 / 60;
const FRAME_SAMPLES = 6;
const FRAME_CACHE_TTL = 5000;
let frameCache: { value: number; at: number } | undefined;
let frameMeasurement: Promise<number> | undefined;

/**
 * Measured interval between animation frames in ms: ~16.7 on 60 Hz, ~8.3 on 120 Hz. The
 * median of a few frames, cached for a few seconds (the tab may move to another display).
 * Falls back to 60 Hz where requestAnimationFrame is unavailable or the page is hidden.
 */
export function frameInterval(): Promise<number> {
  if (frameCache && performance.now() - frameCache.at < FRAME_CACHE_TTL)
    return Promise.resolve(frameCache.value);
  frameMeasurement ??= measureFrameInterval().then(value => {
    frameCache = { value, at: performance.now() };
    frameMeasurement = undefined;
    return value;
  });
  return frameMeasurement;
}

/** Drops the cached measurement (tests, or after a known display change). */
export function resetFrameInterval(): void {
  frameCache = undefined;
  frameMeasurement = undefined;
}

async function measureFrameInterval(): Promise<number> {
  const raf = g.requestAnimationFrame;
  if (!raf || (typeof document !== 'undefined' && document.hidden)) return FALLBACK_FRAME_MS;
  const stamps: number[] = [];
  const timeout = new Promise<'timeout'>(r => setTimeout(() => r('timeout'), 1000));
  const frames = (async () => {
    for (let i = 0; i < FRAME_SAMPLES; i++) stamps.push(await new Promise<number>(r => raf(r)));
    return 'done' as const;
  })();
  if ((await Promise.race([frames, timeout])) === 'timeout' || stamps.length < 3) return FALLBACK_FRAME_MS;
  const deltas = stamps
    .slice(1)
    .map((t, i) => t - stamps[i]!)
    .toSorted((a, b) => a - b);
  const median = deltas[Math.floor(deltas.length / 2)]!;
  return median > 0 && median < 200 ? median : FALLBACK_FRAME_MS;
}

export interface ChunkedOptions {
  /**
   * Main-thread time budget in ms between yields, or 'auto' (default): half of the measured
   * frame interval, so a 120 Hz display gets ~4 ms and a 60 Hz one ~8 ms.
   */
  budget?: number | 'auto';
  signal?: MaybeSignal;
}

/**
 * Iterates `items` and yields to the main thread whenever the consumer has used up `budget` ms
 * since the last yield, or sooner when the browser reports pending input. Drop-in for a heavy
 * synchronous loop:
 *   for await (const row of chunked(rows)) process(row);
 */
export async function* chunked<T>(
  items: Iterable<T> | AsyncIterable<T>,
  opts: ChunkedOptions = {},
): AsyncGenerator<T, void, undefined> {
  const { signal } = opts;
  const budget =
    opts.budget === undefined || opts.budget === 'auto' ? (await frameInterval()) / 2 : opts.budget;
  const scheduling = g.navigator?.scheduling;
  let start = performance.now();
  for await (const item of items) {
    throwIfAborted(signal);
    // called as a method: native isInputPending throws when invoked unbound
    if (performance.now() - start >= budget || scheduling?.isInputPending?.() === true) {
      await yieldToMain(signal);
      start = performance.now();
    }
    yield item;
  }
}
