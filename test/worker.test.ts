import { expose, wrap } from '../src/worker.js';
import { isAbort, sleep } from '../src/signal.js';

const api = {
  add: async (a: number, b: number) => a + b,
  fail: async () => { throw new RangeError('out of range'); },
  slow: async (ms: number, opts: { signal: AbortSignal }) => {
    try {
      await sleep(ms, opts.signal);
      return 'finished';
    } catch (e) {
      state.aborted = isAbort(e);
      state.reason = (e as Error).message;
      throw e;
    }
  },
  slowPositional: async (ms: number, signal: AbortSignal) => { await sleep(ms, signal); return 'done'; },
  echoSignalType: async (signal: AbortSignal) => signal instanceof AbortSignal,
  unclonable: async () => () => 1,
};
type Api = typeof api;
const state = { aborted: false, reason: '' };

let channel: MessageChannel;
let stop: () => void;
let remote: ReturnType<typeof wrap<Api>>;

beforeEach(() => {
  state.aborted = false;
  channel = new MessageChannel();
  stop = expose(api, channel.port1);
  remote = wrap<Api>(channel.port2);
});
afterEach(() => {
  stop();
  remote[Symbol.dispose]();
  channel.port1.close();
  channel.port2.close();
});

describe('wrap/expose', () => {
  test('calls a remote method and returns its result', async () => {
    await expect(remote.add(2, 3)).resolves.toBe(5);
  });

  test('propagates errors with name and message', async () => {
    const err = await remote.fail().catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('RangeError');
    expect(err.message).toBe('out of range');
  });

  test('unknown method rejects', async () => {
    await expect((remote as unknown as { nope: () => Promise<void> }).nope()).rejects.toThrow(/nope/);
  });

  test('concurrent calls resolve independently', async () => {
    const [a, b, c] = await Promise.all([remote.add(1, 1), remote.add(2, 2), remote.add(3, 3)]);
    expect([a, b, c]).toEqual([2, 4, 6]);
  });

  test('a signal inside an options object arrives as a real AbortSignal on the worker side', async () => {
    const c = new AbortController();
    await expect(remote.slow(0, { signal: c.signal })).resolves.toBe('finished');
  });

  test('a positional AbortSignal is forwarded too', async () => {
    await expect(remote.echoSignalType(new AbortController().signal)).resolves.toBe(true);
  });

  test('aborting the caller signal rejects locally and aborts the remote task', async () => {
    const c = new AbortController();
    const p = remote.slow(10_000, { signal: c.signal });
    await new Promise(r => setTimeout(r, 5));
    c.abort(new DOMException('user left', 'AbortError'));
    await expect(p).rejects.toSatisfy(isAbort);
    await vi.waitFor(() => expect(state.aborted).toBe(true));
    expect(state.reason).toBe('user left');
  });

  test('a positional signal abort reaches the worker as well', async () => {
    const c = new AbortController();
    const p = remote.slowPositional(10_000, c.signal);
    c.abort();
    await expect(p).rejects.toSatisfy(isAbort);
  });

  test('an already-aborted signal rejects without posting a message', async () => {
    const spy = vi.spyOn(channel.port2, 'postMessage');
    const c = new AbortController();
    c.abort();
    await expect(remote.slow(1, { signal: c.signal })).rejects.toSatisfy(isAbort);
    expect(spy).not.toHaveBeenCalled();
  });

  test('an unclonable return value rejects instead of hanging', async () => {
    await expect(remote.unclonable()).rejects.toThrow();
  });

  test('calls after dispose reject, and in-flight calls are rejected on dispose', async () => {
    const inflight = remote.slow(10_000, { signal: new AbortController().signal });
    remote[Symbol.dispose]();
    await expect(inflight).rejects.toThrow(/disposed/);
    await expect(remote.add(1, 2)).rejects.toThrow(/disposed/);
  });
});
