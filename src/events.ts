import { abortError, type MaybeSignal } from './signal.js';

export interface OnOptions extends AddEventListenerOptions {
  /** Ends the iteration (gracefully) when aborted. */
  signal?: AbortSignal;
  /** Max events kept while the consumer is busy; the oldest are dropped. Default: unbounded. */
  buffer?: number;
}

/**
 * Turns DOM events into an AsyncIterable:
 *   for await (const e of on(input, 'input', { signal })) { ... }
 * Events that arrive while the consumer is busy are queued. The listener is removed when the
 * consumer breaks out of the loop or the signal aborts; abort ends the loop instead of throwing.
 */
export function on<E extends Event = Event>(
  target: EventTarget,
  type: string,
  opts: OnOptions = {},
): AsyncIterable<E> {
  const { signal, buffer = Infinity, ...listenerOpts } = opts;
  return {
    [Symbol.asyncIterator](): AsyncIterableIterator<E> {
      const queue: E[] = [];
      let finished = signal?.aborted ?? false;
      let waiter: (() => void) | undefined;
      const wake = () => {
        waiter?.();
        waiter = undefined;
      };
      const listener = (e: Event) => {
        if (finished) return;
        queue.push(e as E);
        if (queue.length > buffer) queue.shift();
        wake();
      };
      const finish = () => {
        if (finished) return;
        finished = true;
        target.removeEventListener(type, listener, listenerOpts);
        signal?.removeEventListener('abort', finish);
        wake();
      };
      if (!finished) {
        target.addEventListener(type, listener, listenerOpts);
        signal?.addEventListener('abort', finish, { once: true });
      }
      return {
        async next() {
          while (true) {
            if (queue.length > 0) return { value: queue.shift()!, done: false };
            if (finished) return { value: undefined, done: true };
            await new Promise<void>(r => (waiter = r));
          }
        },
        async return() {
          finish();
          queue.length = 0;
          return { value: undefined, done: true };
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    },
  };
}

export class ChannelClosedError extends Error {
  constructor() {
    super('Channel is closed');
    this.name = 'ChannelClosedError';
  }
}

interface Waiter<T> {
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
  detach: () => void;
}

/**
 * Go-style channel with backpressure. `capacity` 0 (default) is a rendezvous: send() waits for
 * a receiver. A positive capacity buffers that many values before send() blocks.
 */
export class Channel<T> implements AsyncIterable<T> {
  #capacity: number;
  #buffer: T[] = [];
  #receivers: Waiter<T>[] = [];
  #senders: Array<Waiter<void> & { value: T }> = [];
  #closed = false;

  constructor(capacity = 0) {
    if (capacity < 0) throw new RangeError('Channel capacity must be >= 0');
    this.#capacity = capacity;
  }

  /** Buffered values not yet received. */
  get size(): number {
    return this.#buffer.length;
  }

  get closed(): boolean {
    return this.#closed;
  }

  send(value: T, signal?: MaybeSignal): Promise<void> {
    if (this.#closed) return Promise.reject(new ChannelClosedError());
    if (signal?.aborted) return Promise.reject(signal.reason ?? abortError());
    const receiver = this.#receivers.shift();
    if (receiver) {
      receiver.detach();
      receiver.resolve(value);
      return Promise.resolve();
    }
    if (this.#buffer.length < this.#capacity) {
      this.#buffer.push(value);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const entry = this.#waiter<void>(resolve, reject, signal, this.#senders) as Waiter<void> & { value: T };
      entry.value = value;
      this.#senders.push(entry);
    });
  }

  receive(signal?: MaybeSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? abortError());
    if (this.#buffer.length > 0) {
      const value = this.#buffer.shift()!;
      const sender = this.#senders.shift();
      if (sender) {
        this.#buffer.push(sender.value);
        sender.detach();
        sender.resolve();
      }
      return Promise.resolve(value);
    }
    const sender = this.#senders.shift();
    if (sender) {
      sender.detach();
      sender.resolve();
      return Promise.resolve(sender.value);
    }
    if (this.#closed) return Promise.reject(new ChannelClosedError());
    return new Promise<T>((resolve, reject) => {
      this.#receivers.push(this.#waiter<T>(resolve, reject, signal, this.#receivers));
    });
  }

  /** No more sends. Buffered values can still be received; waiting parties are rejected. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const w of this.#receivers.splice(0)) {
      w.detach();
      w.reject(new ChannelClosedError());
    }
    for (const w of this.#senders.splice(0)) {
      w.detach();
      w.reject(new ChannelClosedError());
    }
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return {
      next: async () => {
        try {
          return { value: await this.receive(), done: false };
        } catch (err) {
          if (err instanceof ChannelClosedError) return { value: undefined, done: true };
          throw err;
        }
      },
      return: async () => {
        this.close();
        return { value: undefined, done: true };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }

  #waiter<V>(resolve: (v: V) => void, reject: (e: unknown) => void, signal: MaybeSignal, list: Waiter<V>[]): Waiter<V> {
    const entry: Waiter<V> = { resolve, reject, detach: () => {} };
    if (signal) {
      const onAbort = () => {
        const i = list.indexOf(entry);
        if (i >= 0) list.splice(i, 1);
        reject(signal.reason ?? abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      entry.detach = () => signal.removeEventListener('abort', onAbort);
    }
    return entry;
  }
}
