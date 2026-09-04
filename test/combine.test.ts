import { withTimeout, retry, race, settle } from '../src/combine.js';
import { isAbort, sleep } from '../src/signal.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('withTimeout', () => {
  test('returns result when task finishes in time', async () => {
    const p = withTimeout(sig => sleep(10, sig).then(() => 'ok'), 100);
    await vi.advanceTimersByTimeAsync(10);
    await expect(p).resolves.toBe('ok');
  });
  test('rejects with TimeoutError and aborts the task when too slow', async () => {
    let taskAborted = false;
    const expectation = expect(withTimeout(
      sig => sleep(1000, sig).catch(e => { taskAborted = isAbort(e); throw e; }),
      100,
    )).rejects.toSatisfy((e: unknown) => e instanceof DOMException && e.name === 'TimeoutError');
    await vi.advanceTimersByTimeAsync(100);
    await expectation;
    expect(taskAborted).toBe(true);
  });
  test('propagates outer signal abort', async () => {
    const c = new AbortController();
    const p = withTimeout(sig => sleep(1000, sig), 5000, c.signal);
    c.abort();
    await expect(p).rejects.toSatisfy(isAbort);
  });
  test('clears timer after success', async () => {
    const p = withTimeout(async () => 1, 1000);
    await p;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('retry', () => {
  test('retries until success', async () => {
    let attempts = 0;
    const r = retry(async () => {
      attempts++;
      if (attempts < 3) throw new Error('fail');
      return 'success';
    }, { retries: 5, delay: 0 });
    await vi.runAllTimersAsync();
    await expect(r).resolves.toBe('success');
    expect(attempts).toBe(3);
  });
  test('throws last error after exhausting retries', async () => {
    let attempts = 0;
    const r = retry(async () => { attempts++; throw new Error('e' + attempts); }, { retries: 2, delay: 0 });
    r.catch(() => {});
    await vi.runAllTimersAsync();
    await expect(r).rejects.toThrow('e3');
    expect(attempts).toBe(3);
  });
  test('waits with exponential backoff between attempts', async () => {
    const times: number[] = [];
    const r = retry(async () => { times.push(Date.now()); throw new Error('x'); },
      { retries: 2, delay: 100, factor: 2 });
    r.catch(() => {});
    await vi.runAllTimersAsync();
    expect(times[1]! - times[0]!).toBe(100);
    expect(times[2]! - times[1]!).toBe(200);
  });
  test('does not retry abort errors', async () => {
    let attempts = 0;
    const c = new AbortController();
    const r = retry(async () => { attempts++; c.abort(); throw c.signal.reason; }, { retries: 3, delay: 0 });
    await expect(r).rejects.toSatisfy(isAbort);
    expect(attempts).toBe(1);
  });
  test('stops retrying when signal aborts during backoff', async () => {
    let attempts = 0;
    const c = new AbortController();
    const r = retry(async () => { attempts++; throw new Error('x'); },
      { retries: 5, delay: 1000, signal: c.signal });
    r.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    c.abort();
    await expect(r).rejects.toSatisfy(isAbort);
    expect(attempts).toBe(1);
  });
  test('respects retryOn predicate', async () => {
    let attempts = 0;
    const r = retry(async () => { attempts++; throw new Error('fatal'); },
      { retries: 3, delay: 0, retryOn: e => !(e as Error).message.includes('fatal') });
    await expect(r).rejects.toThrow('fatal');
    expect(attempts).toBe(1);
  });
});

describe('race', () => {
  test('returns first settled value and aborts the losers', async () => {
    const seen: string[] = [];
    const p = race([
      sig => sleep(10, sig).then(() => 'fast').catch(e => { seen.push('fast-aborted'); throw e; }),
      sig => sleep(100, sig).then(() => 'slow').catch(e => { if (isAbort(e)) seen.push('slow-aborted'); throw e; }),
    ]);
    await vi.advanceTimersByTimeAsync(10);
    await expect(p).resolves.toBe('fast');
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual(['slow-aborted']);
  });
  test('rejects with first rejection and aborts the rest', async () => {
    let slowAborted = false;
    const p = race([
      async () => { throw new Error('first'); },
      sig => sleep(100, sig).catch(e => { slowAborted = isAbort(e); throw e; }),
    ]);
    await expect(p).rejects.toThrow('first');
    await vi.advanceTimersByTimeAsync(0);
    expect(slowAborted).toBe(true);
  });
});

describe('settle', () => {
  test('waits for all and reports fulfilled and rejected separately', async () => {
    const r = await settle([Promise.resolve(1), Promise.reject(new Error('no')), Promise.resolve(3)]);
    expect(r.fulfilled).toEqual([1, 3]);
    expect(r.rejected.map(e => (e as Error).message)).toEqual(['no']);
  });
});
