import { latest, singleFlight } from '../src/latest.js';
import { isAbort, sleep } from '../src/signal.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('latest', () => {
  test('a newer call aborts the previous in-flight call', async () => {
    const seen: string[] = [];
    const search = latest(async (q: string, signal: AbortSignal) => {
      await sleep(100, signal).catch(e => { if (isAbort(e)) seen.push(`aborted:${q}`); throw e; });
      return `result:${q}`;
    });
    const first = search('a');
    first.catch(() => {});
    const second = search('ab');
    await vi.advanceTimersByTimeAsync(100);
    await expect(first).rejects.toSatisfy(isAbort);
    await expect(second).resolves.toBe('result:ab');
    expect(seen).toEqual(['aborted:a']);
  });
  test('sequential calls both resolve when the first completes before the second starts', async () => {
    const fn = latest(async (n: number, signal: AbortSignal) => { await sleep(10, signal); return n; });
    const a = fn(1);
    await vi.advanceTimersByTimeAsync(10);
    await expect(a).resolves.toBe(1);
    const b = fn(2);
    await vi.advanceTimersByTimeAsync(10);
    await expect(b).resolves.toBe(2);
  });
  test('pending reflects whether a call is in flight', async () => {
    const fn = latest(async (_: void, signal: AbortSignal) => sleep(10, signal));
    expect(fn.pending).toBe(false);
    const p = fn();
    expect(fn.pending).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    await p;
    expect(fn.pending).toBe(false);
  });
  test('cancel() aborts the current call', async () => {
    const fn = latest(async (_: void, signal: AbortSignal) => sleep(100, signal));
    const p = fn();
    fn.cancel();
    await expect(p).rejects.toSatisfy(isAbort);
  });
  test('forwards an outer signal so the caller can also cancel', async () => {
    const fn = latest(async (_: void, signal: AbortSignal) => sleep(100, signal));
    const c = new AbortController();
    const p = fn(undefined, c.signal);
    c.abort();
    await expect(p).rejects.toSatisfy(isAbort);
  });
});

describe('singleFlight', () => {
  test('concurrent calls with the same key share one execution', async () => {
    let calls = 0;
    const load = singleFlight(async (id: number) => { calls++; await sleep(10); return `user:${id}`; });
    const a = load(1);
    const b = load(1);
    const c = load(2);
    await vi.advanceTimersByTimeAsync(10);
    expect(await Promise.all([a, b, c])).toEqual(['user:1', 'user:1', 'user:2']);
    expect(calls).toBe(2);
  });
  test('after the flight settles a new call executes again', async () => {
    let calls = 0;
    const load = singleFlight(async (id: number) => { calls++; return id; });
    await load(1);
    await load(1);
    expect(calls).toBe(2);
  });
  test('a rejected flight is not cached', async () => {
    let calls = 0;
    const load = singleFlight(async (_id: number) => { calls++; if (calls === 1) throw new Error('x'); return 'ok'; });
    await expect(load(1)).rejects.toThrow('x');
    await expect(load(1)).resolves.toBe('ok');
  });
  test('custom key function', async () => {
    let calls = 0;
    const load = singleFlight(async (o: { id: number; noise: number }) => { calls++; await sleep(1); return o.id; },
      { key: o => o.id });
    const a = load({ id: 1, noise: 1 });
    const b = load({ id: 1, noise: 2 });
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([a, b]);
    expect(calls).toBe(1);
  });
});
