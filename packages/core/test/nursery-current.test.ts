import { Nursery } from '../src/nursery.js';
import { sleep } from '../src/signal.js';

describe('Nursery.current', () => {
  test('is undefined outside of any nursery', () => {
    expect(Nursery.current()).toBeUndefined();
  });
  test('is set synchronously inside a spawned task and inside Nursery.run', async () => {
    let inTask: Nursery | undefined;
    let inRun: Nursery | undefined;
    const outer = await Nursery.run(async nursery => {
      inRun = Nursery.current();
      await nursery.spawn(async () => {
        inTask = Nursery.current();
      });
      return nursery;
    });
    expect(inRun).toBe(outer);
    expect(inTask).toBe(outer);
    expect(Nursery.current()).toBeUndefined();
  });
  test('enter() runs a function with the nursery as current and restores afterwards', () => {
    const a = new Nursery({ name: 'a' });
    const b = new Nursery({ name: 'b' });
    const seen: Array<string | undefined> = [];
    a.enter(() => {
      seen.push(Nursery.current()?.name);
      b.enter(() => seen.push(Nursery.current()?.name));
      seen.push(Nursery.current()?.name);
    });
    seen.push(Nursery.current()?.name);
    expect(seen).toEqual(['a', 'b', 'a', undefined]);
  });
  test('nested spawn without an explicit nursery attaches to the current one', async () => {
    const nursery = new Nursery({ name: 'root' });
    let child: Nursery | undefined;
    await nursery.spawn(async () => {
      child = Nursery.current()!.child({ name: 'inner' });
    });
    expect(child?.name).toBe('inner');
    expect(nursery.children.map(c => c.name)).toEqual(['inner']);
    await nursery.close();
  });
  test('after the first await, current is only kept when AsyncContext is available', async () => {
    let after: Nursery | undefined;
    const hasAsyncContext = 'AsyncContext' in globalThis;
    await Nursery.run(async nursery => {
      await sleep(1, nursery.signal);
      after = Nursery.current();
    });
    if (hasAsyncContext) expect(after).toBeDefined();
    else expect(after).toBeUndefined();
  });
});

describe('detached children', () => {
  test('a detached child inherits ctx and cancellation but is not tracked until adopted', async () => {
    const parent = new Nursery({ name: 'p' });
    const child = parent.child({ name: 'c' }, { detached: true });
    expect(parent.children).toEqual([]);
    parent.adopt(child);
    expect(parent.children.map(c => c.name)).toEqual(['c']);
    parent.adopt(child); // idempotent
    expect(parent.children).toHaveLength(1);
    parent.abort();
    expect(child.signal.aborted).toBe(true);
    await parent.close();
  });
  test('closing a detached child never touches the parent list', async () => {
    const parent = new Nursery();
    const child = parent.child({}, { detached: true });
    await child.close();
    expect(parent.children).toEqual([]);
    await parent.close();
  });
});

describe('profiling', () => {
  afterEach(() => {
    Nursery.profiling = false;
    performance.clearMarks();
    performance.clearMeasures();
  });
  test('when enabled, each task produces a performance measure with nursery and task names', async () => {
    Nursery.profiling = true;
    const nursery = new Nursery({ name: 'page' });
    await nursery.spawn(sig => sleep(2, sig), { name: 'load' });
    const measures = performance.getEntriesByType('measure').filter(m => m.name.startsWith('nursery:'));
    expect(measures.map(m => m.name)).toEqual(['nursery:page/load']);
    expect(measures[0]!.duration).toBeGreaterThan(0);
    expect((measures[0] as PerformanceMeasure).detail).toMatchObject({
      nursery: 'page',
      task: 'load',
      status: 'ok',
    });
    await nursery.close();
  });
  test('failed and aborted tasks are marked with their status', async () => {
    Nursery.profiling = true;
    const nursery = new Nursery({ name: 's' });
    await nursery
      .spawn(
        async () => {
          throw new Error('x');
        },
        { name: 'bad' },
      )
      .catch(() => {});
    const p = nursery.spawn(sig => sleep(100, sig), { name: 'slow' });
    nursery.abort();
    await p.catch(() => {});
    const detail = Object.fromEntries(
      performance
        .getEntriesByType('measure')
        .filter(m => m.name.startsWith('nursery:'))
        .map(m => [(m as PerformanceMeasure).detail.task, (m as PerformanceMeasure).detail.status]),
    );
    expect(detail).toEqual({ bad: 'error', slow: 'aborted' });
  });
  test('nursery lifetime is measured on close', async () => {
    Nursery.profiling = true;
    const nursery = new Nursery({ name: 'lifetime' });
    await sleep(2);
    await nursery.close();
    const names = performance.getEntriesByType('measure').map(m => m.name);
    expect(names).toContain('nursery:lifetime');
  });
  test('nothing is recorded when profiling is off', async () => {
    const nursery = new Nursery({ name: 'quiet' });
    await nursery.spawn(async () => 1, { name: 't' });
    await nursery.close();
    expect(performance.getEntriesByType('measure').filter(m => m.name.startsWith('nursery:'))).toEqual([]);
  });
});
