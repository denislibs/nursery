/** Operators over AsyncIterable. Compose with pipe(); consume with for-await or toArray(). */

export type Op<T, R> = (source: AsyncIterable<T>) => AsyncIterable<R>;

export function pipe<A>(src: AsyncIterable<A>): AsyncIterable<A>;
export function pipe<A, B>(src: AsyncIterable<A>, a: Op<A, B>): AsyncIterable<B>;
export function pipe<A, B, C>(src: AsyncIterable<A>, a: Op<A, B>, b: Op<B, C>): AsyncIterable<C>;
export function pipe<A, B, C, D>(src: AsyncIterable<A>, a: Op<A, B>, b: Op<B, C>, c: Op<C, D>): AsyncIterable<D>;
export function pipe<A, B, C, D, E>(src: AsyncIterable<A>, a: Op<A, B>, b: Op<B, C>, c: Op<C, D>, d: Op<D, E>): AsyncIterable<E>;
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
