import { createPool, expose, wrap } from '../src/worker.js';
import { mockWorker, fakeFetch, jsonResponse, streamResponse, tick, settle, expectAborted, fakeClock, portPair } from '../src/testing.js';
import { sleep, isAbort } from '../src/signal.js';
import { retry } from '../src/combine.js';

const api = {
  add: async (a: number, b: number) => a + b,
  slow: async (ms: number, opts: { signal: AbortSignal }) => { await sleep(ms, opts.signal); return 'done'; },
};

describe('mockWorker', () => {
  test('behaves like a Worker endpoint for wrap() and terminates cleanly', async () => {
    const w = mockWorker(api);
    const remote = wrap<typeof api>(w);
    await expect(remote.add(1, 2)).resolves.toBe(3);
    remote[Symbol.dispose]();
    w.terminate();
  });
});

describe('createPool', () => {
  test('dispatches calls across workers with bounded concurrency', async () => {
    let active = 0, peak = 0;
    const factory = () => mockWorker({
      job: async (ms: number, o: { signal: AbortSignal }) => { active++; peak = Math.max(peak, active); await sleep(ms, o.signal); active--; return ms; },
    });
    const pool = createPool<{ job: (ms: number, o: { signal: AbortSignal }) => Promise<number> }>(factory, { size: 2 });
    const c = new AbortController();
    const results = await Promise.all([10, 10, 10, 10].map(ms => pool.api.job(ms, { signal: c.signal })));
    expect(results).toEqual([10, 10, 10, 10]);
    expect(peak).toBe(2);
    expect(pool.size).toBe(2);
    pool.dispose();
  });
  test('workers are created lazily up to size', async () => {
    const factory = vi.fn(() => mockWorker(api));
    const pool = createPool<typeof api>(factory, { size: 3 });
    expect(factory).toHaveBeenCalledTimes(0);
    await pool.api.add(1, 1);
    expect(factory).toHaveBeenCalledTimes(1);
    await Promise.all([pool.api.slow(5, { signal: new AbortController().signal }), pool.api.slow(5, { signal: new AbortController().signal })]);
    expect(factory).toHaveBeenCalledTimes(2);
    pool.dispose();
  });
  test('aborting a queued call removes it from the queue and aborting a running one reaches the worker', async () => {
    const pool = createPool<typeof api>(() => mockWorker(api), { size: 1 });
    const c1 = new AbortController();
    const c2 = new AbortController();
    const running = pool.api.slow(1000, { signal: c1.signal });
    const queued = pool.api.slow(1000, { signal: c2.signal });
    await tick();
    expect(pool.pending).toBe(1);
    expect(pool.queued).toBe(1);
    c2.abort();
    await expectAborted(queued);
    expect(pool.queued).toBe(0);
    expect(pool.pending).toBe(1);
    c1.abort();
    await expectAborted(running);
    await tick();
    expect(pool.pending).toBe(0);
    pool.dispose();
  });
  test('run() gives access to a remote plus a signal', async () => {
    const pool = createPool<typeof api>(() => mockWorker(api), { size: 1 });
    const out = await pool.run(async remote => remote.add(2, 2));
    expect(out).toBe(4);
    pool.dispose();
  });
  test('dispose terminates workers and rejects new calls', async () => {
    const terminated: number[] = [];
    let n = 0;
    const pool = createPool<typeof api>(() => { const id = ++n; const w = mockWorker(api); const t = w.terminate.bind(w); w.terminate = () => { terminated.push(id); t(); }; return w; }, { size: 2 });
    await pool.api.add(1, 1);
    pool.dispose();
    expect(terminated).toEqual([1]);
    await expect(pool.api.add(1, 1)).rejects.toThrow(/disposed/);
  });
});

describe('testing helpers', () => {
  test('fakeFetch wraps plain return values as JSON and records calls', async () => {
    const f = fakeFetch(() => ({ ok: 1 }));
    const res = await f.fetch('https://x/a', { method: 'POST' });
    expect(await res.json()).toEqual({ ok: 1 });
    expect(f.calls[0]).toMatchObject({ url: 'https://x/a', method: 'POST' });
    f.reset();
    expect(f.calls).toEqual([]);
  });
  test('fakeFetch routes by method and path pattern', async () => {
    const f = fakeFetch({
      'GET /users/:id': ({ params }) => ({ id: params.id }),
      'POST /users': () => jsonResponse({ created: true }, { status: 201 }),
    });
    expect(await (await f.fetch('https://x/users/7')).json()).toEqual({ id: '7' });
    const created = await f.fetch('https://x/users', { method: 'POST' });
    expect(created.status).toBe(201);
    const missing = await f.fetch('https://x/nope');
    expect(missing.status).toBe(404);
  });
  test('streamResponse yields chunks over a body stream', async () => {
    const res = streamResponse(['a', 'b'], { headers: { 'content-type': 'text/plain' } });
    expect(await res.text()).toBe('ab');
  });
  test('settle attaches a handler immediately and reports the outcome', async () => {
    const p = Promise.reject(new Error('x'));
    const s = settle(p);
    await tick();
    expect(await s).toMatchObject({ status: 'rejected' });
    expect(await settle(Promise.resolve(1))).toEqual({ status: 'fulfilled', value: 1 });
  });
  test('expectAborted resolves with the abort reason and fails otherwise', async () => {
    const c = new AbortController();
    const p = sleep(1000, c.signal);
    c.abort();
    const reason = await expectAborted(p);
    expect(isAbort(reason)).toBe(true);
    await expect(expectAborted(Promise.resolve('nope'))).rejects.toThrow(/expected .*abort/i);
    await expect(expectAborted(Promise.reject(new Error('real')))).rejects.toThrow('real');
  });
  test('fakeClock drives timers and captures rejections before advancing', async () => {
    const clock = fakeClock(vi);
    clock.install();
    try {
      const p = retry(async () => { throw new Error('always'); }, { retries: 2, delay: 100 });
      const rejection = clock.rejection(p);
      await clock.tick(100);
      await clock.tick(200);
      expect((await rejection).message).toBe('always');
    } finally {
      clock.uninstall();
    }
  });
  test('portPair gives two connected endpoints', async () => {
    const pair = portPair();
    const stop = expose(api, pair.a);
    const remote = wrap<typeof api>(pair.b);
    await expect(remote.add(4, 5)).resolves.toBe(9);
    remote[Symbol.dispose](); stop(); pair.close();
  });
});
