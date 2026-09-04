import { Scope } from '../src/scope.js';
import { sleep } from '../src/signal.js';

describe('Scope.current', () => {
  test('is undefined outside of any scope', () => {
    expect(Scope.current()).toBeUndefined();
  });
  test('is set synchronously inside a spawned task and inside Scope.run', async () => {
    let inTask: Scope | undefined;
    let inRun: Scope | undefined;
    const outer = await Scope.run(async scope => {
      inRun = Scope.current();
      await scope.spawn(async () => { inTask = Scope.current(); });
      return scope;
    });
    expect(inRun).toBe(outer);
    expect(inTask).toBe(outer);
    expect(Scope.current()).toBeUndefined();
  });
  test('enter() runs a function with the scope as current and restores afterwards', () => {
    const a = new Scope({ name: 'a' });
    const b = new Scope({ name: 'b' });
    const seen: Array<string | undefined> = [];
    a.enter(() => {
      seen.push(Scope.current()?.name);
      b.enter(() => seen.push(Scope.current()?.name));
      seen.push(Scope.current()?.name);
    });
    seen.push(Scope.current()?.name);
    expect(seen).toEqual(['a', 'b', 'a', undefined]);
  });
  test('nested spawn without an explicit scope attaches to the current one', async () => {
    const scope = new Scope({ name: 'root' });
    let child: Scope | undefined;
    await scope.spawn(async () => {
      child = Scope.current()!.child({ name: 'inner' });
    });
    expect(child?.name).toBe('inner');
    expect(scope.children.map(c => c.name)).toEqual(['inner']);
    await scope.close();
  });
  test('after the first await, current is only kept when AsyncContext is available', async () => {
    let after: Scope | undefined;
    const hasAsyncContext = 'AsyncContext' in globalThis;
    await Scope.run(async scope => {
      await sleep(1, scope.signal);
      after = Scope.current();
    });
    if (hasAsyncContext) expect(after).toBeDefined();
    else expect(after).toBeUndefined();
  });
});

describe('detached children', () => {
  test('a detached child inherits ctx and cancellation but is not tracked until adopted', async () => {
    const parent = new Scope({ name: 'p' });
    const child = parent.child({ name: 'c' }, { detached: true });
    expect(parent.children).toEqual([]);
    parent.adopt(child);
    expect(parent.children.map(c => c.name)).toEqual(['c']);
    parent.adopt(child);   // idempotent
    expect(parent.children).toHaveLength(1);
    parent.abort();
    expect(child.signal.aborted).toBe(true);
    await parent.close();
  });
  test('closing a detached child never touches the parent list', async () => {
    const parent = new Scope();
    const child = parent.child({}, { detached: true });
    await child.close();
    expect(parent.children).toEqual([]);
    await parent.close();
  });
});

describe('profiling', () => {
  afterEach(() => { Scope.profiling = false; performance.clearMarks(); performance.clearMeasures(); });
  test('when enabled, each task produces a performance measure with scope and task names', async () => {
    Scope.profiling = true;
    const scope = new Scope({ name: 'page' });
    await scope.spawn(sig => sleep(2, sig), { name: 'load' });
    const measures = performance.getEntriesByType('measure').filter(m => m.name.startsWith('scopekit:'));
    expect(measures.map(m => m.name)).toEqual(['scopekit:page/load']);
    expect(measures[0]!.duration).toBeGreaterThan(0);
    expect((measures[0] as PerformanceMeasure).detail).toMatchObject({ scope: 'page', task: 'load', status: 'ok' });
    await scope.close();
  });
  test('failed and aborted tasks are marked with their status', async () => {
    Scope.profiling = true;
    const scope = new Scope({ name: 's' });
    await scope.spawn(async () => { throw new Error('x'); }, { name: 'bad' }).catch(() => {});
    const p = scope.spawn(sig => sleep(100, sig), { name: 'slow' });
    scope.abort();
    await p.catch(() => {});
    const detail = Object.fromEntries(performance.getEntriesByType('measure').filter(m => m.name.startsWith('scopekit:'))
      .map(m => [(m as PerformanceMeasure).detail.task, (m as PerformanceMeasure).detail.status]));
    expect(detail).toEqual({ bad: 'error', slow: 'aborted' });
  });
  test('scope lifetime is measured on close', async () => {
    Scope.profiling = true;
    const scope = new Scope({ name: 'lifetime' });
    await sleep(2);
    await scope.close();
    const names = performance.getEntriesByType('measure').map(m => m.name);
    expect(names).toContain('scopekit:lifetime');
  });
  test('nothing is recorded when profiling is off', async () => {
    const scope = new Scope({ name: 'quiet' });
    await scope.spawn(async () => 1, { name: 't' });
    await scope.close();
    expect(performance.getEntriesByType('measure').filter(m => m.name.startsWith('scopekit:'))).toEqual([]);
  });
});
