import { anySignal, throwIfAborted, abortError, type MaybeSignal } from './signal.js';

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

  async run<T>(fn: () => Promise<T>, signal?: MaybeSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await fn();
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

/**
 * Maps `items` through `fn` with bounded concurrency. Results keep input order.
 * On the first failure, in-flight siblings are aborted, remaining items are not started,
 * and the original error is rethrown.
 */
export async function map<T, R>(
  items: readonly T[],
  fn: (item: T, index: number, signal: AbortSignal) => Promise<R>,
  opts: MapOptions = {},
): Promise<R[]> {
  const { concurrency = Infinity, signal } = opts;
  throwIfAborted(signal);
  const ctrl = new AbortController();
  const inner = anySignal([ctrl.signal, signal]);
  const results: R[] = new Array(items.length);
  let next = 0;
  let failure: { err: unknown } | undefined;

  const worker = async () => {
    while (next < items.length && !inner.aborted && !failure) {
      const i = next++;
      try {
        results[i] = await fn(items[i] as T, i, inner);
      } catch (err) {
        if (!failure) {
          failure = { err };
          ctrl.abort(abortError('Sibling task failed'));
        }
        return;
      }
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  if (failure) throw failure.err;
  throwIfAborted(signal);
  return results;
}
