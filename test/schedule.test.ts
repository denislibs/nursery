import { yieldToMain, idle, frame, chunked } from '../src/schedule.js';
import { isAbort } from '../src/signal.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('yieldToMain', () => {
  test('uses scheduler.yield when available', async () => {
    const y = vi.fn(() => Promise.resolve());
    vi.stubGlobal('scheduler', { yield: y });
    await yieldToMain();
    expect(y).toHaveBeenCalledTimes(1);
  });
  test('falls back to a macrotask: microtasks queued before it run first', async () => {
    vi.stubGlobal('scheduler', undefined);
    const order: string[] = [];
    const p = yieldToMain().then(() => order.push('yield'));
    Promise.resolve().then(() => order.push('micro'));
    await p;
    expect(order).toEqual(['micro', 'yield']);
  });
  test('rejects when the signal is already aborted', async () => {
    const c = new AbortController();
    c.abort();
    await expect(yieldToMain(c.signal)).rejects.toSatisfy(isAbort);
  });
});

describe('idle', () => {
  test('uses requestIdleCallback and resolves with the deadline', async () => {
    const deadline = { didTimeout: false, timeRemaining: () => 42 };
    vi.stubGlobal('requestIdleCallback', (cb: (d: unknown) => void) => { cb(deadline); return 1; });
    vi.stubGlobal('cancelIdleCallback', vi.fn());
    await expect(idle()).resolves.toBe(deadline);
  });
  test('passes timeout through to requestIdleCallback', async () => {
    const ric = vi.fn((cb: (d: unknown) => void) => { cb({}); return 1; });
    vi.stubGlobal('requestIdleCallback', ric);
    await idle({ timeout: 500 });
    expect(ric).toHaveBeenCalledWith(expect.any(Function), { timeout: 500 });
  });
  test('falls back to a timer with a synthetic deadline', async () => {
    vi.stubGlobal('requestIdleCallback', undefined);
    const d = await idle();
    expect(typeof d.timeRemaining()).toBe('number');
    expect(d.didTimeout).toBe(false);
  });
  test('abort cancels the pending callback and rejects', async () => {
    const cancel = vi.fn();
    vi.stubGlobal('requestIdleCallback', () => 7);
    vi.stubGlobal('cancelIdleCallback', cancel);
    const c = new AbortController();
    const p = idle({ signal: c.signal });
    c.abort();
    await expect(p).rejects.toSatisfy(isAbort);
    expect(cancel).toHaveBeenCalledWith(7);
  });
});

describe('frame', () => {
  test('uses requestAnimationFrame and resolves with the timestamp', async () => {
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => { cb(123.4); return 1; });
    await expect(frame()).resolves.toBe(123.4);
  });
  test('falls back to a ~16ms timer', async () => {
    vi.stubGlobal('requestAnimationFrame', undefined);
    vi.useFakeTimers();
    let done = false;
    frame().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(15);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });
  test('abort cancels the frame request', async () => {
    const cancel = vi.fn();
    vi.stubGlobal('requestAnimationFrame', () => 9);
    vi.stubGlobal('cancelAnimationFrame', cancel);
    const c = new AbortController();
    const p = frame(c.signal);
    c.abort();
    await expect(p).rejects.toSatisfy(isAbort);
    expect(cancel).toHaveBeenCalledWith(9);
  });
});

describe('chunked', () => {
  test('yields every item and yields to main whenever the time budget is used up', async () => {
    const y = vi.fn(() => Promise.resolve());
    vi.stubGlobal('scheduler', { yield: y });
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const seen: number[] = [];
    for await (const item of chunked([1, 2, 3, 4, 5, 6], { budget: 8 })) {
      seen.push(item);
      now += 5; // each item "costs" 5ms of main-thread time
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6]);
    // 5ms per item, 8ms budget: yield after items 2, 4, 6 -> but never after the last one
    expect(y).toHaveBeenCalledTimes(2);
  });
  test('does not yield when the budget is never exceeded', async () => {
    const y = vi.fn(() => Promise.resolve());
    vi.stubGlobal('scheduler', { yield: y });
    vi.spyOn(performance, 'now').mockImplementation(() => 0);
    for await (const _ of chunked([1, 2, 3], { budget: 8 })) { /* fast */ }
    expect(y).not.toHaveBeenCalled();
  });
  test('accepts an iterable and stops on abort', async () => {
    const c = new AbortController();
    function* gen() { yield 1; yield 2; yield 3; }
    const seen: number[] = [];
    await expect((async () => {
      for await (const n of chunked(gen(), { signal: c.signal })) { seen.push(n); if (n === 2) c.abort(); }
    })()).rejects.toSatisfy(isAbort);
    expect(seen).toEqual([1, 2]);
  });
});
