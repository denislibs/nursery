import { anySignal, throwIfAborted, abortError, type MaybeSignal } from './signal.js';
import type { Task } from './combine.js';

export type Release = () => void;

/** Counting semaphore with cancellable, FIFO acquisition. */
export class Semaphore {
  #free: number;
  #queue: Array<{ resolve: (r: Release) => void; reject: (e: unknown) => void; signal?: MaybeSignal; onAbort?: () => void }> = [];

  constructor(permits: number) {
    if (permits < 1) throw new RangeError('Semaphore needs at least one permit');
    this.#free = permits;
  }

  get available(): number {
    return this.#free;
  }

  get pending(): number {
    return this.#queue.length;
  }

  acquire(signal?: MaybeSignal): Promise<Release> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? abortError());
    if (this.#free > 0) {
      this.#free--;
      return Promise.resolve(this.#release());
    }
    return new Promise<Release>((resolve, reject) => {
      const entry = { resolve, reject, signal, onAbort: undefined as undefined | (() => void) };
      if (signal) {
        entry.onAbort = () => {
          const i = this.#queue.indexOf(entry);
          if (i >= 0) this.#queue.splice(i, 1);
          reject(signal.reason ?? abortError());
        };
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      this.#queue.push(entry);
    });
  }

  /** Acquires a permit, runs fn with the same signal, releases on any outcome. */
  async run<T>(fn: (signal: AbortSignal) => Promise<T>, signal?: MaybeSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await fn(signal ?? new AbortController().signal);
    } finally {
      release();
    }
  }

  #release(): Release {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.#queue.shift();
      if (next) {
        if (next.onAbort) next.signal?.removeEventListener('abort', next.onAbort);
        next.resolve(this.#release());
      } else {
        this.#free++;
      }
    };
  }
}

/** A semaphore with a single permit. */
export class Mutex extends Semaphore {
  constructor() {
    super(1);
  }
}

export interface MapOptions {
  concurrency?: number;
  signal?: MaybeSignal;
}

export type MapFn<T, R> = (item: T, index: number, signal: AbortSignal) => Promise<R>;

type Source<T> = Iterable<T> | AsyncIterable<T>;

/** Serialized puller over a sync or async iterable: concurrent workers never overlap next() calls. */
function puller<T>(source: Source<T>) {
  const it: Iterator<T> | AsyncIterator<T> =
    Symbol.asyncIterator in source
      ? (source as AsyncIterable<T>)[Symbol.asyncIterator]()
      : (source as Iterable<T>)[Symbol.iterator]();
  let chain: Promise<unknown> = Promise.resolve();
  let index = 0;
  let done = false;
  const next = (): Promise<{ value: T; index: number } | undefined> => {
    const p = chain.then(async () => {
      if (done) return undefined;
      const r = await it.next();
      if (r.done) {
        done = true;
        return undefined;
      }
      return { value: r.value, index: index++ };
    });
    chain = p.catch(() => {});
    return p;
  };
  const stop = async () => {
    done = true;
    await it.return?.();
  };
  return { next, stop };
}

async function runBounded<T>(
  source: Source<T>,
  concurrency: number,
  signal: AbortSignal,
  onItem: (item: T, index: number) => Promise<boolean>, // returns false to stop everything
): Promise<void> {
  const src = puller(source);
  let stopped = false;
  const worker = async () => {
    while (!stopped && !signal.aborted) {
      const entry = await src.next();
      if (!entry) return;
      const keepGoing = await onItem(entry.value, entry.index);
      if (!keepGoing) {
        stopped = true;
        await src.stop();
        return;
      }
    }
  };
  const n = Number.isFinite(concurrency) ? Math.max(1, concurrency) : 16;
  await Promise.all(Array.from({ length: n }, worker));
}

/**
 * Maps `items` through `fn` with bounded concurrency. Results keep input order.
 * On the first failure, in-flight siblings are aborted, remaining items are not started,
 * and the original error is rethrown.
 */
export async function map<T, R>(items: Source<T>, fn: MapFn<T, R>, opts: MapOptions = {}): Promise<R[]> {
  const { concurrency = Infinity, signal } = opts;
  throwIfAborted(signal);
  const ctrl = new AbortController();
  const inner = anySignal([ctrl.signal, signal]);
  const results: R[] = [];
  let failure: { err: unknown } | undefined;

  await runBounded(items, concurrency, inner, async (item, i) => {
    try {
      results[i] = await fn(item, i, inner);
      return true;
    } catch (err) {
      if (!failure) {
        failure = { err };
        ctrl.abort(abortError('Sibling task failed'));
      }
      return false;
    }
  });
  if (failure) throw failure.err;
  throwIfAborted(signal);
  return results;
}

/**
 * Like map, but runs every item to completion and reports each outcome in input order.
 * Only the outer signal can stop it early.
 */
export async function mapSettled<T, R>(
  items: Source<T>,
  fn: MapFn<T, R>,
  opts: MapOptions = {},
): Promise<PromiseSettledResult<R>[]> {
  const { concurrency = Infinity, signal } = opts;
  throwIfAborted(signal);
  const sig = signal ?? new AbortController().signal;
  const results: PromiseSettledResult<R>[] = [];
  await runBounded(items, concurrency, sig, async (item, i) => {
    try {
      results[i] = { status: 'fulfilled', value: await fn(item, i, sig) };
    } catch (reason) {
      results[i] = { status: 'rejected', reason };
    }
    return true;
  });
  throwIfAborted(signal);
  return results;
}

export interface QueueOptions {
  concurrency?: number;
  /** Aborts running tasks and rejects waiting ones; the queue refuses new tasks afterwards. */
  signal?: MaybeSignal;
}

interface QueueEntry {
  run: () => Promise<void>;
  reject: (err: unknown) => void;
  signal?: MaybeSignal;
  onAbort?: () => void;
}

/** Dynamic task queue with bounded concurrency. Tasks are added over time and run FIFO. */
export class Queue {
  #concurrency: number;
  #signal: MaybeSignal;
  #waiting: QueueEntry[] = [];
  #running = 0;
  #idleWaiters: Array<() => void> = [];

  constructor(opts: QueueOptions = {}) {
    this.#concurrency = Math.max(1, opts.concurrency ?? Infinity);
    this.#signal = opts.signal;
    this.#signal?.addEventListener('abort', () => this.#flush(this.#signal!.reason ?? abortError()), { once: true });
  }

  /** Waiting tasks. */
  get size(): number {
    return this.#waiting.length;
  }

  /** Running tasks. */
  get pending(): number {
    return this.#running;
  }

  add<T>(task: Task<T>, signal?: MaybeSignal): Promise<T> {
    if (this.#signal?.aborted) return Promise.reject(this.#signal.reason ?? abortError());
    if (signal?.aborted) return Promise.reject(signal.reason ?? abortError());
    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry = {
        signal,
        reject,
        run: async () => {
          if (entry.onAbort) signal?.removeEventListener('abort', entry.onAbort);
          try {
            resolve(await task(anySignal([this.#signal, signal])));
          } catch (err) {
            reject(err);
          }
        },
      };
      if (signal) {
        entry.onAbort = () => {
          const i = this.#waiting.indexOf(entry);
          if (i >= 0) this.#waiting.splice(i, 1);
          reject(signal.reason ?? abortError());
        };
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      this.#waiting.push(entry);
      this.#pump();
    });
  }

  /** Rejects every waiting task with AbortError. Running tasks are untouched. */
  clear(): void {
    this.#flush(abortError('Queue cleared'));
  }

  /** Resolves when nothing is waiting or running. */
  idle(): Promise<void> {
    if (this.#running === 0 && this.#waiting.length === 0) return Promise.resolve();
    return new Promise(r => this.#idleWaiters.push(r));
  }

  #flush(reason: unknown): void {
    const entries = this.#waiting.splice(0);
    for (const e of entries) {
      if (e.onAbort) e.signal?.removeEventListener('abort', e.onAbort);
      e.reject(reason);
    }
    this.#checkIdle();
  }

  #pump(): void {
    while (this.#running < this.#concurrency && this.#waiting.length > 0) {
      const entry = this.#waiting.shift()!;
      this.#running++;
      void entry.run().finally(() => {
        this.#running--;
        this.#pump();
        this.#checkIdle();
      });
    }
  }

  #checkIdle(): void {
    if (this.#running === 0 && this.#waiting.length === 0) {
      for (const r of this.#idleWaiters.splice(0)) r();
    }
  }
}
