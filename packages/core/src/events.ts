/// <reference lib="dom" />
import { abortError, type MaybeSignal } from './signal.js';
import { warn } from './diagnostics.js';

export interface OnOptions extends AddEventListenerOptions {
  /** Ends the iteration (gracefully) when aborted. */
  signal?: AbortSignal;
  /** Max events kept while the consumer is busy; the oldest are dropped. Default: unbounded. */
  buffer?: number;
  /**
   * With an unbounded buffer, emit an 'event-backlog' warning (once) when this many events are
   * waiting: a sign the consumer cannot keep up. Default 1000.
   */
  warnAt?: number;
}

/**
 * Turns DOM events into an AsyncIterable:
 *   for await (const e of on(input, 'input', { signal })) { ... }
 * Events that arrive while the consumer is busy are queued. The listener is removed when the
 * consumer breaks out of the loop or the signal aborts; abort ends the loop instead of throwing.
 */
export function on<K extends keyof HTMLElementEventMap>(
  target: HTMLElement,
  type: K,
  opts?: OnOptions,
): AsyncIterable<HTMLElementEventMap[K]>;
export function on<K extends keyof DocumentEventMap>(
  target: Document,
  type: K,
  opts?: OnOptions,
): AsyncIterable<DocumentEventMap[K]>;
export function on<K extends keyof WindowEventMap>(
  target: Window,
  type: K,
  opts?: OnOptions,
): AsyncIterable<WindowEventMap[K]>;
export function on<K extends keyof WebSocketEventMap>(
  target: WebSocket,
  type: K,
  opts?: OnOptions,
): AsyncIterable<WebSocketEventMap[K]>;
export function on<K extends keyof WorkerEventMap>(
  target: Worker,
  type: K,
  opts?: OnOptions,
): AsyncIterable<WorkerEventMap[K]>;
export function on<E extends Event = Event>(
  target: EventTarget,
  type: string,
  opts?: OnOptions,
): AsyncIterable<E>;
export function on<E extends Event = Event>(
  target: EventTarget,
  type: string,
  opts: OnOptions = {},
): AsyncIterable<E> {
  const { signal, buffer = Infinity, warnAt = 1000, ...listenerOpts } = opts;
  return {
    [Symbol.asyncIterator](): AsyncIterableIterator<E> {
      const queue: E[] = [];
      let finished = signal?.aborted ?? false;
      let warned = false;
      let waiter: (() => void) | undefined;
      const wake = () => {
        waiter?.();
        waiter = undefined;
      };
      const listener = (e: Event) => {
        if (finished) return;
        queue.push(e as E);
        if (queue.length > buffer) queue.shift();
        else if (!warned && queue.length > warnAt) {
          warned = true;
          warn(
            'event-backlog',
            `on(${type}): ${queue.length} events are waiting for a slow consumer; pass { buffer } to bound the queue`,
            { type, size: queue.length },
          );
        }
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

// Channel is invariant in T because of its private fields, so a heterogeneous tuple needs `any`.
// oxlint-disable-next-line typescript/no-explicit-any
export type AnyChannel = Channel<any>;

type SelectAny = { index: number; value: unknown } | { index: -1; closed: true };

export type SelectResult<T extends readonly AnyChannel[]> =
  | {
      [K in keyof T]: T[K] extends Channel<infer V>
        ? { index: K extends `${infer N extends number}` ? N : number; value: V }
        : never;
    }[number]
  | { index: -1; closed: true };

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

  /** Delivers or buffers without waiting. Returns false when the channel is full. Throws if closed. */
  trySend(value: T): boolean {
    if (this.#closed) throw new ChannelClosedError();
    const receiver = this.#receivers.shift();
    if (receiver) {
      receiver.detach();
      receiver.resolve(value);
      return true;
    }
    if (this.#buffer.length < this.#capacity) {
      this.#buffer.push(value);
      return true;
    }
    return false;
  }

  /** Takes a value if one is available (buffered or offered by a waiting sender) without waiting. */
  tryReceive(): { ok: true; value: T } | { ok: false } {
    if (this.#buffer.length > 0) {
      const value = this.#buffer.shift()!;
      const sender = this.#senders.shift();
      if (sender) {
        this.#buffer.push(sender.value);
        sender.detach();
        sender.resolve();
      }
      return { ok: true, value };
    }
    const sender = this.#senders.shift();
    if (sender) {
      sender.detach();
      sender.resolve();
      return { ok: true, value: sender.value };
    }
    return { ok: false };
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

  /**
   * Waits for the first channel that can deliver a value (Go's select). Nothing is consumed
   * from the others. Resolves `{ index: -1, closed: true }` once every channel is closed and empty.
   */
  static select<const T extends readonly AnyChannel[]>(
    channels: T,
    signal?: MaybeSignal,
  ): Promise<SelectResult<T>> {
    return Channel.#selectAny(channels, signal) as Promise<SelectResult<T>>;
  }

  static #selectAny(channels: readonly AnyChannel[], signal: MaybeSignal): Promise<SelectAny> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? abortError());
    for (let index = 0; index < channels.length; index++) {
      const ch = channels[index]!;
      if (ch.#buffer.length > 0 || ch.#senders.length > 0) {
        return ch.receive().then((value: unknown) => ({ index, value }));
      }
    }
    if (channels.every(ch => ch.#closed)) return Promise.resolve({ index: -1, closed: true });
    return new Promise<SelectAny>((resolve, reject) => {
      const entries: Array<[AnyChannel, Waiter<unknown>]> = [];
      const detachAll = () => {
        for (const [ch, e] of entries) {
          const i = ch.#receivers.indexOf(e);
          if (i >= 0) ch.#receivers.splice(i, 1);
        }
        entries.length = 0;
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        detachAll();
        reject(signal!.reason ?? abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      channels.forEach((ch, index) => {
        if (ch.#closed) return;
        const entry: Waiter<unknown> = {
          resolve: value => {
            detachAll();
            resolve({ index, value });
          },
          reject: () => {
            const i = entries.findIndex(([, e]) => e === entry);
            if (i >= 0) entries.splice(i, 1);
            if (entries.length === 0) {
              signal?.removeEventListener('abort', onAbort);
              resolve({ index: -1, closed: true });
            }
          },
          detach: () => {},
        };
        entries.push([ch, entry]);
        ch.#receivers.push(entry);
      });
      if (entries.length === 0) {
        signal?.removeEventListener('abort', onAbort);
        resolve({ index: -1, closed: true });
      }
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

  #waiter<V>(
    resolve: (v: V) => void,
    reject: (e: unknown) => void,
    signal: MaybeSignal,
    list: Waiter<V>[],
  ): Waiter<V> {
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

/** Standalone alias of Channel.select. */
export const select: typeof Channel.select = Channel.select.bind(Channel);
