import { createHttp, HttpError } from '../src/http.js';
import { retry } from '../src/combine.js';
import { latestBy } from '../src/latest.js';
import { Queue, Semaphore } from '../src/limit.js';
import { fakeFetch, streamResponse, jsonResponse, tick, expectAborted } from '../src/testing.js';
import { sleep, isAbort } from '../src/signal.js';

const sig = () => new AbortController().signal;
const sse = (body: string) => streamResponse([body], { headers: { 'content-type': 'text/event-stream' } });

describe('sse reconnect with backoff', () => {
  // real timers on purpose: response bodies are real streams in browsers and fake timers
  // would run out before the next reconnect is scheduled; delays are tiny and the values the
  // library reports through onRetry are computed, so the assertions stay exact

  test('a network error mid-stream reconnects after the delay with Last-Event-ID', async () => {
    let n = 0;
    const f = fakeFetch(() => {
      n++;
      if (n === 1) return sse('id: 5\ndata: one\n\n');
      if (n === 2) throw new TypeError('Failed to fetch');
      return sse('data: two\n\n');
    });
    const http = createHttp({ fetch: f.fetch });
    const c = new AbortController();
    const seen: string[] = [];
    const delays: number[] = [];
    for await (const e of http.sse('https://x/e', {
      signal: c.signal,
      reconnect: { delay: 5, factor: 2, onRetry: (_e, _a, d) => delays.push(d) },
    })) {
      seen.push(e.data);
      if (seen.length === 2) c.abort();
    }
    expect(seen).toEqual(['one', 'two']);
    expect(delays).toEqual([5, 10]); // stream 1 ended → 5; attempt 2 failed → 10
    expect(f.calls[2]!.headers.get('last-event-id')).toBe('5');
  });

  test('5xx and 429 during reconnect are retried, 4xx is not', async () => {
    let n = 0;
    const f = fakeFetch(() =>
      ++n === 1
        ? sse('data: a\n\n')
        : n === 2
          ? jsonResponse({}, { status: 503 })
          : jsonResponse({}, { status: 403 }),
    );
    const http = createHttp({ fetch: f.fetch });
    const seen: string[] = [];
    const err = await (async () => {
      for await (const e of http.sse('https://x/e', { signal: sig(), reconnect: { delay: 5 } }))
        seen.push(e.data);
    })().then(
      () => 'ended',
      (e: unknown) => e,
    );
    expect(seen).toEqual(['a']);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(403);
    expect(f.calls).toHaveLength(3);
  });

  test('backoff resets after a successful connection and honours maxDelay', async () => {
    const delays: number[] = [];
    let n = 0;
    const f = fakeFetch(() => {
      n++;
      if (n === 2 || n === 3) throw new TypeError('down');
      return sse(`data: ${n}\n\n`);
    });
    const http = createHttp({ fetch: f.fetch });
    const c = new AbortController();
    const seen: string[] = [];
    for await (const e of http.sse('https://x/e', {
      signal: c.signal,
      reconnect: { delay: 5, factor: 10, maxDelay: 30, onRetry: (_e, _a, d) => delays.push(d) },
    })) {
      seen.push(e.data);
      if (seen.length === 3) c.abort();
    }
    expect(seen).toEqual(['1', '4', '5']);
    // after stream 1 ends: 5; attempt 2 fails: 30 (capped); attempt 3 fails: 30; success resets; after stream 4 ends: 5
    expect(delays).toEqual([5, 30, 30, 5]);
  });
});

describe('retry onRetry', () => {
  test('is called before each wait with the error, attempt number and delay', async () => {
    vi.useFakeTimers();
    const log: Array<[string, number, number]> = [];
    let n = 0;
    const p = retry(
      async () => {
        if (++n < 3) throw new Error('e' + n);
        return 'ok';
      },
      {
        retries: 3,
        delay: 100,
        factor: 2,
        onRetry: (err, attempt, delayMs) => {
          log.push([(err as Error).message, attempt, delayMs]);
        },
      },
    );
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe('ok');
    expect(log).toEqual([
      ['e1', 0, 100],
      ['e2', 1, 200],
    ]);
    vi.useRealTimers();
  });
  test('is not called when the error is not retried', async () => {
    const onRetry = vi.fn();
    await expect(
      retry(
        async () => {
          throw new Error('fatal');
        },
        { retries: 2, retryOn: () => false, onRetry },
      ),
    ).rejects.toThrow('fatal');
    expect(onRetry).not.toHaveBeenCalled();
  });
});

describe('latestBy', () => {
  test('keeps one in-flight call per key and cancels only same-key predecessors', async () => {
    const aborted: string[] = [];
    const load = latestBy(
      (id: string) => id,
      async (id: string, signal: AbortSignal) => {
        await sleep(20, signal).catch(e => {
          if (isAbort(e)) aborted.push(id);
          throw e;
        });
        return `r:${id}`;
      },
    );
    const a1 = load('a').catch((e: unknown) => (isAbort(e) ? 'aborted' : Promise.reject(e)));
    const b1 = load('b');
    const a2 = load('a');
    expect(await Promise.all([a1, b1, a2])).toEqual(['aborted', 'r:b', 'r:a']);
    expect(aborted).toEqual(['a']);
  });
  test('pending(key) and cancel(key) work per key; cancel() clears all', async () => {
    const load = latestBy(
      (id: number) => id,
      async (_id: number, signal: AbortSignal) => sleep(1000, signal),
    );
    const p1 = load(1);
    const p2 = load(2);
    expect(load.pending(1)).toBe(true);
    expect(load.pending(3)).toBe(false);
    expect(load.pending()).toBe(true);
    load.cancel(1);
    await expectAborted(p1);
    expect(load.pending(2)).toBe(true);
    load.cancel();
    await expectAborted(p2);
    expect(load.pending()).toBe(false);
  });
  test('a finished key does not linger', async () => {
    const load = latestBy(
      (s: string) => s,
      async (s: string) => s,
    );
    await load('x');
    expect(load.pending('x')).toBe(false);
    expect(load.size).toBe(0);
  });
});

describe('Queue pause/resume', () => {
  test('paused queue keeps accepting tasks but starts none; resume drains in order', async () => {
    const q = new Queue({ concurrency: 2 });
    const order: number[] = [];
    q.pause();
    expect(q.paused).toBe(true);
    const tasks = [1, 2, 3].map(n =>
      q.add(async () => {
        order.push(n);
      }),
    );
    await tick();
    expect(order).toEqual([]);
    expect(q.size).toBe(3);
    q.resume();
    await Promise.all(tasks);
    expect(order).toEqual([1, 2, 3]);
    expect(q.paused).toBe(false);
  });
  test('pause does not interrupt running tasks', async () => {
    const q = new Queue({ concurrency: 1 });
    const running = q.add(async () => {
      await sleep(5);
      return 'done';
    });
    q.pause();
    await expect(running).resolves.toBe('done');
  });
});

describe('Semaphore.tryAcquire', () => {
  test('returns a release when a permit is free and undefined otherwise', () => {
    const sem = new Semaphore(1);
    const release = sem.tryAcquire();
    expect(typeof release).toBe('function');
    expect(sem.tryAcquire()).toBeUndefined();
    release!();
    expect(sem.available).toBe(1);
  });
});
