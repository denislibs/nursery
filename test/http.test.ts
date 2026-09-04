import { createHttp, HttpError } from '../src/http.js';
import { isAbort } from '../src/signal.js';

type FetchFn = typeof fetch;
const sig = () => new AbortController().signal;
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn: FetchFn = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fn, calls };
}

describe('createHttp basics', () => {
  test('get() resolves baseUrl + path + query and parses JSON', async () => {
    const f = fakeFetch(() => json({ id: 1 }));
    const http = createHttp({ baseUrl: 'https://api.test/v1', fetch: f.fn });
    const user = await http.get<{ id: number }>('/users/1', { signal: sig(), query: { expand: 'posts', page: 2 } });
    expect(user).toEqual({ id: 1 });
    expect(f.calls[0]!.url).toBe('https://api.test/v1/users/1?expand=posts&page=2');
    expect(f.calls[0]!.init.method).toBe('GET');
  });

  test('post() JSON-encodes plain objects and sets content-type', async () => {
    const f = fakeFetch(() => json({ ok: true }, { status: 201 }));
    const http = createHttp({ fetch: f.fn });
    await http.post('https://x/items', { signal: sig(), body: { name: 'a' } });
    const init = f.calls[0]!.init;
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"name":"a"}');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
  });

  test('passes FormData through untouched', async () => {
    const f = fakeFetch(() => json({}));
    const http = createHttp({ fetch: f.fn });
    const fd = new FormData();
    await http.post('https://x/upload', { signal: sig(), body: fd });
    expect(f.calls[0]!.init.body).toBe(fd);
    expect(new Headers(f.calls[0]!.init.headers).has('content-type')).toBe(false);
  });

  test('non-2xx responses reject with HttpError carrying status and parsed body', async () => {
    const f = fakeFetch(() => json({ error: 'nope' }, { status: 404 }));
    const http = createHttp({ fetch: f.fn });
    const err = await http.get('https://x/missing', { signal: sig() }).catch((e: HttpError) => e) as HttpError;
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(404);
    expect(err.body).toEqual({ error: 'nope' });
  });

  test('throws synchronously-rejecting TypeError when signal is missing at runtime', async () => {
    const http = createHttp({ fetch: fakeFetch(() => json({})).fn });
    await expect(http.get('https://x/', {} as never)).rejects.toBeInstanceOf(TypeError);
  });

  test('default headers are merged with per-request headers', async () => {
    const f = fakeFetch(() => json({}));
    const http = createHttp({ fetch: f.fn, headers: { authorization: 'Bearer t', 'x-a': '1' } });
    await http.get('https://x/', { signal: sig(), headers: { 'x-a': '2' } });
    const h = new Headers(f.calls[0]!.init.headers);
    expect(h.get('authorization')).toBe('Bearer t');
    expect(h.get('x-a')).toBe('2');
  });
});

describe('cancellation and timeout', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test('caller signal aborts the underlying fetch', async () => {
    let fetchSignal: AbortSignal | undefined;
    const f = fakeFetch((_u, init) => new Promise((_r, rej) => {
      fetchSignal = init.signal!;
      init.signal!.addEventListener('abort', () => rej(init.signal!.reason));
    }));
    const http = createHttp({ fetch: f.fn });
    const c = new AbortController();
    const p = http.get('https://x/', { signal: c.signal });
    c.abort();
    await expect(p).rejects.toSatisfy(isAbort);
    expect(fetchSignal!.aborted).toBe(true);
  });

  test('timeout aborts the fetch with TimeoutError', async () => {
    const f = fakeFetch((_u, init) => new Promise((_r, rej) => init.signal!.addEventListener('abort', () => rej(init.signal!.reason))));
    const http = createHttp({ fetch: f.fn, timeout: 100 });
    const expectation = expect(http.get('https://x/', { signal: sig() })).rejects.toSatisfy(
      (e: unknown) => (e as DOMException).name === 'TimeoutError',
    );
    await vi.advanceTimersByTimeAsync(100);
    await expectation;
  });
});

describe('retry', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test('retries 503 and honours Retry-After', async () => {
    let n = 0;
    const f = fakeFetch(() => (++n === 1 ? json({}, { status: 503, headers: { 'retry-after': '2' } }) : json({ ok: 1 })));
    const http = createHttp({ fetch: f.fn, retry: { retries: 2, delay: 10 } });
    const p = http.get<{ ok: number }>('https://x/', { signal: sig() });
    await vi.advanceTimersByTimeAsync(1999);
    expect(f.calls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toEqual({ ok: 1 });
    expect(f.calls.length).toBe(2);
  });

  test('retries network errors', async () => {
    let n = 0;
    const f = fakeFetch(() => { if (++n === 1) throw new TypeError('Failed to fetch'); return json({ ok: 1 }); });
    const http = createHttp({ fetch: f.fn, retry: { retries: 1, delay: 0 } });
    const p = http.get('https://x/', { signal: sig() });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toEqual({ ok: 1 });
  });

  test('does not retry 4xx', async () => {
    const f = fakeFetch(() => json({}, { status: 400 }));
    const http = createHttp({ fetch: f.fn, retry: { retries: 3, delay: 0 } });
    await expect(http.get('https://x/', { signal: sig() })).rejects.toBeInstanceOf(HttpError);
    expect(f.calls.length).toBe(1);
  });

  test('POST is not retried by default but is when retry is set on the request', async () => {
    let n = 0;
    const f = fakeFetch(() => (++n % 2 === 1 ? json({}, { status: 503 }) : json({ ok: 1 })));
    const http = createHttp({ fetch: f.fn, retry: { retries: 2, delay: 0 } });
    await expect(http.post('https://x/', { signal: sig(), body: {} })).rejects.toBeInstanceOf(HttpError);
    expect(f.calls.length).toBe(1);
    const p = http.post('https://x/', { signal: sig(), body: {}, retry: { retries: 1, delay: 0 } });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toEqual({ ok: 1 });
  });

  test('caller abort during backoff stops retrying', async () => {
    const f = fakeFetch(() => json({}, { status: 503 }));
    const http = createHttp({ fetch: f.fn, retry: { retries: 5, delay: 1000 } });
    const c = new AbortController();
    const p = http.get('https://x/', { signal: c.signal });
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    c.abort();
    await expect(p).rejects.toSatisfy(isAbort);
    expect(f.calls.length).toBe(1);
  });
});

describe('dedupe', () => {
  test('concurrent identical GETs share one fetch and each gets the body', async () => {
    let resolve!: (r: Response) => void;
    const f = fakeFetch(() => new Promise<Response>(r => (resolve = r)));
    const http = createHttp({ fetch: f.fn });
    const a = http.get('https://x/u/1', { signal: sig() });
    const b = http.get('https://x/u/1', { signal: sig() });
    expect(f.calls.length).toBe(1);
    resolve(json({ id: 1 }));
    expect(await Promise.all([a, b])).toEqual([{ id: 1 }, { id: 1 }]);
  });

  test('different query strings are different flights, and dedupe can be disabled', async () => {
    const f = fakeFetch(() => json({}));
    const http = createHttp({ fetch: f.fn });
    await Promise.all([
      http.get('https://x/u', { signal: sig(), query: { a: 1 } }),
      http.get('https://x/u', { signal: sig(), query: { a: 2 } }),
      http.get('https://x/u', { signal: sig(), query: { a: 2 }, dedupe: false }),
    ]);
    expect(f.calls.length).toBe(3);
  });

  test('aborting one subscriber keeps the shared fetch alive; aborting all cancels it', async () => {
    let fetchSignal: AbortSignal | undefined;
    const f = fakeFetch((_u, init) => new Promise((_r, rej) => {
      fetchSignal = init.signal!;
      init.signal!.addEventListener('abort', () => rej(init.signal!.reason));
    }));
    const http = createHttp({ fetch: f.fn });
    const c1 = new AbortController();
    const c2 = new AbortController();
    const a = http.get('https://x/u', { signal: c1.signal });
    const b = http.get('https://x/u', { signal: c2.signal });
    c1.abort();
    await expect(a).rejects.toSatisfy(isAbort);
    expect(fetchSignal!.aborted).toBe(false);
    c2.abort();
    await expect(b).rejects.toSatisfy(isAbort);
    expect(fetchSignal!.aborted).toBe(true);
  });

  test('after the flight settles, a new GET fetches again', async () => {
    const f = fakeFetch(() => json({}));
    const http = createHttp({ fetch: f.fn });
    await http.get('https://x/u', { signal: sig() });
    await http.get('https://x/u', { signal: sig() });
    expect(f.calls.length).toBe(2);
  });
});

describe('request()', () => {
  test('returns the raw Response without throwing on non-2xx', async () => {
    const f = fakeFetch(() => json({}, { status: 500 }));
    const http = createHttp({ fetch: f.fn });
    const res = await http.request('https://x/', { signal: sig() });
    expect(res.status).toBe(500);
  });
});
