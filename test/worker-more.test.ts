import { expose, wrap, transfer, callback } from '../src/worker.js';
import { isAbort, sleep } from '../src/signal.js';

let channel: MessageChannel;
let stop: () => void;

afterEach(() => {
  stop?.();
  channel?.port1.close();
  channel?.port2.close();
});

function setup<T extends Record<string, (...a: never[]) => unknown>>(api: T) {
  channel = new MessageChannel();
  stop = expose(api, channel.port1);
  return wrap<T>(channel.port2);
}

describe('transfer', () => {
  test('a transferred ArrayBuffer is detached on the sender side and usable on the receiver', async () => {
    const remote = setup({ size: async (buf: ArrayBuffer) => buf.byteLength });
    const buf = new ArrayBuffer(16);
    await expect(remote.size(transfer(buf, [buf]))).resolves.toBe(16);
    expect(buf.byteLength).toBe(0); // detached: it was moved, not copied
  });
  test('transfer works for buffers nested in an options object', async () => {
    const remote = setup({ size: async (o: { data: Uint8Array }) => o.data.byteLength });
    const data = new Uint8Array(8);
    await expect(remote.size(transfer({ data }, [data.buffer]))).resolves.toBe(8);
    expect(data.buffer.byteLength).toBe(0);
  });
  test('results can be transferred back from the worker', async () => {
    const remote = setup({
      make: async (n: number) => {
        const b = new ArrayBuffer(n);
        return transfer(b, [b]);
      },
    });
    const out = await remote.make(32);
    expect(out.byteLength).toBe(32);
  });
});

describe('callback', () => {
  test('a callback argument is invoked in the caller with the worker-provided arguments', async () => {
    const remote = setup({
      work: async (n: number, onProgress: (p: number) => void) => {
        for (let i = 1; i <= n; i++) onProgress(i / n);
        return 'done';
      },
    });
    const seen: number[] = [];
    await expect(
      remote.work(
        4,
        callback((p: number) => {
          seen.push(p);
        }),
      ),
    ).resolves.toBe('done');
    expect(seen).toEqual([0.25, 0.5, 0.75, 1]);
  });
  test('callback return values flow back to the worker as a promise', async () => {
    const remote = setup({
      ask: async (q: string, confirm: (q: string) => Promise<boolean>) => ((await confirm(q)) ? 'yes' : 'no'),
    });
    await expect(
      remote.ask(
        'sure?',
        callback(async (q: string) => q === 'sure?'),
      ),
    ).resolves.toBe('yes');
  });
  test('callback inside an options object works too', async () => {
    const remote = setup({
      run: async (o: { onLog: (m: string) => void }) => {
        o.onLog('a');
        o.onLog('b');
        return 2;
      },
    });
    const logs: string[] = [];
    await expect(
      remote.run({
        onLog: callback((m: string) => {
          logs.push(m);
        }),
      }),
    ).resolves.toBe(2);
    expect(logs).toEqual(['a', 'b']);
  });
  test('callbacks are released after the call settles', async () => {
    const remote = setup({
      keep: async (cb: (x: number) => void) => {
        cb(1);
        return 'ok';
      },
    });
    const spy = vi.fn();
    await remote.keep(callback(spy));
    expect(spy).toHaveBeenCalledWith(1);
    // Additional message traffic on the channel must not resurrect the callback.
    channel.port1.postMessage({ t: 'cb', id: 999, cbId: 0, args: [2] });
    await sleep(10);
    expect(spy).toHaveBeenCalledTimes(1);
  });
  test('callbacks and signals can be combined in one call', async () => {
    const remote = setup({
      long: async (o: { signal: AbortSignal; onTick: (i: number) => void }) => {
        for (let i = 0; ; i++) {
          o.onTick(i);
          await sleep(5, o.signal);
        }
      },
    });
    const c = new AbortController();
    const ticks: number[] = [];
    const p = remote.long({
      signal: c.signal,
      onTick: callback((i: number) => {
        ticks.push(i);
        if (i >= 2) c.abort();
      }),
    });
    await expect(p).rejects.toSatisfy(isAbort);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
  });
});
