import { on, Channel, ChannelClosedError } from '../src/events.js';
import { isAbort } from '../src/signal.js';

const tick = () => new Promise<void>(r => setTimeout(r, 0));

describe('on', () => {
  test('yields events in order, buffering those that arrive while the consumer is busy', async () => {
    const target = new EventTarget();
    const c = new AbortController();
    const seen: string[] = [];
    const loop = (async () => {
      for await (const e of on<CustomEvent<string>>(target, 'msg', { signal: c.signal })) {
        seen.push(e.detail);
        await tick();
      }
    })();
    target.dispatchEvent(new CustomEvent('msg', { detail: 'a' }));
    target.dispatchEvent(new CustomEvent('msg', { detail: 'b' }));
    target.dispatchEvent(new CustomEvent('msg', { detail: 'c' }));
    await tick(); await tick(); await tick(); await tick();
    c.abort();
    await loop;
    expect(seen).toEqual(['a', 'b', 'c']);
  });

  test('ends the iteration gracefully when the signal aborts', async () => {
    const target = new EventTarget();
    const c = new AbortController();
    const it = on(target, 'x', { signal: c.signal })[Symbol.asyncIterator]();
    const next = it.next();
    c.abort();
    await expect(next).resolves.toEqual({ done: true, value: undefined });
  });

  test('removes the listener on return() and on abort', async () => {
    const target = new EventTarget();
    const remove = vi.spyOn(target, 'removeEventListener');
    const it = on(target, 'x')[Symbol.asyncIterator]();
    await it.return!(undefined);
    expect(remove).toHaveBeenCalledTimes(1);

    const c = new AbortController();
    const it2 = on(target, 'x', { signal: c.signal })[Symbol.asyncIterator]();
    it2.next();
    c.abort();
    await tick();
    expect(remove).toHaveBeenCalledTimes(2);
  });

  test('is already finished when the signal is aborted up front', async () => {
    const c = new AbortController();
    c.abort();
    const it = on(new EventTarget(), 'x', { signal: c.signal })[Symbol.asyncIterator]();
    await expect(it.next()).resolves.toEqual({ done: true, value: undefined });
  });

  test('bounded buffer drops the oldest events', async () => {
    const target = new EventTarget();
    const it = on<CustomEvent<number>>(target, 'n', { buffer: 2 })[Symbol.asyncIterator]();
    for (let i = 1; i <= 4; i++) target.dispatchEvent(new CustomEvent('n', { detail: i }));
    expect((await it.next()).value.detail).toBe(3);
    expect((await it.next()).value.detail).toBe(4);
    await it.return!(undefined);
  });
});

describe('Channel', () => {
  test('unbuffered send waits for a receiver', async () => {
    const ch = new Channel<number>();
    let sent = false;
    const s = ch.send(1).then(() => (sent = true));
    await tick();
    expect(sent).toBe(false);
    await expect(ch.receive()).resolves.toBe(1);
    await s;
    expect(sent).toBe(true);
  });

  test('buffered send resolves immediately until capacity is reached', async () => {
    const ch = new Channel<number>(2);
    await ch.send(1);
    await ch.send(2);
    let third = false;
    const p = ch.send(3).then(() => (third = true));
    await tick();
    expect(third).toBe(false);
    expect(ch.size).toBe(2);
    await ch.receive();
    await p;
    expect(third).toBe(true);
  });

  test('receive waits for a value and preserves FIFO order', async () => {
    const ch = new Channel<string>(10);
    const r1 = ch.receive();
    const r2 = ch.receive();
    await ch.send('a');
    await ch.send('b');
    expect(await Promise.all([r1, r2])).toEqual(['a', 'b']);
  });

  test('close() drains buffered values through iteration, then ends', async () => {
    const ch = new Channel<number>(3);
    await ch.send(1);
    await ch.send(2);
    ch.close();
    const out: number[] = [];
    for await (const v of ch) out.push(v);
    expect(out).toEqual([1, 2]);
  });

  test('send on a closed channel throws ChannelClosedError', async () => {
    const ch = new Channel<number>(1);
    ch.close();
    await expect(ch.send(1)).rejects.toBeInstanceOf(ChannelClosedError);
  });

  test('receive on a closed empty channel rejects, and pending receivers are released', async () => {
    const ch = new Channel<number>();
    const pending = ch.receive();
    ch.close();
    await expect(pending).rejects.toBeInstanceOf(ChannelClosedError);
    await expect(ch.receive()).rejects.toBeInstanceOf(ChannelClosedError);
  });

  test('pending senders are rejected on close', async () => {
    const ch = new Channel<number>();
    const p = ch.send(1);
    ch.close();
    await expect(p).rejects.toBeInstanceOf(ChannelClosedError);
  });

  test('a blocked send can be cancelled with a signal', async () => {
    const ch = new Channel<number>();
    const c = new AbortController();
    const s = ch.send(1, c.signal);
    c.abort();
    await expect(s).rejects.toSatisfy(isAbort);
    await expect(Promise.race([ch.receive(), tick().then(() => 'nothing')])).resolves.toBe('nothing');
  });

  test('a waiting receive can be cancelled with a signal', async () => {
    const ch = new Channel<number>();
    const c = new AbortController();
    const r = ch.receive(c.signal);
    c.abort();
    await expect(r).rejects.toSatisfy(isAbort);
    let delivered = false;
    ch.send(1).then(() => (delivered = true));
    await tick();
    expect(delivered).toBe(false);
  });

  test('breaking out of for-await closes the channel', async () => {
    const ch = new Channel<number>(5);
    await ch.send(1);
    await ch.send(2);
    for await (const v of ch) { if (v === 1) break; }
    expect(ch.closed).toBe(true);
  });

  test('backpressure: producer pauses while the consumer is slow', async () => {
    vi.useFakeTimers();
    const ch = new Channel<number>(1);
    const produced: number[] = [];
    const producer = (async () => {
      for (let i = 0; i < 5; i++) { await ch.send(i); produced.push(i); }
      ch.close();
    })();
    await vi.advanceTimersByTimeAsync(0);
    expect(produced.length).toBeLessThanOrEqual(2);
    const consumed: number[] = [];
    for await (const v of ch) { consumed.push(v); await vi.advanceTimersByTimeAsync(10); }
    await producer;
    expect(consumed).toEqual([0, 1, 2, 3, 4]);
    vi.useRealTimers();
  });
});
