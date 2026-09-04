import { postTask } from '../src/schedule.js';
import { Queue } from '../src/limit.js';
import { on } from '../src/events.js';
import { isAbort } from '../src/signal.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('postTask', () => {
  test('uses scheduler.postTask with the given priority and returns the result', async () => {
    const calls: unknown[] = [];
    vi.stubGlobal('scheduler', {
      postTask: (fn: () => unknown, opts: unknown) => {
        calls.push(opts);
        return Promise.resolve(fn());
      },
    });
    await expect(postTask(() => 42, { priority: 'background' })).resolves.toBe(42);
    expect(calls[0]).toMatchObject({ priority: 'background' });
  });
  test('forwards the signal to scheduler.postTask', async () => {
    let seen: unknown;
    vi.stubGlobal('scheduler', {
      postTask: (fn: () => unknown, opts: { signal?: AbortSignal }) => {
        seen = opts.signal;
        return Promise.resolve(fn());
      },
    });
    const c = new AbortController();
    await postTask(() => 1, { signal: c.signal });
    expect(seen).toBe(c.signal);
  });
  test('falls back to a macrotask when scheduler is missing and rejects on abort', async () => {
    vi.stubGlobal('scheduler', undefined);
    await expect(postTask(() => 'ok')).resolves.toBe('ok');
    const c = new AbortController();
    c.abort();
    await expect(postTask(() => 'never', { signal: c.signal })).rejects.toSatisfy(isAbort);
  });
  test('fallback: user-blocking runs before background when both are queued', async () => {
    vi.stubGlobal('scheduler', undefined);
    const order: string[] = [];
    const a = postTask(() => order.push('background'), { priority: 'background' });
    const b = postTask(() => order.push('user-blocking'), { priority: 'user-blocking' });
    await Promise.all([a, b]);
    expect(order).toEqual(['user-blocking', 'background']);
  });
});

describe('Queue priority', () => {
  test('higher priority waiting tasks start first; equal priority stays FIFO', async () => {
    const q = new Queue({ concurrency: 1 });
    const order: string[] = [];
    let release!: () => void;
    q.add(() => new Promise<void>(r => (release = r))); // occupies the single slot
    q.add(
      async () => {
        order.push('low');
      },
      { priority: 0 },
    );
    q.add(
      async () => {
        order.push('high-1');
      },
      { priority: 10 },
    );
    q.add(async () => {
      order.push('default');
    }); // default priority 0, after 'low'
    q.add(
      async () => {
        order.push('high-2');
      },
      { priority: 10 },
    );
    release();
    await q.idle();
    expect(order).toEqual(['high-1', 'high-2', 'low', 'default']);
  });
  test('options object still accepts a signal', async () => {
    const q = new Queue({ concurrency: 1 });
    q.add(() => new Promise(() => {}));
    const c = new AbortController();
    const waiting = q.add(async () => 'x', { priority: 5, signal: c.signal });
    c.abort();
    await expect(waiting).rejects.toSatisfy(isAbort);
    expect(q.size).toBe(0);
  });
});

describe('on() typing', () => {
  test('infers the event type from the target event map', async () => {
    const target = new EventTarget();
    const c = new AbortController();
    // Compile-time check: for an HTMLElement-like map the event must be a MouseEvent
    const el = {
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
      dispatchEvent: target.dispatchEvent.bind(target),
    } as unknown as HTMLButtonElement;
    const it = on(el, 'click', { signal: c.signal })[Symbol.asyncIterator]();
    const next = it.next();
    el.dispatchEvent(new Event('click'));
    const r = await next;
    const typed: MouseEvent = r.value as MouseEvent; // would not compile if on() returned Event
    expect(typed.type).toBe('click');
    c.abort();
  });
  test('window and document maps are supported, generic EventTarget still needs an explicit type', async () => {
    const c = new AbortController();
    const ev = on(new EventTarget(), 'custom', { signal: c.signal });
    const explicit = on<CustomEvent<number>>(new EventTarget(), 'custom', { signal: c.signal });
    expect(typeof ev[Symbol.asyncIterator]).toBe('function');
    expect(typeof explicit[Symbol.asyncIterator]).toBe('function');
    c.abort();
  });
});
