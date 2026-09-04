import { pipe, map, filter, take, debounce, throttle, buffer, toArray } from '../src/iter.js';
import { Channel } from '../src/events.js';
import { sleep } from '../src/signal.js';

async function* from<T>(items: T[]): AsyncGenerator<T> {
  for (const i of items) yield i;
}

describe('basic operators', () => {
  test('map and filter compose via pipe', async () => {
    const out = await toArray(
      pipe(
        from([1, 2, 3, 4]),
        filter(n => n % 2 === 0),
        map(n => n * 10),
      ),
    );
    expect(out).toEqual([20, 40]);
  });
  test('map supports async mappers', async () => {
    const out = await toArray(
      pipe(
        from([1, 2]),
        map(async n => {
          await sleep(0);
          return n + 1;
        }),
      ),
    );
    expect(out).toEqual([2, 3]);
  });
  test('take stops early and closes the source', async () => {
    let closed = false;
    async function* src() {
      try {
        yield 1;
        yield 2;
        yield 3;
      } finally {
        closed = true;
      }
    }
    const out = await toArray(pipe(src(), take(2)));
    expect(out).toEqual([1, 2]);
    expect(closed).toBe(true);
  });
  test('take(0) yields nothing', async () => {
    expect(await toArray(pipe(from([1]), take(0)))).toEqual([]);
  });
  test('buffer groups items by count and flushes the remainder', async () => {
    expect(await toArray(pipe(from([1, 2, 3, 4, 5]), buffer(2)))).toEqual([[1, 2], [3, 4], [5]]);
  });
});

describe('time operators', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test('debounce emits the last value after a quiet period', async () => {
    const ch = new Channel<string>(10);
    const out: string[] = [];
    const consumer = (async () => {
      for await (const v of pipe(ch, debounce(100))) out.push(v);
    })();
    await ch.send('a');
    await vi.advanceTimersByTimeAsync(50);
    await ch.send('ab');
    await vi.advanceTimersByTimeAsync(50);
    await ch.send('abc');
    await vi.advanceTimersByTimeAsync(100);
    expect(out).toEqual(['abc']);
    await ch.send('x');
    await vi.advanceTimersByTimeAsync(100);
    expect(out).toEqual(['abc', 'x']);
    ch.close();
    await consumer;
  });

  test('debounce flushes the pending value when the source ends', async () => {
    const ch = new Channel<number>(10);
    const consumer = toArray(pipe(ch, debounce(100)));
    await ch.send(1);
    ch.close();
    await vi.advanceTimersByTimeAsync(0);
    await expect(consumer).resolves.toEqual([1]);
  });

  test('throttle emits the first value immediately, then at most one per window (trailing)', async () => {
    const ch = new Channel<number>(10);
    const out: number[] = [];
    const consumer = (async () => {
      for await (const v of pipe(ch, throttle(100))) out.push(v);
    })();
    await ch.send(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(out).toEqual([1]);
    await ch.send(2);
    await ch.send(3);
    await vi.advanceTimersByTimeAsync(50);
    expect(out).toEqual([1]);
    await vi.advanceTimersByTimeAsync(50);
    expect(out).toEqual([1, 3]);
    ch.close();
    await consumer;
  });

  test('buffer by time window flushes what arrived in the window', async () => {
    const ch = new Channel<number>(10);
    const out: number[][] = [];
    const consumer = (async () => {
      for await (const v of pipe(ch, buffer({ ms: 100 }))) out.push(v);
    })();
    await ch.send(1);
    await ch.send(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(out).toEqual([[1, 2]]);
    await ch.send(3);
    ch.close();
    await vi.advanceTimersByTimeAsync(0);
    await consumer;
    expect(out).toEqual([[1, 2], [3]]);
  });

  test('consumer breaking out of a debounced stream stops the source', async () => {
    let closed = false;
    async function* src() {
      try {
        yield 1;
        await sleep(1000);
        yield 2;
      } finally {
        closed = true;
      }
    }
    const it = pipe(src(), debounce(10))[Symbol.asyncIterator]();
    await vi.advanceTimersByTimeAsync(10);
    expect((await it.next()).value).toBe(1);
    await it.return!(undefined);
    await vi.advanceTimersByTimeAsync(1000);
    expect(closed).toBe(true);
  });
});
