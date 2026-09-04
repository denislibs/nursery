import { Channel } from '../src/events.js';
import { pipe, map, take, toArray, zip, combineLatest, share } from '../src/iter.js';
import { sleep } from '../src/signal.js';

async function* from<T>(items: T[], delay = 0): AsyncGenerator<T> {
  for (const i of items) { if (delay) await sleep(delay); yield i; }
}

describe('Channel.trySend / tryReceive', () => {
  test('trySend buffers when there is room and returns false when full', () => {
    const ch = new Channel<number>(1);
    expect(ch.trySend(1)).toBe(true);
    expect(ch.trySend(2)).toBe(false);
    expect(ch.size).toBe(1);
  });
  test('trySend hands the value to a waiting receiver on an unbuffered channel', async () => {
    const ch = new Channel<number>();
    const r = ch.receive();
    expect(ch.trySend(7)).toBe(true);
    await expect(r).resolves.toBe(7);
    expect(ch.trySend(8)).toBe(false);
  });
  test('tryReceive returns the value or ok:false without waiting', async () => {
    const ch = new Channel<number>(2);
    expect(ch.tryReceive()).toEqual({ ok: false });
    await ch.send(5);
    expect(ch.tryReceive()).toEqual({ ok: true, value: 5 });
    expect(ch.tryReceive()).toEqual({ ok: false });
  });
  test('tryReceive unblocks a waiting sender', async () => {
    const ch = new Channel<number>();
    let sent = false;
    const s = ch.send(9).then(() => (sent = true));
    await sleep(0);
    expect(ch.tryReceive()).toEqual({ ok: true, value: 9 });
    await s;
    expect(sent).toBe(true);
  });
  test('trySend on a closed channel throws, tryReceive on closed empty returns ok:false', () => {
    const ch = new Channel<number>(1);
    ch.close();
    expect(() => ch.trySend(1)).toThrow(/closed/i);
    expect(ch.tryReceive()).toEqual({ ok: false });
  });
});

describe('zip', () => {
  test('pairs values by position and ends with the shortest source', async () => {
    const out = await toArray(zip(from([1, 2, 3]), from(['a', 'b'])));
    expect(out).toEqual([[1, 'a'], [2, 'b']]);
  });
  test('closes the longer source when the shorter one ends', async () => {
    let closed = false;
    async function* long() { try { yield 1; yield 2; yield 3; } finally { closed = true; } }
    await toArray(zip(from(['x']), long()));
    expect(closed).toBe(true);
  });
});

describe('combineLatest', () => {
  test('emits once every source has a value, then on every change', async () => {
    const a = new Channel<number>(10);
    const b = new Channel<string>(10);
    const out: Array<[number, string]> = [];
    const consumer = (async () => { for await (const v of combineLatest(a, b)) out.push(v); })();
    await a.send(1); await sleep(1);
    expect(out).toEqual([]);
    await b.send('x'); await sleep(1);
    await a.send(2); await sleep(1);
    a.close(); b.close();
    await consumer;
    expect(out).toEqual([[1, 'x'], [2, 'x']]);
  });
});

describe('share', () => {
  test('one upstream subscription feeds several consumers', async () => {
    let subscriptions = 0;
    async function* src() { subscriptions++; yield 1; await sleep(5); yield 2; await sleep(5); yield 3; }
    const shared = share(src());
    const [a, b] = await Promise.all([toArray(shared), toArray(shared)]);
    expect(a).toEqual([1, 2, 3]);
    expect(b).toEqual([1, 2, 3]);
    expect(subscriptions).toBe(1);
  });
  test('a late consumer only sees values from the moment it joins', async () => {
    async function* src() { yield 1; await sleep(10); yield 2; await sleep(10); yield 3; }
    const shared = share(src());
    const first = toArray(shared);
    await sleep(15);
    const late = toArray(shared);
    expect(await first).toEqual([1, 2, 3]);
    expect(await late).toEqual([3]);
  });
  test('upstream is stopped when the last consumer leaves', async () => {
    let stopped = false;
    async function* src() { try { for (let i = 0; ; i++) { yield i; await sleep(1); } } finally { stopped = true; } }
    const shared = share(src());
    await toArray(pipe(shared, take(3)));
    await sleep(5);
    expect(stopped).toBe(true);
  });
  test('errors propagate to every consumer', async () => {
    async function* src() { yield 1; throw new Error('upstream'); }
    const shared = share(src());
    const results = await Promise.allSettled([toArray(shared), toArray(pipe(shared, map(x => x * 2)))]);
    expect(results.map(r => r.status)).toEqual(['rejected', 'rejected']);
  });
});
