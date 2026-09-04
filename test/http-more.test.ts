import { createHttp, HttpError } from '../src/http.js';
import { toArray } from '../src/iter.js';
import { isAbort } from '../src/signal.js';
import { Scope } from '../src/scope.js';

const sig = () => new AbortController().signal;
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn: typeof fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fn, calls };
}

const textStream = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
      c.close();
    },
  });

describe('hooks', () => {
  test('onRequest can rewrite url and init before fetch', async () => {
    const f = fakeFetch(() => json({}));
    const http = createHttp({
      fetch: f.fn,
      onRequest: (url, init) => ({
        url: url + '?traced=1',
        init: { ...init, headers: { ...headersOf(init), 'x-trace': 't1' } },
      }),
    });
    await http.get('https://x/a', { signal: sig() });
    expect(f.calls[0]!.url).toBe('https://x/a?traced=1');
    expect(new Headers(f.calls[0]!.init.headers).get('x-trace')).toBe('t1');
  });
  test('onRequest may be async and see the request signal', async () => {
    const f = fakeFetch(() => json({}));
    let seen: AbortSignal | undefined;
    const http = createHttp({
      fetch: f.fn,
      onRequest: async (_u, init) => {
        seen = init.signal!;
      },
    });
    const c = new AbortController();
    await http.get('https://x/a', { signal: c.signal });
    expect(seen).toBeInstanceOf(AbortSignal);
  });
  test('onResponse can replace the response and observe status', async () => {
    const f = fakeFetch(() => json({ v: 1 }, { status: 500 }));
    const seen: number[] = [];
    const http = createHttp({
      fetch: f.fn,
      onResponse: res => {
        seen.push(res.status);
        return res.status === 500 ? json({ v: 'patched' }) : res;
      },
    });
    await expect(http.get('https://x/a', { signal: sig() })).resolves.toEqual({ v: 'patched' });
    expect(seen).toEqual([500]);
  });
  test('onResponse runs per attempt when retrying', async () => {
    vi.useFakeTimers();
    let n = 0;
    const f = fakeFetch(() => (++n === 1 ? json({}, { status: 503 }) : json({ ok: 1 })));
    const statuses: number[] = [];
    const http = createHttp({
      fetch: f.fn,
      retry: { retries: 1, delay: 0 },
      onResponse: r => {
        statuses.push(r.status);
        return r;
      },
    });
    const p = http.get('https://x/a', { signal: sig() });
    await vi.runAllTimersAsync();
    await p;
    expect(statuses).toEqual([503, 200]);
    vi.useRealTimers();
  });
});

describe('schema validation', () => {
  test('parse option validates and transforms the body', async () => {
    const f = fakeFetch(() => json({ id: '7', name: 'n' }));
    const http = createHttp({ fetch: f.fn });
    const user = await http.get('https://x/u', {
      signal: sig(),
      parse: (raw: unknown) => {
        const o = raw as { id: string; name: string };
        return { id: Number(o.id), name: o.name };
      },
    });
    expect(user).toEqual({ id: 7, name: 'n' });
  });
  test('a throwing parser rejects with the parser error, response attached', async () => {
    const f = fakeFetch(() => json({ bad: true }));
    const http = createHttp({ fetch: f.fn });
    const err = await http
      .get('https://x/u', {
        signal: sig(),
        parse: () => {
          throw new TypeError('invalid shape');
        },
      })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect((err as TypeError & { response?: Response }).response).toBeInstanceOf(Response);
  });
  test('works with a zod-like object exposing parse()', async () => {
    const f = fakeFetch(() => json({ n: 1 }));
    const http = createHttp({ fetch: f.fn });
    const schema = { parse: (v: unknown) => ({ doubled: (v as { n: number }).n * 2 }) };
    await expect(http.get('https://x/u', { signal: sig(), parse: schema })).resolves.toEqual({ doubled: 2 });
  });
});

describe('deadline', () => {
  test('per-request deadline shortens the attempt timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const f = fakeFetch(
      (_u, init) =>
        new Promise((_r, rej) => init.signal!.addEventListener('abort', () => rej(init.signal!.reason))),
    );
    const http = createHttp({ fetch: f.fn, timeout: 10_000 });
    const expectation = expect(
      http.get('https://x/a', { signal: sig(), deadline: performance.now() + 200 }),
    ).rejects.toSatisfy((e: unknown) => (e as DOMException).name === 'TimeoutError');
    await vi.advanceTimersByTimeAsync(200);
    await expectation;
    vi.useRealTimers();
  });
  test('scope option takes signal and deadline from a Scope', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const f = fakeFetch(
      (_u, init) =>
        new Promise((_r, rej) => init.signal!.addEventListener('abort', () => rej(init.signal!.reason))),
    );
    const http = createHttp({ fetch: f.fn, timeout: 10_000 });
    const scope = new Scope({ timeout: 150 });
    const expectation = expect(http.get('https://x/a', { scope })).rejects.toSatisfy(isAbort);
    await vi.advanceTimersByTimeAsync(150);
    await expectation;
    vi.useRealTimers();
  });
  test('an already-expired deadline rejects without fetching', async () => {
    const f = fakeFetch(() => json({}));
    const http = createHttp({ fetch: f.fn });
    await expect(
      http.get('https://x/a', { signal: sig(), deadline: performance.now() - 1 }),
    ).rejects.toSatisfy((e: unknown) => (e as DOMException).name === 'TimeoutError');
    expect(f.calls).toHaveLength(0);
  });
});

describe('streams', () => {
  test('stream() yields NDJSON objects', async () => {
    const f = fakeFetch(
      () =>
        new Response(textStream(['{"a":1}\n{"a":', '2}\n', '{"a":3}']), {
          headers: { 'content-type': 'application/x-ndjson' },
        }),
    );
    const http = createHttp({ fetch: f.fn });
    const items = await toArray(http.stream<{ a: number }>('https://x/feed', { signal: sig() }));
    expect(items).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
  });
  test('stream() rejects on non-2xx with HttpError', async () => {
    const f = fakeFetch(() => json({ error: 'nope' }, { status: 403 }));
    const http = createHttp({ fetch: f.fn });
    await expect(toArray(http.stream('https://x/feed', { signal: sig() }))).rejects.toBeInstanceOf(HttpError);
  });
  test('sse() parses events with id, event and multi-line data, and sends Accept header', async () => {
    const f = fakeFetch(
      () =>
        new Response(
          textStream([
            'id: 1\nevent: tick\ndata: {"n":1}\n\n',
            ': comment\n',
            'data: line1\ndata: line2\n\n',
            'retry: 5000\nid: 3\ndata: last\n\n',
          ]),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const http = createHttp({ fetch: f.fn });
    const events = await toArray(http.sse('https://x/events', { signal: sig() }));
    expect(new Headers(f.calls[0]!.init.headers).get('accept')).toBe('text/event-stream');
    expect(events).toEqual([
      { id: '1', event: 'tick', data: '{"n":1}', retry: undefined },
      { id: '1', event: 'message', data: 'line1\nline2', retry: undefined },
      { id: '3', event: 'message', data: 'last', retry: 5000 },
    ]);
  });
  test('sse() reconnects with Last-Event-ID when the stream ends unexpectedly', async () => {
    vi.useFakeTimers();
    let n = 0;
    const f = fakeFetch(() => {
      n++;
      const body = n === 1 ? 'id: 9\ndata: first\n\n' : 'data: second\n\n';
      return new Response(textStream([body]), { headers: { 'content-type': 'text/event-stream' } });
    });
    const http = createHttp({ fetch: f.fn });
    const c = new AbortController();
    const seen: string[] = [];
    const loop = (async () => {
      for await (const e of http.sse('https://x/events', { signal: c.signal, reconnect: { delay: 100 } })) {
        seen.push(e.data);
        if (seen.length === 2) c.abort();
      }
    })();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(0);
    await loop;
    expect(seen).toEqual(['first', 'second']);
    expect(new Headers(f.calls[1]!.init.headers).get('last-event-id')).toBe('9');
    vi.useRealTimers();
  });
  test('sse() without reconnect ends when the stream ends', async () => {
    const f = fakeFetch(
      () =>
        new Response(textStream(['data: only\n\n']), { headers: { 'content-type': 'text/event-stream' } }),
    );
    const http = createHttp({ fetch: f.fn });
    const events = await toArray(http.sse('https://x/events', { signal: sig() }));
    expect(events.map(e => e.data)).toEqual(['only']);
  });
  test('stream() stops fetching when the consumer breaks out', async () => {
    let cancelled = false;
    const f = fakeFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new TextEncoder().encode('{"a":1}\n{"a":2}\n'));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'content-type': 'application/x-ndjson' } },
        ),
    );
    const http = createHttp({ fetch: f.fn });
    for await (const item of http.stream<{ a: number }>('https://x/feed', { signal: sig() })) {
      if (item.a === 1) break;
    }
    expect(cancelled).toBe(true);
  });
});

function headersOf(init?: RequestInit) {
  const h: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => (h[k] = v));
  return h;
}
