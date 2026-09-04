import { isAbort, anySignal, timeoutSignal, throwIfAborted, sleep, abortError } from '../src/signal.js';

describe('isAbort', () => {
  test('recognizes DOMException AbortError', () => {
    expect(isAbort(new DOMException('x', 'AbortError'))).toBe(true);
  });
  test('recognizes TimeoutError as abort', () => {
    expect(isAbort(new DOMException('x', 'TimeoutError'))).toBe(true);
  });
  test('rejects ordinary errors', () => {
    expect(isAbort(new Error('boom'))).toBe(false);
    expect(isAbort(undefined)).toBe(false);
  });
});

describe('anySignal', () => {
  test('aborts when any input aborts, with that reason', () => {
    const a = new AbortController();
    const b = new AbortController();
    const s = anySignal([a.signal, b.signal]);
    expect(s.aborted).toBe(false);
    b.abort('why');
    expect(s.aborted).toBe(true);
    expect(s.reason).toBe('why');
  });
  test('is already aborted if any input already aborted', () => {
    const a = new AbortController();
    a.abort();
    expect(anySignal([a.signal, new AbortController().signal]).aborted).toBe(true);
  });
  test('ignores undefined inputs', () => {
    const a = new AbortController();
    const s = anySignal([undefined, a.signal]);
    a.abort();
    expect(s.aborted).toBe(true);
  });
});

describe('timeoutSignal', () => {
  test('aborts with TimeoutError after ms', async () => {
    vi.useFakeTimers();
    const s = timeoutSignal(100);
    expect(s.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(s.aborted).toBe(true);
    expect(isAbort(s.reason)).toBe(true);
    expect((s.reason as DOMException).name).toBe('TimeoutError');
    vi.useRealTimers();
  });
});

describe('throwIfAborted', () => {
  test('throws reason when aborted, noop otherwise', () => {
    const c = new AbortController();
    expect(() => throwIfAborted(c.signal)).not.toThrow();
    c.abort();
    expect(() => throwIfAborted(c.signal)).toThrow();
    expect(() => throwIfAborted(undefined)).not.toThrow();
  });
});

describe('sleep', () => {
  test('resolves after ms', async () => {
    vi.useFakeTimers();
    let done = false;
    sleep(50).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(49);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    vi.useRealTimers();
  });
  test('rejects with abort reason and clears timer on abort', async () => {
    vi.useFakeTimers();
    const c = new AbortController();
    const p = sleep(1000, c.signal);
    c.abort();
    await expect(p).rejects.toSatisfy(isAbort);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
  test('rejects immediately if signal already aborted', async () => {
    const c = new AbortController();
    c.abort();
    await expect(sleep(10, c.signal)).rejects.toSatisfy(isAbort);
  });
});

describe('abortError', () => {
  test('builds a DOMException AbortError with message', () => {
    const e = abortError('cancelled by user');
    expect(isAbort(e)).toBe(true);
    expect(e.message).toBe('cancelled by user');
  });
});

import { linkSignals, manualAnySignal } from '../src/signal.js';

describe('manualAnySignal (fallback for browsers without AbortSignal.any)', () => {
  test('aborts with the reason of the first input to abort', () => {
    const a = new AbortController();
    const b = new AbortController();
    const { signal } = manualAnySignal([a.signal, b.signal]);
    b.abort('b-reason');
    a.abort('a-reason');
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe('b-reason');
  });
  test('is aborted immediately when an input is already aborted', () => {
    const a = new AbortController();
    a.abort('early');
    const { signal } = manualAnySignal([a.signal]);
    expect(signal.reason).toBe('early');
  });
  test('unlink removes listeners so later aborts do not propagate', () => {
    const a = new AbortController();
    const { signal, unlink } = manualAnySignal([a.signal]);
    unlink();
    a.abort();
    expect(signal.aborted).toBe(false);
  });
  test('listeners are removed from every input once one aborts', () => {
    const a = new AbortController();
    const b = new AbortController();
    const spy = vi.spyOn(b.signal, 'removeEventListener');
    manualAnySignal([a.signal, b.signal]);
    a.abort();
    expect(spy).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});

describe('linkSignals', () => {
  test('returns a combined signal and an unlink function', () => {
    const a = new AbortController();
    const link = linkSignals([a.signal, undefined]);
    expect(link.signal.aborted).toBe(false);
    expect(typeof link.unlink).toBe('function');
    a.abort('x');
    expect(link.signal.reason).toBe('x');
  });
});
