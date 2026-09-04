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
    await expect(
      sem.run(async () => {
        throw new Error('x');
      }),
    ).rejects.toThrow('x');
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

describe('Semaphore.run', () => {
  test('passes the signal into fn', async () => {
    const sem = new Semaphore(1);
    const c = new AbortController();
    const got = await sem.run(async sig => sig, c.signal);
    expect(got).toBe(c.signal);
  });
});

describe('Mutex', () => {
  test('serializes critical sections', async () => {
    const m = new Mutex();
    const order: string[] = [];
    const a = m.run(async () => {
      order.push('a1');
      await tick();
      order.push('a2');
    });
    const b = m.run(async () => {
      order.push('b1');
      await tick();
      order.push('b2');
    });
    await Promise.all([a, b]);
    expect(order).toEqual(['a1', 'a2', 'b1', 'b2']);
  });
});

describe('map', () => {
  test('preserves input order in results', async () => {
    const out = await map(
      [30, 10, 20],
      async (ms, _i, sig) => {
        await sleep(ms, sig);
        return ms;
      },
      { concurrency: 3 },
    );
    expect(out).toEqual([30, 10, 20]);
  });
  test('never exceeds concurrency', async () => {
    let active = 0,
      peak = 0;
    await map(
      [1, 2, 3, 4, 5, 6],
      async () => {
        active++;
        peak = Math.max(peak, active);
        await tick();
        active--;
      },
      { concurrency: 2 },
    );
    expect(peak).toBe(2);
  });
  test('aborts in-flight siblings when one fails and rejects with that error', async () => {
    let siblingAborted = false;
    const p = map(
      [1, 2],
      async (n, _i, sig) => {
        if (n === 1) throw new Error('boom');
        await sleep(1000, sig).catch(e => {
          siblingAborted = isAbort(e);
          throw e;
        });
      },
      { concurrency: 2 },
    );
    await expect(p).rejects.toThrow('boom');
    await tick();
    expect(siblingAborted).toBe(true);
  });
  test('does not start remaining items after failure', async () => {
    const started: number[] = [];
    const p = map(
      [1, 2, 3, 4],
      async n => {
        started.push(n);
        await tick();
        if (n === 1) throw new Error('boom');
      },
      { concurrency: 1 },
    );
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

import { mapSettled, Queue } from '../src/limit.js';

describe('map over iterables', () => {
  test('accepts a sync generator and keeps order', async () => {
    function* gen() {
      yield 3;
      yield 1;
      yield 2;
    }
    const out = await map(
      gen(),
      async (n, _i, sig) => {
        await sleep(n, sig);
        return n * 10;
      },
      { concurrency: 3 },
    );
    expect(out).toEqual([30, 10, 20]);
  });
  test('accepts an async iterable and keeps order', async () => {
    async function* gen() {
      yield 'a';
      await tick();
      yield 'b';
      yield 'c';
    }
    const out = await map(gen(), async s => s.toUpperCase(), { concurrency: 2 });
    expect(out).toEqual(['A', 'B', 'C']);
  });
  test('stops pulling from the source after a failure', async () => {
    let pulled = 0;
    function* gen() {
      for (let i = 0; i < 100; i++) {
        pulled++;
        yield i;
      }
    }
    await expect(
      map(
        gen(),
        async n => {
          if (n === 1) throw new Error('boom');
          await tick();
        },
        { concurrency: 1 },
      ),
    ).rejects.toThrow('boom');
    expect(pulled).toBeLessThan(5);
  });
});

describe('mapSettled', () => {
  test('runs everything, keeps order, reports each outcome', async () => {
    const r = await mapSettled(
      [1, 2, 3],
      async n => {
        if (n === 2) throw new Error('two');
        return n;
      },
      { concurrency: 2 },
    );
    expect(r.map(x => x.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect((r[1] as PromiseRejectedResult).reason.message).toBe('two');
    expect((r[2] as PromiseFulfilledResult<number>).value).toBe(3);
  });
  test('does not abort siblings on failure', async () => {
    let siblingAborted = false;
    await mapSettled(
      [1, 2],
      async (n, _i, sig) => {
        if (n === 1) throw new Error('x');
        await sleep(5, sig).catch(e => {
          siblingAborted = isAbort(e);
          throw e;
        });
      },
      { concurrency: 2 },
    );
    expect(siblingAborted).toBe(false);
  });
  test('rejects when the outer signal aborts', async () => {
    const c = new AbortController();
    const p = mapSettled([1, 2], async (_n, _i, sig) => sleep(1000, sig), { signal: c.signal });
    c.abort();
    await expect(p).rejects.toSatisfy(isAbort);
  });
});

describe('Queue', () => {
  test('add() returns the task result', async () => {
    const q = new Queue({ concurrency: 2 });
    await expect(q.add(async () => 42)).resolves.toBe(42);
  });
  test('never runs more than concurrency tasks at once', async () => {
    const q = new Queue({ concurrency: 2 });
    let active = 0,
      peak = 0;
    const tasks = [1, 2, 3, 4, 5].map(() =>
      q.add(async () => {
        active++;
        peak = Math.max(peak, active);
        await tick();
        active--;
      }),
    );
    await Promise.all(tasks);
    expect(peak).toBe(2);
  });
  test('size and pending report waiting and running tasks', async () => {
    const q = new Queue({ concurrency: 1 });
    q.add(() => tick());
    q.add(() => tick());
    q.add(() => tick());
    expect(q.pending).toBe(1);
    expect(q.size).toBe(2);
    await q.idle();
    expect(q.pending).toBe(0);
    expect(q.size).toBe(0);
  });
  test('idle() resolves immediately on an empty queue', async () => {
    await expect(new Queue().idle()).resolves.toBeUndefined();
  });
  test('a failed task rejects its own promise only', async () => {
    const q = new Queue({ concurrency: 1 });
    const bad = q.add(async () => {
      throw new Error('bad');
    });
    const good = q.add(async () => 'good');
    await expect(bad).rejects.toThrow('bad');
    await expect(good).resolves.toBe('good');
  });
  test('clear() rejects waiting tasks and leaves running ones alone', async () => {
    const q = new Queue({ concurrency: 1 });
    const running = q.add(async () => {
      await tick();
      return 'ran';
    });
    const waiting = q.add(async () => 'never');
    q.clear();
    await expect(waiting).rejects.toSatisfy(isAbort);
    await expect(running).resolves.toBe('ran');
  });
  test('queue signal aborts running tasks and rejects waiting ones', async () => {
    const c = new AbortController();
    const q = new Queue({ concurrency: 1, signal: c.signal });
    const running = q.add(sig => sleep(1000, sig));
    const waiting = q.add(async () => 'never');
    c.abort();
    await expect(running).rejects.toSatisfy(isAbort);
    await expect(waiting).rejects.toSatisfy(isAbort);
    await expect(q.add(async () => 1)).rejects.toSatisfy(isAbort);
  });
  test('per-task signal removes a waiting task', async () => {
    const q = new Queue({ concurrency: 1 });
    q.add(() => tick());
    const c = new AbortController();
    const waiting = q.add(async () => 'x', c.signal);
    c.abort();
    await expect(waiting).rejects.toSatisfy(isAbort);
    expect(q.size).toBe(0);
  });
});
