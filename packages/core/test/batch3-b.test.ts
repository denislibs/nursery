import { share, toArray, pipe, take } from '../src/iter.js';
import { wrap, transfer, callback } from '../src/worker.js';
import { mockWorker } from '../src/testing.js';
import { sleep, isAbort } from '../src/signal.js';

describe('share resubscribe', () => {
  test('by default a consumer joining after the source ended gets done immediately', async () => {
    async function* src() {
      yield 1;
    }
    const shared = share(src());
    expect(await toArray(shared)).toEqual([1]);
    expect(await toArray(shared)).toEqual([]);
  });
  test('with a factory and resubscribe, a new consumer restarts the source', async () => {
    let starts = 0;
    const shared = share(
      () =>
        (async function* () {
          starts++;
          yield starts;
        })(),
      { resubscribe: true },
    );
    expect(await toArray(shared)).toEqual([1]);
    expect(await toArray(shared)).toEqual([2]);
    expect(starts).toBe(2);
  });
  test('resubscribe also restarts after the last consumer left early', async () => {
    let starts = 0;
    const shared = share(
      () =>
        (async function* () {
          starts++;
          for (let i = 0; ; i++) {
            yield i;
            await sleep(1);
          }
        })(),
      { resubscribe: true },
    );
    await toArray(pipe(shared, take(2)));
    await toArray(pipe(shared, take(2)));
    expect(starts).toBe(2);
  });
});

describe('deep callbacks, signals and transfer', () => {
  let w: ReturnType<typeof mockWorker>;
  afterEach(() => {
    w?.terminate();
  });

  test('callbacks inside arrays and nested objects are invoked', async () => {
    const api = {
      run: async (jobs: Array<{ name: string; hooks: { onDone: (n: string) => void } }>) => {
        for (const j of jobs) j.hooks.onDone(j.name);
        return jobs.length;
      },
    };
    w = mockWorker(api);
    const remote = wrap<typeof api>(w);
    const done: string[] = [];
    await expect(
      remote.run([
        {
          name: 'a',
          hooks: {
            onDone: callback((n: string) => {
              done.push(n);
            }),
          },
        },
        {
          name: 'b',
          hooks: {
            onDone: callback((n: string) => {
              done.push(n);
            }),
          },
        },
      ]),
    ).resolves.toBe(2);
    expect(done).toEqual(['a', 'b']);
    remote[Symbol.dispose]();
  });

  test('a signal nested deep in the arguments arrives live and aborts', async () => {
    const api = {
      go: async (o: { opts: { nested: { signal: AbortSignal } } }) => {
        await sleep(1000, o.opts.nested.signal);
        return 'no';
      },
    };
    w = mockWorker(api);
    const remote = wrap<typeof api>(w);
    const c = new AbortController();
    const p = remote.go({ opts: { nested: { signal: c.signal } } });
    c.abort();
    await expect(p).rejects.toSatisfy(isAbort);
    remote[Symbol.dispose]();
  });

  test('transfer on a nested object inside an array moves the buffer', async () => {
    const api = { sizes: async (items: Array<{ buf: ArrayBuffer }>) => items.map(i => i.buf.byteLength) };
    w = mockWorker(api);
    const remote = wrap<typeof api>(w);
    const buf = new ArrayBuffer(8);
    await expect(remote.sizes([transfer({ buf }, [buf])])).resolves.toEqual([8]);
    expect(buf.byteLength).toBe(0);
    remote[Symbol.dispose]();
  });

  test('callback arguments and return values honour transfer', async () => {
    const api = {
      produce: async (deliver: (chunk: ArrayBuffer) => Promise<ArrayBuffer>) => {
        const out = new ArrayBuffer(16);
        const echoed = await deliver(transfer(out, [out]));
        return [out.byteLength, echoed.byteLength]; // out was moved: 0; echoed came back: 16
      },
    };
    w = mockWorker(api);
    const remote = wrap<typeof api>(w);
    const result = await remote.produce(callback(async (chunk: ArrayBuffer) => transfer(chunk, [chunk])));
    expect(result).toEqual([0, 16]);
    remote[Symbol.dispose]();
  });

  test('a callback can itself receive a callback', async () => {
    const api = {
      outer: async (cb: (inner: (x: number) => Promise<number>) => Promise<number>) =>
        cb(callback(async (x: number) => x * 2)),
    };
    w = mockWorker(api);
    const remote = wrap<typeof api>(w);
    await expect(remote.outer(callback(async inner => inner(21)))).resolves.toBe(42);
    remote[Symbol.dispose]();
  });
});
