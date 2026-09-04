import { anySignal, abortError, isAbort, timeoutError, type MaybeSignal } from './signal.js';
import type { Task } from './combine.js';

export type Ctx = Readonly<Record<string, unknown>>;

export interface ScopeOptions {
  /** External signal the scope is linked to. */
  signal?: MaybeSignal;
  /** Abort the scope with TimeoutError after this many ms. */
  timeout?: number;
  /** Context values, merged over the parent's. Stand-in for AsyncContext. */
  ctx?: Record<string, unknown>;
}

export class ScopeClosedError extends Error {
  constructor() {
    super('Scope is closed');
    this.name = 'ScopeClosedError';
  }
}

/**
 * Structured-concurrency scope: one AbortSignal, one context, a tracked set of children.
 * - spawn() runs a task bound to the scope's signal.
 * - The first non-abort failure of a child aborts every sibling (fail-fast).
 * - close() (or `await using`) aborts what is still running and waits for everything to settle.
 */
export class Scope implements AsyncDisposable {
  readonly signal: AbortSignal;
  readonly ctx: Ctx;

  #ctrl = new AbortController();
  #children = new Set<Promise<unknown>>();
  #cleanups: Array<() => unknown> = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #error: unknown;
  #closed = false;

  constructor(opts: ScopeOptions = {}, parent?: Scope) {
    this.ctx = Object.freeze({ ...(parent?.ctx ?? {}), ...(opts.ctx ?? {}) });
    this.signal = anySignal([this.#ctrl.signal, opts.signal, parent?.signal]);
    if (opts.timeout !== undefined) {
      this.#timer = setTimeout(
        () => this.abort(timeoutError(`Scope timed out after ${opts.timeout}ms`)),
        opts.timeout,
      );
    }
  }

  /** Runs `body` inside a fresh scope and closes it afterwards, whatever happens. */
  static async run<T>(body: (scope: Scope) => Promise<T>, opts: ScopeOptions = {}): Promise<T> {
    const scope = new Scope(opts);
    let result: T;
    try {
      result = await body(scope);
    } catch (err) {
      await scope.close();
      throw err;
    }
    await scope.close();
    if (scope.error !== undefined) throw scope.error;
    return result;
  }

  /** First non-abort error thrown by a child, if any. */
  get error(): unknown {
    return this.#error;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Runs `task` with this scope's signal. Failure aborts the siblings. */
  spawn<T>(task: Task<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new ScopeClosedError());
    const p = (async () => task(this.signal))();
    // Attach a handler so an un-awaited failure never becomes an unhandled rejection;
    // callers who await `p` still get the rejection.
    p.catch(err => {
      if (!isAbort(err) && this.#error === undefined) {
        this.#error = err;
        const reason = abortError('Sibling task failed');
        Object.defineProperty(reason, 'cause', { value: err, configurable: true, writable: true });
        this.abort(reason);
      }
    });
    this.#track(p);
    return p;
  }

  /** A nested scope: inherits ctx and cancellation; closing the parent waits for it. */
  child(opts: ScopeOptions = {}): Scope {
    const scope = new Scope(opts, this);
    this.#track(scope.settled());
    this.#cleanups.push(() => scope.close());
    return scope;
  }

  /** Registers cleanup run on close(), after children settle, in reverse order. */
  defer(fn: () => unknown): void {
    this.#cleanups.push(fn);
  }

  abort(reason: unknown = abortError('Scope aborted')): void {
    this.#ctrl.abort(reason);
  }

  /** Resolves once every spawned child has settled (does not abort anything). */
  async settled(): Promise<void> {
    while (this.#children.size > 0) {
      await Promise.allSettled([...this.#children]);
    }
  }

  /** Aborts running children, waits for them, then runs deferred cleanups. Idempotent. */
  async close(): Promise<void> {
    if (this.#closed) return this.settled();
    this.#closed = true;
    clearTimeout(this.#timer);
    if (!this.signal.aborted) this.abort(abortError('Scope closed'));
    await this.settled();
    while (this.#cleanups.length > 0) {
      await this.#cleanups.pop()!();
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  #track(p: Promise<unknown>): void {
    this.#children.add(p);
    p.finally(() => this.#children.delete(p)).catch(() => {});
  }
}
