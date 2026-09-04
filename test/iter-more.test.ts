import { pipe, map, take, toArray, distinctUntilChanged, scan, tap, merge, flatMap, timeout, fromReadableStream } from '../src/iter.js';
import { Channel, select } from '../src/events.js';
import { sleep, isAbort } from '../src/signal.js';

async function* from<T>(items: T[], delay = 0): AsyncGenerator<T> {
  for (const i of items) { if (delay) await sleep(delay); yield i; }
}

describe('distinctUntilChanged', () => {
  test('drops consecutive duplicates', async () => {
    expect(await toArray(pipe(from([1, 1, 2, 2, 2, 1]), distinctUntilChanged()))).toEqual([1, 2, 1]);
  });
  test('accepts a comparator', async () => {
    const out = await toArray(pipe(from([{ id: 1 }, { id: 1 }, { id: 2 }]), distinctUntilChanged((a, b) => a.id === b.id)));
    expect(out).toEqual([{ id: 1 }, { id: 2 }]);
  });
});

describe('scan', () => {
  test('emits running accumulations', async () => {
    expect(await toArray(pipe(from([1, 2, 3]), scan((acc, n) => acc + n, 0)))).toEqual([1, 3, 6]);
  });
});

describe('tap', () => {
  test('observes without changing the stream', async () => {
    const seen: number[] = [];
    expect(await toArray(pipe(from([1, 2]), tap(n => seen.push(n))))).toEqual([1, 2]);
    expect(seen).toEqual([1, 2]);
  });
});

describe('merge', () => {
  test('interleaves sources as they produce and ends when all end', async () => {
    const a = new Channel<string>(10);
    const b = new Channel<string>(10);
    const out = toArray(merge(a, b));
    await a.send('a1'); await b.send('b1'); await a.send('a2');
    a.close(); b.close();
    expect((await out).toSorted((x, y) => x.localeCompare(y))).toEqual(['a1', 'a2', 'b1']);
  });
  test('an error in one source fails the merged stream and stops the others', async () => {
    vi.useFakeTimers();
    let stopped = false;
    async function* bad() { yield 1; throw new Error('bad'); }
    async function* slow() { try { yield 'x'; await sleep(1000); yield 'y'; } finally { stopped = true; } }
    const p = toArray(merge(bad(), slow()));
    await expect(p).rejects.toThrow('bad');
    // the generator is parked in sleep(); return() is queued behind it and runs once it wakes
    await vi.advanceTimersByTimeAsync(1000);
    expect(stopped).toBe(true);
    vi.useRealTimers();
  });
});

describe('flatMap', () => {
  test('maps to inner async iterables with bounded concurrency', async () => {
    let active = 0, peak = 0;
    async function* inner(n: number) {
      active++; peak = Math.max(peak, active);
      await sleep(5);
      yield n * 10;
      active--;
    }
    const out = await toArray(pipe(from([1, 2, 3, 4]), flatMap(inner, { concurrency: 2 })));
    expect(out.toSorted((x, y) => x - y)).toEqual([10, 20, 30, 40]);
    expect(peak).toBe(2);
  });
  test('accepts a mapper returning a promise', async () => {
    const out = await toArray(pipe(from([1, 2]), flatMap(async n => n + 1)));
    expect(out.toSorted((x, y) => x - y)).toEqual([2, 3]);
  });
});

describe('timeout', () => {
  test('rejects with TimeoutError if the source is silent for too long', async () => {
    vi.useFakeTimers();
    const ch = new Channel<number>(5);
    const p = toArray(pipe(ch, timeout(100)));
    p.catch(() => {});
    await ch.send(1);
    await vi.advanceTimersByTimeAsync(50);
    await ch.send(2);
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).rejects.toSatisfy((e: unknown) => (e as DOMException).name === 'TimeoutError');
    vi.useRealTimers();
  });
  test('passes items through when the source keeps up', async () => {
    expect(await toArray(pipe(from([1, 2, 3]), timeout(1000)))).toEqual([1, 2, 3]);
  });
});

describe('fromReadableStream', () => {
  test('iterates a ReadableStream and cancels it on early exit', async () => {
    let cancelled = false;
    const rs = new ReadableStream<number>({
      start(c) { c.enqueue(1); c.enqueue(2); c.enqueue(3); c.close(); },
      cancel() { cancelled = true; },
    });
    expect(await toArray(pipe(fromReadableStream(rs), take(2)))).toEqual([1, 2]);
    expect(cancelled).toBe(true);
  });
});

describe('pipe arity', () => {
  test('supports up to nine operators with types intact', async () => {
    const out = await toArray(pipe(from([1, 2, 3, 4, 5, 6]),
      map(n => n + 1), map(n => n * 2), map(String), map(s => s.length), map(n => n + 1),
      map(n => n * 3), map(n => n - 1), map(n => [n]), map(a => a[0]!)));
    expect(out).toHaveLength(6);
  });
});

describe('Channel.select', () => {
  test('resolves with the first channel that has a value, tagged by index', async () => {
    const a = new Channel<string>(1);
    const b = new Channel<number>(1);
    await b.send(42);
    const r = await select([a, b]);
    expect(r).toEqual({ index: 1, value: 42 });
  });
  test('waits for whichever sends first and does not consume from the others', async () => {
    const a = new Channel<string>();
    const b = new Channel<string>();
    const p = select([a, b]);
    await sleep(1);
    void a.send('from a');
    expect(await p).toEqual({ index: 0, value: 'from a' });
    // b must still be able to deliver its value to the next receiver
    void b.send('from b');
    expect(await b.receive()).toBe('from b');
  });
  test('is cancellable', async () => {
    const c = new AbortController();
    const p = select([new Channel<number>(), new Channel<number>()], c.signal);
    c.abort();
    await expect(p).rejects.toSatisfy(isAbort);
  });
  test('resolves closed when every channel is closed and empty', async () => {
    const a = new Channel<number>(); a.close();
    const b = new Channel<number>(); b.close();
    expect(await select([a, b])).toEqual({ index: -1, closed: true });
  });
});
