import { createHttp, HttpError } from '../src/http.js';
import { fromReadableStream, toArray } from '../src/iter.js';
import { fakeFetch, jsonResponse, expectAborted } from '../src/testing.js';
import { sleep } from '../src/signal.js';

const sig = () => new AbortController().signal;

describe('retry with onUploadProgress', () => {
  test('every attempt gets a fresh body stream and progress is reported per attempt', async () => {
    // real timers: Blob reads are real tasks in browsers, fake timers would run out before the retry is scheduled
    let n = 0;
    const bodies: number[] = [];
    const f = fakeFetch(async (_u, init) => {
      let bytes = 0;
      for await (const chunk of init.body as ReadableStream<Uint8Array>) bytes += chunk.byteLength;
      bodies.push(bytes);
      return ++n === 1 ? jsonResponse({}, { status: 503 }) : { ok: true };
    });
    const http = createHttp({ fetch: f.fetch, retry: { retries: 1, delay: 0 } });
    const progress: number[] = [];
    await expect(
      http.put('https://x/u', {
        signal: sig(),
        body: new Blob([new Uint8Array(70_000)]),
        onUploadProgress: s => progress.push(s),
      }),
    ).resolves.toEqual({ ok: true });
    expect(bodies).toEqual([70_000, 70_000]);
    expect(progress.filter(s => s === 70_000)).toHaveLength(2);
  });
});

describe('http retry hooks see HttpError', () => {
  test('onRetry and retryOn receive an HttpError for retryable statuses', async () => {
    vi.useFakeTimers();
    let n = 0;
    const f = fakeFetch(() => (++n === 1 ? jsonResponse({ why: 'busy' }, { status: 503 }) : { ok: 1 }));
    const seen: unknown[] = [];
    const http = createHttp({
      fetch: f.fetch,
      retry: {
        retries: 1,
        delay: 10,
        retryOn: err => {
          seen.push(err);
          return true;
        },
        onRetry: err => {
          seen.push(err);
        },
      },
    });
    const p = http.get('https://x/', { signal: sig() });
    await vi.runAllTimersAsync();
    await p;
    expect(seen).toHaveLength(2);
    for (const e of seen) {
      expect(e).toBeInstanceOf(HttpError);
      expect((e as HttpError).status).toBe(503);
      expect((e as HttpError).body).toBeUndefined(); // not parsed on the retry path
      expect((e as HttpError).response.bodyUsed).toBe(false); // a clone, readable if the hook wants it
    }
    vi.useRealTimers();
  });
});

describe('body readers honour the signal', () => {
  test('fromReadableStream cancels the stream and rejects when the signal aborts mid-read', async () => {
    let cancelled = false;
    const rs = new ReadableStream<number>({
      async pull(c) {
        await sleep(50);
        c.enqueue(1);
      },
      cancel() {
        cancelled = true;
      },
    });
    const c = new AbortController();
    const p = toArray(fromReadableStream(rs, c.signal));
    c.abort();
    await expectAborted(p);
    expect(cancelled).toBe(true);
  });
  test('sse() ends promptly on abort even if the server never sends another chunk', async () => {
    const f = fakeFetch(
      () =>
        new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) }), {
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    const http = createHttp({ fetch: f.fetch });
    const c = new AbortController();
    const loop = (async () => {
      for await (const _ of http.sse('https://x/e', { signal: c.signal })) {
        /* never */
      }
    })();
    await sleep(5);
    c.abort();
    await loop; // ends gracefully, like on()
  });
  test('stream() ends promptly on abort as well', async () => {
    const f = fakeFetch(
      () =>
        new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) }), {
          headers: { 'content-type': 'application/x-ndjson' },
        }),
    );
    const http = createHttp({ fetch: f.fetch });
    const c = new AbortController();
    const loop = toArray(http.stream('https://x/s', { signal: c.signal }));
    await sleep(5);
    c.abort();
    await expect(loop).resolves.toEqual([]);
  });
});
