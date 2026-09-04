import { Semaphore, Mutex, map } from '../src/limit.js';
import { isAbort, sleep } from '../src/signal.js';

const tick = () => new Promise<void>(r => setTimeout(r, 0));

describe('Semaphore', () => {
  test('allows up to N concurrent holders', async () => {
    const sem = new Semaphore(2);
    const r1 = await sem.acquire();
    const r2 = await sem.acquire();
    let third = false;
    sem.acquire().then(() => (third = true));
    await tick();
    expect(third).toBe(false);
    r1();
    await tick();
    expect(third).toBe(true);
    r2();
  });
  test('release is idempotent', async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    release();
    release();
    expect(sem.available).toBe(1);
  });
  test('run() releases even when fn throws', async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => { throw new Error('x'); })).rejects.toThrow('x');
    expect(sem.available).toBe(1);
  });
  test('waiting acquire rejects on abort and leaves the queue', async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    const c = new AbortController();
    const waiting = sem.acquire(c.signal);
    c.abort();
    await expect(waiting).rejects.toSatisfy(isAbort);
    expect(sem.pending).toBe(0);
    release();
    expect(sem.available).toBe(1);
  });
  test('acquire with already-aborted signal rejects without taking a permit', async () => {
    const sem = new Semaphore(1);
    const c = new AbortController();
    c.abort();
    await expect(sem.acquire(c.signal)).rejects.toSatisfy(isAbort);
    expect(sem.available).toBe(1);
  });
});

describe('Mutex', () => {
  test('serializes critical sections', async () => {
    const m = new Mutex();
    const order: string[] = [];
    const a = m.run(async () => { order.push('a1'); await tick(); order.push('a2'); });
    const b = m.run(async () => { order.push('b1'); await tick(); order.push('b2'); });
    await Promise.all([a, b]);
    expect(order).toEqual(['a1', 'a2', 'b1', 'b2']);
  });
});

describe('map', () => {
  test('preserves input order in results', async () => {
    const out = await map([30, 10, 20], async (ms, _i, sig) => { await sleep(ms, sig); return ms; }, { concurrency: 3 });
    expect(out).toEqual([30, 10, 20]);
  });
  test('never exceeds concurrency', async () => {
    let active = 0, peak = 0;
    await map([1, 2, 3, 4, 5, 6], async () => {
      active++; peak = Math.max(peak, active);
      await tick();
      active--;
    }, { concurrency: 2 });
    expect(peak).toBe(2);
  });
  test('aborts in-flight siblings when one fails and rejects with that error', async () => {
    let siblingAborted = false;
    const p = map([1, 2], async (n, _i, sig) => {
      if (n === 1) throw new Error('boom');
      await sleep(1000, sig).catch(e => { siblingAborted = isAbort(e); throw e; });
    }, { concurrency: 2 });
    await expect(p).rejects.toThrow('boom');
    await tick();
    expect(siblingAborted).toBe(true);
  });
  test('does not start remaining items after failure', async () => {
    const started: number[] = [];
    const p = map([1, 2, 3, 4], async (n) => {
      started.push(n);
      await tick();
      if (n === 1) throw new Error('boom');
    }, { concurrency: 1 });
    await expect(p).rejects.toThrow('boom');
    expect(started).toEqual([1]);
  });
  test('rejects with abort reason when outer signal aborts', async () => {
    const c = new AbortController();
    const p = map([1, 2, 3], async (_n, _i, sig) => sleep(1000, sig), { concurrency: 1, signal: c.signal });
    c.abort();
    await expect(p).rejects.toSatisfy(isAbort);
  });
});
