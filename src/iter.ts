/** Operators over AsyncIterable. Compose with pipe(); consume with for-await or toArray(). */
import { timeoutError } from './signal.js';

export type Op<T, R> = (source: AsyncIterable<T>) => AsyncIterable<R>;

export function pipe<A>(src: AsyncIterable<A>): AsyncIterable<A>;
export function pipe<A, B>(src: AsyncIterable<A>, a: Op<A, B>): AsyncIterable<B>;
export function pipe<A, B, C>(src: AsyncIterable<A>, a: Op<A, B>, b: Op<B, C>): AsyncIterable<C>;
export function pipe<A, B, C, D>(src: AsyncIterable<A>, a: Op<A, B>, b: Op<B, C>, c: Op<C, D>): AsyncIterable<D>;
export function pipe<A, B, C, D, E>(src: AsyncIterable<A>, a: Op<A, B>, b: Op<B, C>, c: Op<C, D>, d: Op<D, E>): AsyncIterable<E>;
export function pipe<A, B, C, D, E, F>(src: AsyncIterable<A>, a: Op<A, B>, b: Op<B, C>, c: Op<C, D>, d: Op<D, E>, e: Op<E, F>): AsyncIterable<F>;
export function pipe<A, B, C, D, E, F, G>(src: AsyncIterable<A>, a: Op<A, B>, b: Op<B, C>, c: Op<C, D>, d: Op<D, E>, e: Op<E, F>, f: Op<F, G>): AsyncIterable<G>;
export function pipe<A, B, C, D, E, F, G, H>(src: AsyncIterable<A>, a: Op<A, B>, b: Op<B, C>, c: Op<C, D>, d: Op<D, E>, e: Op<E, F>, f: Op<F, G>, g: Op<G, H>): AsyncIterable<H>;
export function pipe<A, B, C, D, E, F, G, H, I>(src: AsyncIterable<A>, a: Op<A, B>, b: Op<B, C>, c: Op<C, D>, d: Op<D, E>, e: Op<E, F>, f: Op<F, G>, g: Op<G, H>, h: Op<H, I>): AsyncIterable<I>;
export function pipe<A, B, C, D, E, F, G, H, I, J>(src: AsyncIterable<A>, a: Op<A, B>, b: Op<B, C>, c: Op<C, D>, d: Op<D, E>, e: Op<E, F>, f: Op<F, G>, g: Op<G, H>, h: Op<H, I>, i: Op<I, J>): AsyncIterable<J>;
export function pipe(src: AsyncIterable<unknown>, ...ops: Op<unknown, unknown>[]): AsyncIterable<unknown> {
  return ops.reduce((acc, op) => op(acc), src);
}

export async function toArray<T>(src: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of src) out.push(v);
  return out;
}

export function map<T, R>(fn: (value: T, index: number) => R | Promise<R>): Op<T, R> {
  return async function* (src) {
    let i = 0;
    for await (const v of src) yield await fn(v, i++);
  };
}

export function filter<T, S extends T>(fn: (value: T, index: number) => value is S): Op<T, S>;
export function filter<T>(fn: (value: T, index: number) => boolean | Promise<boolean>): Op<T, T>;
export function filter<T>(fn: (value: T, index: number) => boolean | Promise<boolean>): Op<T, T> {
  return async function* (src) {
    let i = 0;
    for await (const v of src) if (await fn(v, i++)) yield v;
  };
}

export function take<T>(n: number): Op<T, T> {
  return async function* (src) {
    if (n <= 0) return;
    let taken = 0;
    for await (const v of src) {
      yield v;
      if (++taken >= n) return; // for-await calls src.return() on early exit
    }
  };
}

export type BufferSpec = number | { ms: number };

/** buffer(n): arrays of n items. buffer({ ms }): everything that arrived within ms of the first item. */
export function buffer<T>(spec: BufferSpec): Op<T, T[]> {
  if (typeof spec === 'number') {
    const n = Math.max(1, spec);
    return async function* (src) {
      let chunk: T[] = [];
      for await (const v of src) {
        chunk.push(v);
        if (chunk.length >= n) {
          yield chunk;
          chunk = [];
        }
      }
      if (chunk.length > 0) yield chunk;
    };
  }
  const ms = spec.ms;
  return src =>
    bridge<T[]>(sink => {
      let chunk: T[] = [];
      let timer: ReturnType<typeof setTimeout> | undefined;
      const flush = () => {
        timer = undefined;
        if (chunk.length > 0) {
          sink.emit(chunk);
          chunk = [];
        }
      };
      const stop = consume(src, {
        value: v => {
          chunk.push(v);
          timer ??= setTimeout(flush, ms);
        },
        end: () => {
          clearTimeout(timer);
          flush();
          sink.end();
        },
        error: err => sink.fail(err),
      });
      return () => {
        clearTimeout(timer);
        stop();
      };
    });
}

/** Emits the latest value once no new value has arrived for `ms`. Flushes on source end. */
export function debounce<T>(ms: number): Op<T, T> {
  return src =>
    bridge<T>(sink => {
      let pending: { value: T } | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const fire = () => {
        timer = undefined;
        if (pending) {
          const { value } = pending;
          pending = undefined;
          sink.emit(value);
        }
      };
      const stop = consume(src, {
        value: v => {
          pending = { value: v };
          clearTimeout(timer);
          timer = setTimeout(fire, ms);
        },
        end: () => {
          clearTimeout(timer);
          fire();
          sink.end();
        },
        error: err => sink.fail(err),
      });
      return () => {
        clearTimeout(timer);
        stop();
      };
    });
}

/** Emits the first value immediately, then at most one value per `ms` window (trailing). */
export function throttle<T>(ms: number): Op<T, T> {
  return src =>
    bridge<T>(sink => {
      let trailing: { value: T } | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const openWindow = () => {
        timer = setTimeout(() => {
          timer = undefined;
          if (trailing) {
            const { value } = trailing;
            trailing = undefined;
            sink.emit(value);
            openWindow();
          }
        }, ms);
      };
      const stop = consume(src, {
        value: v => {
          if (timer === undefined) {
            sink.emit(v);
            openWindow();
          } else {
            trailing = { value: v };
          }
        },
        end: () => {
          clearTimeout(timer);
          if (trailing) sink.emit(trailing.value);
          sink.end();
        },
        error: err => sink.fail(err),
      });
      return () => {
        clearTimeout(timer);
        stop();
      };
    });
}

/** Drops values equal to the previous one. Default comparison is Object.is. */
export function distinctUntilChanged<T>(equals: (a: T, b: T) => boolean = Object.is): Op<T, T> {
  return async function* (src) {
    let first = true;
    let prev: T | undefined;
    for await (const v of src) {
      if (first || !equals(prev as T, v)) yield v;
      first = false;
      prev = v;
    }
  };
}

/** Emits the running accumulation after every value. */
export function scan<T, A>(fn: (acc: A, value: T, index: number) => A | Promise<A>, seed: A): Op<T, A> {
  return async function* (src) {
    let acc = seed;
    let i = 0;
    for await (const v of src) {
      acc = await fn(acc, v, i++);
      yield acc;
    }
  };
}

/** Runs a side effect per value without changing the stream. */
export function tap<T>(fn: (value: T, index: number) => unknown): Op<T, T> {
  return async function* (src) {
    let i = 0;
    for await (const v of src) {
      await fn(v, i++);
      yield v;
    }
  };
}

type ValueOf<S> = S extends AsyncIterable<infer V> ? V : never;

/** Interleaves several sources as they produce. Ends when all end; one failure fails all. */
export function merge<const S extends readonly AsyncIterable<unknown>[]>(...sources: S): AsyncIterable<ValueOf<S[number]>> {
  type T = ValueOf<S[number]>;
  return bridge<T>(sink => {
    let open = sources.length;
    if (open === 0) sink.end();
    const stops = sources.map(src =>
      consume(src as AsyncIterable<T>, {
        value: v => sink.emit(v),
        end: () => {
          if (--open === 0) sink.end();
        },
        error: err => {
          sink.fail(err);
          stopAll();
        },
      }),
    );
    const stopAll = () => {
      for (const s of stops) s();
    };
    return stopAll;
  });
}

export interface FlatMapOptions {
  /** Max inner iterables consumed at once. Default Infinity. */
  concurrency?: number;
}

type FlatMapResult<R> = AsyncIterable<R> | Iterable<R> | Promise<R> | R;

const isIterableLike = (v: unknown): v is AsyncIterable<unknown> | Iterable<unknown> =>
  typeof v === 'object' && v !== null && (Symbol.asyncIterator in v || Symbol.iterator in v);

/**
 * Maps each value to an inner iterable (or a promise/value) and flattens, consuming at most
 * `concurrency` inners at once. Order across inners is arrival order.
 */
export function flatMap<T, R>(
  fn: (value: T, index: number) => FlatMapResult<R>,
  opts: FlatMapOptions = {},
): Op<T, R> {
  const concurrency = Math.max(1, opts.concurrency ?? Infinity);
  return src =>
    bridge<R>(sink => {
      const it = src[Symbol.asyncIterator]();
      let active = 0;
      let index = 0;
      let sourceDone = false;
      let stopped = false;
      const waiters: Array<() => void> = [];
      const slotFreed = () => {
        active--;
        waiters.shift()?.();
        if (sourceDone && active === 0) sink.end();
      };
      const stop = () => {
        if (stopped) return;
        stopped = true;
        for (const w of waiters.splice(0)) w();
        Promise.resolve(it.return?.()).catch(() => {});
      };
      const runInner = async (value: T, i: number) => {
        try {
          const inner = await fn(value, i);
          if (isIterableLike(inner)) {
            for await (const v of inner as AsyncIterable<R>) {
              if (stopped) return;
              sink.emit(v);
            }
          } else {
            sink.emit(inner);
          }
        } catch (err) {
          sink.fail(err);
          stop();
        } finally {
          slotFreed();
        }
      };
      void (async () => {
        try {
          for (;;) {
            for (;;) {
              if (stopped || active < concurrency) break;
              await new Promise<void>(r => waiters.push(r));
            }
            if (stopped) return;
            const r = await it.next();
            if (stopped) return;
            if (r.done) {
              sourceDone = true;
              if (active === 0) sink.end();
              return;
            }
            active++;
            void runInner(r.value, index++);
          }
        } catch (err) {
          if (!stopped) sink.fail(err);
        }
      })();
      return stop;
    });
}

/** Fails with TimeoutError if the source stays silent for `ms` between values. */
export function timeout<T>(ms: number): Op<T, T> {
  return src =>
    bridge<T>(sink => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          sink.fail(timeoutError(`No value for ${ms}ms`));
          stop();
        }, ms);
      };
      const stop = consume(src, {
        value: v => {
          arm();
          sink.emit(v);
        },
        end: () => {
          clearTimeout(timer);
          sink.end();
        },
        error: err => {
          clearTimeout(timer);
          sink.fail(err);
        },
      });
      arm();
      return () => {
        clearTimeout(timer);
        stop();
      };
    });
}

/** Iterates a ReadableStream (Safari lacks the native async iterator). Cancels it on early exit. */
export async function* fromReadableStream<T>(stream: ReadableStream<T>): AsyncGenerator<T, void, undefined> {
  const reader = stream.getReader();
  let done = false;
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) {
        done = true;
        return;
      }
      yield r.value;
    }
  } finally {
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Pairs values by position; ends (and closes the others) when the shortest source ends. */
export function zip<const S extends readonly AsyncIterable<unknown>[]>(
  ...sources: S
): AsyncIterable<{ -readonly [K in keyof S]: ValueOf<S[K]> }> {
  type Tuple = { -readonly [K in keyof S]: ValueOf<S[K]> };
  return {
    async *[Symbol.asyncIterator]() {
      const its = sources.map(s => s[Symbol.asyncIterator]());
      try {
        for (;;) {
          const results = await Promise.all(its.map(it => it.next()));
          if (results.some(r => r.done)) return;
          yield results.map(r => r.value) as unknown as Tuple;
        }
      } finally {
        await Promise.allSettled(its.map(it => Promise.resolve(it.return?.())));
      }
    },
  };
}

/** Emits the latest value of every source once all have produced, then on every change. */
export function combineLatest<const S extends readonly AsyncIterable<unknown>[]>(
  ...sources: S
): AsyncIterable<{ -readonly [K in keyof S]: ValueOf<S[K]> }> {
  type Tuple = { -readonly [K in keyof S]: ValueOf<S[K]> };
  return bridge<Tuple>(sink => {
    const latest: unknown[] = Array.from({ length: sources.length });
    const has: boolean[] = sources.map(() => false);
    let open = sources.length;
    if (open === 0) sink.end();
    const stops = sources.map((src, i) =>
      consume(src, {
        value: v => {
          latest[i] = v;
          has[i] = true;
          if (has.every(Boolean)) sink.emit([...latest] as unknown as Tuple);
        },
        end: () => {
          if (--open === 0) sink.end();
        },
        error: err => {
          sink.fail(err);
          stopAll();
        },
      }),
    );
    const stopAll = () => {
      for (const s of stops) s();
    };
    return stopAll;
  });
}

interface Subscriber<T> {
  queue: T[];
  done: boolean;
  failure?: { err: unknown };
  wake?: () => void;
}

/**
 * Multicasts one source to any number of consumers: the source is pulled once, each consumer
 * sees values from the moment it joins. The source starts with the first consumer and is
 * stopped when the last one leaves.
 */
export function share<T>(source: AsyncIterable<T>): AsyncIterable<T> {
  const subscribers = new Set<Subscriber<T>>();
  let stop: (() => void) | undefined;
  let finished: { failure?: { err: unknown } } | undefined;

  const broadcast = (fn: (s: Subscriber<T>) => void) => {
    for (const s of subscribers) {
      fn(s);
      s.wake?.();
      s.wake = undefined;
    }
  };
  const start = () => {
    stop = consume(source, {
      value: v => broadcast(s => s.queue.push(v)),
      end: () => {
        finished = {};
        broadcast(s => (s.done = true));
      },
      error: err => {
        finished = { failure: { err } };
        broadcast(s => {
          s.failure = { err };
          s.done = true;
        });
      },
    });
  };
  const leave = (s: Subscriber<T>) => {
    subscribers.delete(s);
    if (subscribers.size === 0 && stop && !finished) {
      stop();
      stop = undefined;
    }
  };

  return {
    [Symbol.asyncIterator](): AsyncIterableIterator<T> {
      const sub: Subscriber<T> = { queue: [], done: finished !== undefined, failure: finished?.failure };
      if (!finished) {
        subscribers.add(sub);
        if (!stop) start();
      }
      let closed = false;
      return {
        async next() {
          for (;;) {
            if (closed) return { value: undefined, done: true };
            if (sub.queue.length > 0) return { value: sub.queue.shift()!, done: false };
            if (sub.failure) {
              const { err } = sub.failure;
              sub.failure = undefined;
              closed = true;
              leave(sub);
              throw err;
            }
            if (sub.done) {
              closed = true;
              leave(sub);
              return { value: undefined, done: true };
            }
            await new Promise<void>(r => (sub.wake = r));
          }
        },
        async return() {
          closed = true;
          sub.queue.length = 0;
          leave(sub);
          return { value: undefined, done: true };
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    },
  };
}

// ---- push-to-pull plumbing -------------------------------------------------------------

interface Sink<R> {
  emit(value: R): void;
  end(): void;
  fail(err: unknown): void;
}

/**
 * Builds a pull-based AsyncIterable from a push-based producer. `start` receives the sink and
 * returns a cleanup that runs when the consumer stops early.
 */
function bridge<R>(start: (sink: Sink<R>) => () => void): AsyncIterable<R> {
  return {
    [Symbol.asyncIterator](): AsyncIterableIterator<R> {
      const queue: R[] = [];
      let done = false;
      let failure: { err: unknown } | undefined;
      let finished = false;
      let waiter: (() => void) | undefined;
      const wake = () => {
        waiter?.();
        waiter = undefined;
      };
      const cleanup = start({
        emit: v => {
          if (finished) return;
          queue.push(v);
          wake();
        },
        end: () => {
          done = true;
          wake();
        },
        fail: err => {
          failure ??= { err };
          done = true;
          wake();
        },
      });
      return {
        async next() {
          while (true) {
            if (queue.length > 0) return { value: queue.shift()!, done: false };
            if (failure) {
              const { err } = failure;
              failure = undefined;
              finished = true;
              throw err;
            }
            if (done) {
              finished = true;
              return { value: undefined, done: true };
            }
            await new Promise<void>(r => (waiter = r));
          }
        },
        async return() {
          if (!finished) {
            finished = true;
            done = true;
            queue.length = 0;
            cleanup();
          }
          return { value: undefined, done: true };
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    },
  };
}

interface Consumer<T> {
  value(v: T): void;
  end(): void;
  error(err: unknown): void;
}

/** Drains `src` in the background. The returned stop() asks the source to finish. */
function consume<T>(src: AsyncIterable<T>, c: Consumer<T>): () => void {
  const it = src[Symbol.asyncIterator]();
  let stopped = false;
  void (async () => {
    try {
      for (;;) {
        if (stopped) break;
        const r = await it.next();
        if (stopped) break;
        if (r.done) {
          c.end();
          return;
        }
        c.value(r.value);
      }
    } catch (err) {
      if (!stopped) c.error(err);
    }
  })();
  return () => {
    if (stopped) return;
    stopped = true;
    Promise.resolve(it.return?.()).catch(() => {});
  };
}
