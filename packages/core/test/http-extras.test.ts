import { createHttp } from '../src/http.js';

const sig = () => new AbortController().signal;
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

function fakeFetch(
  handler: (url: string, init: RequestInit & { duplex?: string }) => Response | Promise<Response>,
) {
  const calls: Array<{ url: string; init: RequestInit & { duplex?: string } }> = [];
  const fn: typeof fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fn, calls };
}

describe('query serialization', () => {
  test('nested objects use bracket notation and arrays repeat the key', async () => {
    const f = fakeFetch(() => json({}));
    const http = createHttp({ fetch: f.fn });
    await http.get('https://x/items', {
      signal: sig(),
      query: { filter: { a: 1, b: 'x' }, ids: [1, 2], skip: undefined, flag: true },
    });
    const qs = new URL(f.calls[0]!.url).searchParams;
    expect(qs.get('filter[a]')).toBe('1');
    expect(qs.get('filter[b]')).toBe('x');
    expect(qs.getAll('ids')).toEqual(['1', '2']);
    expect(qs.has('skip')).toBe(false);
    expect(qs.get('flag')).toBe('true');
  });
  test('a custom querySerializer replaces the default', async () => {
    const f = fakeFetch(() => json({}));
    const http = createHttp({
      fetch: f.fn,
      querySerializer: q => 'raw=' + encodeURIComponent(JSON.stringify(q)),
    });
    await http.get('https://x/items', { signal: sig(), query: { a: [1, 2] } });
    expect(new URL(f.calls[0]!.url).searchParams.get('raw')).toBe('{"a":[1,2]}');
  });
});

describe('relative urls without baseUrl', () => {
  const inBrowser = typeof window !== 'undefined';
  afterEach(() => vi.unstubAllGlobals());
  test('resolve against the page location', async () => {
    if (!inBrowser) vi.stubGlobal('location', { href: 'https://app.test/dashboard/index.html' });
    const base = (globalThis as { location: { href: string } }).location.href;
    const f = fakeFetch(() => json({}));
    const http = createHttp({ fetch: f.fn });
    await http.get('/api/items', { signal: sig(), query: { a: 1 } });
    await http.get('rel/path', { signal: sig() });
    expect(f.calls[0]!.url).toBe(new URL('/api/items?a=1', base).href);
    expect(f.calls[1]!.url).toBe(new URL('rel/path', base).href);
  });
  test.skipIf(inBrowser)(
    'reject with a clear TypeError when there is nothing to resolve against',
    async () => {
      vi.stubGlobal('location', undefined);
      const http = createHttp({ fetch: fakeFetch(() => json({})).fn });
      await expect(http.get('/api/items', { signal: sig() })).rejects.toThrow(/baseUrl/);
    },
  );
});

describe('baseUrl per request', () => {
  test('request baseUrl overrides the client one', async () => {
    const f = fakeFetch(() => json({}));
    const http = createHttp({ fetch: f.fn, baseUrl: 'https://api.main/v1' });
    await http.get('/health', { signal: sig(), baseUrl: 'https://api.other/' });
    expect(f.calls[0]!.url).toBe('https://api.other/health');
  });
});

describe('onRequest chain', () => {
  test('an array of hooks runs in order, each seeing the previous result', async () => {
    const f = fakeFetch(() => json({}));
    const http = createHttp({
      fetch: f.fn,
      onRequest: [
        url => ({ url: url + '?a=1' }),
        (url, init) => ({ url: url + '&b=2', init: { ...init, headers: { 'x-seen': url } } }),
      ],
    });
    await http.get('https://x/p', { signal: sig() });
    expect(f.calls[0]!.url).toBe('https://x/p?a=1&b=2');
    expect(new Headers(f.calls[0]!.init.headers).get('x-seen')).toBe('https://x/p?a=1');
  });
});

describe('progress', () => {
  test('onDownloadProgress reports loaded/total while the body streams', async () => {
    const chunks = [new Uint8Array(40), new Uint8Array(60)];
    const f = fakeFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              for (const ch of chunks) c.enqueue(ch);
              c.close();
            },
          }),
          { headers: { 'content-length': '100', 'content-type': 'application/octet-stream' } },
        ),
    );
    const http = createHttp({ fetch: f.fn });
    const seen: Array<[number, number | undefined]> = [];
    const res = await http.request('https://x/file', {
      signal: sig(),
      onDownloadProgress: (loaded, total) => {
        seen.push([loaded, total]);
      },
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBe(100);
    expect(seen).toEqual([
      [40, 100],
      [100, 100],
    ]);
  });
  test('onUploadProgress streams the body with duplex half and reports sent/total', async () => {
    let received = 0;
    const f = fakeFetch(async (_u, init) => {
      const body = init.body as ReadableStream<Uint8Array>;
      for await (const chunk of body) received += chunk.byteLength;
      return json({ ok: true });
    });
    const http = createHttp({ fetch: f.fn });
    const seen: Array<[number, number]> = [];
    const payload = new Blob([new Uint8Array(200_000)]);
    await http.post('https://x/upload', {
      signal: sig(),
      body: payload,
      onUploadProgress: (sent, total) => {
        seen.push([sent, total]);
      },
    });
    expect(f.calls[0]!.init.duplex).toBe('half');
    expect(received).toBe(200_000);
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.at(-1)).toEqual([200_000, 200_000]);
    expect(new Headers(f.calls[0]!.init.headers).get('content-type')).toBeNull();
  });
  test('onUploadProgress works for JSON bodies too', async () => {
    let text = '';
    const f = fakeFetch(async (_u, init) => {
      for await (const chunk of init.body as ReadableStream<Uint8Array>)
        text += new TextDecoder().decode(chunk);
      return json({});
    });
    const http = createHttp({ fetch: f.fn });
    const seen: number[] = [];
    await http.post('https://x/j', {
      signal: sig(),
      body: { hello: 'world' },
      onUploadProgress: sent => {
        seen.push(sent);
      },
    });
    expect(JSON.parse(text)).toEqual({ hello: 'world' });
    expect(seen.at(-1)).toBe(new TextEncoder().encode('{"hello":"world"}').length);
    expect(new Headers(f.calls[0]!.init.headers).get('content-type')).toBe('application/json');
  });
});
