import { latestBy } from '../src/latest.js';
import { on, Channel } from '../src/events.js';
import { share } from '../src/iter.js';
import { onWarning } from '../src/diagnostics.js';
import { sleep } from '../src/signal.js';
import { expectAborted } from '../src/testing.js';

describe('latestBy.cancel() without a key', () => {
  test('cancels every in-flight call and empties the map', async () => {
    const load = latestBy(
      (id: number) => id,
      async (_id: number, signal: AbortSignal) => sleep(1000, signal),
    );
    const p1 = load(1);
    const p2 = load(2);
    load.cancel();
    await expectAborted(p1);
    await expectAborted(p2);
    expect(load.size).toBe(0);
    expect(load.pending()).toBe(false);
  });
  test('cancel(undefined) behaves like cancel() and cancel(key) is scoped', async () => {
    const load = latestBy(
      (id: number) => id,
      async (_id: number, signal: AbortSignal) => sleep(1000, signal),
    );
    const p1 = load(1);
    const p2 = load(2);
    load.cancel(1);
    await expectAborted(p1);
    expect(load.pending(2)).toBe(true);
    load.cancel(undefined);
    await expectAborted(p2);
    expect(load.size).toBe(0);
  });
});

describe('backlog warnings', () => {
  let warnings: Array<{ code: string; detail: Record<string, unknown> }> = [];
  let off: () => void;
  beforeEach(() => {
    warnings = [];
    off = onWarning(w => warnings.push({ code: w.code, detail: w.detail }));
  });
  afterEach(() => off());

  test('on() warns once when the backlog exceeds warnAt (default 1000)', () => {
    const target = new EventTarget();
    const it = on(target, 'x')[Symbol.asyncIterator]();
    for (let i = 0; i < 1500; i++) target.dispatchEvent(new Event('x'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.code).toBe('event-backlog');
    expect(warnings[0]!.detail).toMatchObject({ type: 'x', size: 1001 });
    void it.return!(undefined);
  });
  test('warnAt can be tuned per call and a bounded buffer never warns', () => {
    const target = new EventTarget();
    const it = on(target, 'y', { warnAt: 10 })[Symbol.asyncIterator]();
    for (let i = 0; i < 12; i++) target.dispatchEvent(new Event('y'));
    expect(warnings.map(w => w.detail['size'])).toEqual([11]);
    void it.return!(undefined);

    const bounded = on(target, 'z', { buffer: 5 })[Symbol.asyncIterator]();
    for (let i = 0; i < 2000; i++) target.dispatchEvent(new Event('z'));
    expect(warnings).toHaveLength(1);
    void bounded.return!(undefined);
  });
  test('share() warns when a slow consumer accumulates a backlog', async () => {
    const ch = new Channel<number>(5000);
    const shared = share(ch, { warnAt: 100 });
    const fast = shared[Symbol.asyncIterator]();
    const slow = shared[Symbol.asyncIterator]();
    for (let i = 0; i < 150; i++) await ch.send(i);
    for (let i = 0; i < 150; i++) await fast.next();
    await sleep(0);
    expect(warnings.filter(w => w.code === 'share-backlog')).toHaveLength(1);
    await slow.return!(undefined);
    await fast.return!(undefined);
    ch.close();
  });
  test('without subscribers the default sink is console.warn', () => {
    off();
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const target = new EventTarget();
    const it = on(target, 'q', { warnAt: 1 })[Symbol.asyncIterator]();
    target.dispatchEvent(new Event('q'));
    target.dispatchEvent(new Event('q'));
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    void it.return!(undefined);
  });
});
