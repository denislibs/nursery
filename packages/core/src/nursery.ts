/// <reference lib="esnext.disposable" />
import './polyfill.js';
import { linkSignals, abortError, isAbort, timeoutError, type MaybeSignal } from './signal.js';

/** Typed context key. Create with contextKey(); bind a value with key.with(value). */
export class ContextKey<T> {
  constructor(
    readonly name: string,
    readonly defaultValue?: T,
  ) {}
  with(value: T): ContextBinding<T> {
    return { key: this, value };
  }
}

export interface ContextBinding<T> {
  key: ContextKey<T>;
  value: T;
}

export function contextKey<T>(name: string): ContextKey<T | undefined>;
export function contextKey<T>(name: string, defaultValue: T): ContextKey<T>;
export function contextKey<T>(name: string, defaultValue?: T): ContextKey<T | undefined> {
  return new ContextKey<T | undefined>(name, defaultValue);
}

export interface NurseryOptions {
  /** Shown in inspect()/dump() and in unhandled-error reports. */
  name?: string;
  /** External signal the nursery is linked to. */
  signal?: MaybeSignal;
  /** Abort the nursery with TimeoutError after this many ms. Also sets `deadline`. */
  timeout?: number;
  /** Default grace period for close(): how long to wait for tasks that ignore the signal. */
  grace?: number;
  /** Context bindings, layered over the parent's. Stand-in for AsyncContext. */
  ctx?: readonly ContextBinding<unknown>[];
}

export interface SpawnOptions {
  name?: string;
}

export interface ChildOptions {
  /**
   * Do not track the child in `parent.children`: the parent still cancels it through the
   * signal but does not wait for it on close. Call `parent.adopt(child)` to start tracking.
   * Useful when a framework may create and discard a nursery before committing it (React StrictMode).
   */
  detached?: boolean;
}

export interface CloseOptions {
  /** Stop waiting after this many ms; stuck tasks are reported via Nursery.onUnhandled. */
  grace?: number;
}

/** A cancellable unit of work owned by a nursery. */
export type NurseryTask<T> = (signal: AbortSignal, nursery: Nursery) => Promise<T>;

export interface TaskInfo {
  readonly name: string;
  /** performance.now() when the task started. */
  readonly startedAt: number;
  /** ms since start. */
  readonly elapsed: number;
}

export interface NurseryTree {
  name: string;
  closed: boolean;
  aborted: boolean;
  tasks: TaskInfo[];
  children: NurseryTree[];
}

export interface UnhandledContext {
  nursery: Nursery;
  task?: TaskInfo;
}
export type UnhandledHandler = (error: unknown, ctx: UnhandledContext) => void;

export class NurseryClosedError extends Error {
  constructor() {
    super('Nursery is closed');
    this.name = 'NurseryClosedError';
  }
}

/** Reported when close({ grace }) gave up waiting on tasks that ignore their signal. */
export class NurseryStuckError extends Error {
  constructor(
    readonly nurseryName: string,
    readonly tasks: TaskInfo[],
  ) {
    super(
      `Nursery "${nurseryName}" closed with ${tasks.length} stuck task(s): ${tasks
        .map(t => `${t.name} (${Math.round(t.elapsed)}ms)`)
        .join(', ')}`,
    );
    this.name = 'NurseryStuckError';
  }
}

/**
 * Promise returned by spawn(). Records whether anyone attached a handler through the public
 * `then`, so an ignored failure can be reported. Internal bookkeeping bypasses the override.
 */
class TrackedPromise<T> extends Promise<T> {
  handled = false;
  static get [Symbol.species]() {
    return Promise;
  }
  // It is a real Promise subclass; overriding then() is the whole point.
  // oxlint-disable-next-line unicorn/no-thenable
  override then<R1 = T, R2 = never>(
    onfulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    this.handled = true;
    return super.then(onfulfilled, onrejected);
  }
}

interface TaskRecord {
  name: string;
  startedAt: number;
  inner: Promise<unknown>;
  outer?: TrackedPromise<unknown>;
  error?: { err: unknown };
}

const unhandledHandlers = new Set<UnhandledHandler>();
let nurseryCounter = 0;

// Implicit "current nursery": AsyncContext.Variable when the platform has it (survives awaits),
// otherwise a synchronous stack that is only valid until the first await.
interface AsyncVariable<T> {
  get(): T | undefined;
  run<R>(value: T, fn: () => R): R;
}
const AsyncContextVariable = (globalThis as { AsyncContext?: { Variable?: new <T>() => AsyncVariable<T> } })
  .AsyncContext?.Variable;
const asyncVar: AsyncVariable<Nursery> | undefined = AsyncContextVariable
  ? new AsyncContextVariable<Nursery>()
  : undefined;
let syncCurrent: Nursery | undefined;

type TaskStatus = 'ok' | 'error' | 'aborted';
function measure(name: string, start: number, detail: Record<string, unknown>): void {
  try {
    performance.measure(name, { start, end: performance.now(), detail });
  } catch {
    // performance.measure with options is unavailable in very old engines; profiling is best-effort
  }
}

function report(error: unknown, ctx: UnhandledContext): void {
  if (unhandledHandlers.size === 0) {
    // Default sink: nobody subscribed, so the error must at least reach the console.
    // oxlint-disable-next-line no-console
    console.error('[nursery] unhandled task error in nursery "%s":', ctx.nursery.name, error);
    return;
  }
  for (const h of unhandledHandlers) h(error, ctx);
}

/**
 * Structured-concurrency nursery: one AbortSignal, one context, a tracked set of children.
 * - spawn() runs a task bound to the nursery's signal.
 * - The first non-abort failure of a child aborts every sibling (fail-fast).
 * - close() (or `await using`) aborts what is still running and waits for everything to settle.
 */
export class Nursery implements AsyncDisposable {
  /** When true, every task and nursery lifetime is recorded via performance.measure('nursery:...'). */
  static profiling = false;

  readonly name: string;
  readonly signal: AbortSignal;
  /** Absolute performance.now() deadline, the earliest of this nursery's and its ancestors'. */
  readonly deadline: number | undefined;
  readonly #createdAt = performance.now();

  #parent: Nursery | undefined;
  #bindings = new Map<ContextKey<unknown>, unknown>();
  #ctrl = new AbortController();
  #unlink: () => void;
  #tasks = new Set<TaskRecord>();
  #children = new Set<Nursery>();
  #cleanups: Array<() => unknown> = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #grace: number | undefined;
  #error: unknown;
  #surfaces = false;
  #closed = false;
  #closing: Promise<void> | undefined;
  #taskCounter = 0;
  #stuckCount = 0;

  constructor(opts: NurseryOptions = {}, parent?: Nursery) {
    this.name = opts.name ?? `nursery#${++nurseryCounter}`;
    this.#parent = parent;
    this.#grace = opts.grace ?? (parent ? parent.#grace : undefined);
    for (const b of opts.ctx ?? []) this.#bindings.set(b.key, b.value);
    const link = linkSignals([this.#ctrl.signal, opts.signal, parent?.signal]);
    this.signal = link.signal;
    this.#unlink = link.unlink;
    const own = opts.timeout === undefined ? undefined : performance.now() + opts.timeout;
    this.deadline =
      own === undefined
        ? parent?.deadline
        : parent?.deadline === undefined
          ? own
          : Math.min(own, parent.deadline);
    if (opts.timeout !== undefined) {
      this.#timer = setTimeout(
        () => this.abort(timeoutError(`Nursery "${this.name}" timed out after ${opts.timeout}ms`)),
        opts.timeout,
      );
    }
  }

  /**
   * The nursery whose task is currently executing. Reliable in the synchronous part of a task or
   * of enter(); across awaits only where AsyncContext exists. Prefer passing the nursery explicitly.
   */
  static current(): Nursery | undefined {
    return asyncVar ? asyncVar.get() : syncCurrent;
  }

  /** Runs `fn` with this nursery as Nursery.current(). */
  enter<R>(fn: () => R): R {
    if (asyncVar) return asyncVar.run(this, fn);
    const prev = syncCurrent;
    // oxlint-disable-next-line typescript/no-this-alias -- module-level "current nursery" slot
    syncCurrent = this;
    try {
      return fn();
    } finally {
      syncCurrent = prev;
    }
  }

  /** Subscribes to failures nobody handled and to stuck tasks. Returns an unsubscribe. */
  static onUnhandled(handler: UnhandledHandler): () => void {
    unhandledHandlers.add(handler);
    return () => unhandledHandlers.delete(handler);
  }

  /** Runs `body` inside a fresh nursery and closes it afterwards, whatever happens. */
  static async run<T>(body: (nursery: Nursery) => Promise<T>, opts: NurseryOptions = {}): Promise<T> {
    const nursery = new Nursery(opts);
    nursery.#surfaces = true;
    let result: T;
    try {
      result = await nursery.enter(() => body(nursery));
    } catch (err) {
      await nursery.close();
      // The body usually dies of the AbortError caused by a failing sibling; surface the cause.
      throw nursery.#error !== undefined && isAbort(err) ? nursery.#error : err;
    }
    await nursery.close();
    if (nursery.#error !== undefined) throw nursery.#error;
    return result;
  }

  /** First non-abort error thrown by a child, if any. */
  get error(): unknown {
    return this.#error;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Currently running tasks. */
  get tasks(): TaskInfo[] {
    return [...this.#tasks].map(taskInfo);
  }

  /** Open child nurseries. */
  get children(): Nursery[] {
    return [...this.#children];
  }

  /** ms left until the deadline, Infinity without one. */
  remaining(): number {
    return this.deadline === undefined ? Infinity : Math.max(0, this.deadline - performance.now());
  }

  /** Reads a context value: own bindings first, then ancestors, then the key default. */
  get<T>(key: ContextKey<T>): T {
    if (this.#bindings.has(key)) return this.#bindings.get(key) as T;
    if (this.#parent) return this.#parent.get(key);
    return key.defaultValue as T;
  }

  /** True if the key is bound explicitly in this nursery or an ancestor. */
  has(key: ContextKey<unknown>): boolean {
    return this.#bindings.has(key) || (this.#parent?.has(key) ?? false);
  }

  /** Runs `task` with this nursery's signal. Failure aborts the siblings. */
  spawn<T>(task: NurseryTask<T>, opts: SpawnOptions = {}): Promise<T> {
    if (this.#closed) return Promise.reject(new NurseryClosedError());
    const inner = this.enter(() => (async () => task(this.signal, this))());
    const rec: TaskRecord = {
      name: opts.name ?? `task#${++this.#taskCounter}`,
      startedAt: performance.now(),
      inner,
    };
    this.#tasks.add(rec);
    if (Nursery.profiling) {
      const record = (status: TaskStatus) =>
        measure(`nursery:${this.name}/${rec.name}`, rec.startedAt, {
          nursery: this.name,
          task: rec.name,
          status,
        });
      inner.then(
        () => record('ok'),
        err => record(isAbort(err) ? 'aborted' : 'error'),
      );
    }
    const outer = new TrackedPromise<T>((resolve, reject) => {
      inner.then(resolve, reject);
    });
    rec.outer = outer;
    // Internal handler on the wrapper so the platform never sees an unhandled rejection.
    void Promise.prototype.then.call(outer, undefined, () => {});
    inner.then(
      () => this.#tasks.delete(rec),
      err => {
        this.#tasks.delete(rec);
        if (isAbort(err)) return;
        rec.error = { err };
        if (this.#error === undefined) {
          this.#error = err;
          const reason = abortError('Sibling task failed');
          Object.defineProperty(reason, 'cause', { value: err, configurable: true, writable: true });
          this.abort(reason);
        }
        // Give the caller a macrotask to attach a handler, then report if nobody did.
        setTimeout(() => this.#checkUnhandled(rec), 0);
      },
    );
    return outer;
  }

  /** A nested nursery: inherits ctx, cancellation and deadline; closing the parent waits for it. */
  child(opts: NurseryOptions = {}, childOpts: ChildOptions = {}): Nursery {
    const nursery = new Nursery(opts, this);
    if (!childOpts.detached) this.#children.add(nursery);
    return nursery;
  }

  /** Starts tracking a child created with `{ detached: true }`. Idempotent. */
  adopt(child: Nursery): void {
    if (child.#parent !== this) throw new TypeError('adopt(): nursery is not a child of this nursery');
    if (!child.#closed && !this.#closed) this.#children.add(child);
  }

  /** Registers cleanup run on close(), after children settle, in reverse order. */
  defer(fn: () => unknown): void {
    this.#cleanups.push(fn);
  }

  abort(reason: unknown = abortError(`Nursery "${this.name}" aborted`)): void {
    this.#ctrl.abort(reason);
  }

  /** Resolves once every task and child nursery has settled (does not abort anything). */
  async settled(): Promise<void> {
    while (this.#tasks.size > 0 || this.#children.size > 0) {
      await Promise.allSettled([
        ...[...this.#tasks].map(t => t.inner),
        ...[...this.#children].map(c => c.settled()),
      ]);
    }
  }

  /**
   * Aborts running tasks, waits for them (up to `grace` ms if given), closes child nurseries,
   * then runs deferred cleanups. Idempotent.
   */
  close(opts: CloseOptions = {}): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closing = this.#doClose(opts.grace ?? this.#grace);
    return this.#closing;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  /** Snapshot of this nursery and its descendants. */
  inspect(): NurseryTree {
    return {
      name: this.name,
      closed: this.#closed,
      aborted: this.signal.aborted,
      tasks: this.tasks,
      children: [...this.#children].map(c => c.inspect()),
    };
  }

  /** Human-readable tree of nurseries and running tasks. */
  dump(): string {
    const lines: string[] = [];
    const walk = (t: NurseryTree, indent: string) => {
      const state = t.closed ? 'closed' : t.aborted ? 'aborting' : 'open';
      lines.push(`${indent}${t.name} [${state}]`);
      for (const task of t.tasks) lines.push(`${indent}  - ${task.name} ${Math.round(task.elapsed)}ms`);
      for (const c of t.children) walk(c, indent + '  ');
    };
    walk(this.inspect(), '');
    return lines.join('\n');
  }

  async #doClose(grace: number | undefined): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#timer);
    if (!this.signal.aborted) this.abort(abortError(`Nursery "${this.name}" closed`));
    for (const c of this.#children) void c.close({ grace });
    await this.#awaitSettled(grace);
    while (this.#cleanups.length > 0) {
      await this.#cleanups.pop()!();
    }
    if (this.#parent) this.#parent.#children.delete(this);
    this.#unlink();
    if (Nursery.profiling)
      measure(`nursery:${this.name}`, this.#createdAt, { nursery: this.name, stuck: this.#stuckCount });
  }

  async #awaitSettled(grace: number | undefined): Promise<void> {
    if (grace === undefined) return this.settled();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>(r => (timer = setTimeout(() => r('timeout'), grace)));
    const outcome = await Promise.race([this.settled().then(() => 'settled' as const), timeout]);
    clearTimeout(timer);
    if (outcome === 'settled') return;
    const stuck = this.#collectStuck();
    this.#stuckCount = stuck.length;
    if (stuck.length > 0) report(new NurseryStuckError(this.name, stuck), { nursery: this });
    // Detach: cleanups still run, but we stop waiting for tasks that will never finish.
    this.#tasks.clear();
    for (const c of this.#children) c.#detachStuck();
    this.#children.clear();
  }

  #collectStuck(): TaskInfo[] {
    const own = [...this.#tasks].map(taskInfo);
    const nested = [...this.#children].flatMap(c => c.#collectStuck());
    return [...own, ...nested];
  }

  #detachStuck(): void {
    this.#tasks.clear();
    for (const c of this.#children) c.#detachStuck();
    this.#children.clear();
  }

  #checkUnhandled(rec: TaskRecord): void {
    if (!rec.error || rec.outer?.handled) return;
    if (this.#surfaces && rec.error.err === this.#error) return; // Nursery.run rethrows it
    report(rec.error.err, { nursery: this, task: taskInfo(rec) });
  }
}

function taskInfo(rec: TaskRecord): TaskInfo {
  const startedAt = rec.startedAt;
  return {
    name: rec.name,
    startedAt,
    get elapsed() {
      return performance.now() - startedAt;
    },
  };
}
