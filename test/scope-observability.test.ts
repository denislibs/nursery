import { Scope, ScopeStuckError } from '../src/scope.js';
import { isAbort, sleep } from '../src/signal.js';

const tick = () => new Promise<void>(r => setTimeout(r, 0));
let reports: Array<{ error: unknown; scope: Scope; task?: { name: string } }> = [];
let unsubscribe: () => void;

beforeEach(() => {
  reports = [];
  unsubscribe = Scope.onUnhandled((error, ctx) => reports.push({ error, scope: ctx.scope, task: ctx.task }));
});
afterEach(() => unsubscribe());

describe('task names and introspection', () => {
  test('spawn accepts a name; running tasks are listed with elapsed time', async () => {
    const scope = new Scope({ name: 'page' });
    const p = scope.spawn(sig => sleep(50, sig), { name: 'loadUser' });
    expect(scope.name).toBe('page');
    expect(scope.tasks.map(t => t.name)).toEqual(['loadUser']);
    expect(scope.tasks[0]!.elapsed).toBeGreaterThanOrEqual(0);
    await p;
    expect(scope.tasks).toEqual([]);
  });

  test('unnamed tasks get a fallback name', () => {
    const scope = new Scope();
    scope.spawn(sig => sleep(10, sig));
    expect(scope.tasks[0]!.name).toBe('task#1');
    scope.abort();
  });

  test('children are listed and removed when closed', async () => {
    const parent = new Scope({ name: 'root' });
    const child = parent.child({ name: 'widget' });
    expect(parent.children.map(c => c.name)).toEqual(['widget']);
    await child.close();
    expect(parent.children).toEqual([]);
  });

  test('inspect() returns the tree and dump() renders it', async () => {
    const root = new Scope({ name: 'root' });
    root.spawn(sig => sleep(100, sig), { name: 'poll' });
    const widget = root.child({ name: 'widget' });
    widget.spawn(sig => sleep(100, sig), { name: 'render' });

    const tree = root.inspect();
    expect(tree.name).toBe('root');
    expect(tree.closed).toBe(false);
    expect(tree.tasks.map(t => t.name)).toEqual(['poll']);
    expect(tree.children[0]!.name).toBe('widget');
    expect(tree.children[0]!.tasks[0]!.name).toBe('render');

    const text = root.dump();
    expect(text).toContain('root');
    expect(text).toContain('poll');
    expect(text).toContain('widget');
    expect(text).toContain('render');
    await root.close();
  });
});

describe('onUnhandled', () => {
  test('reports a failed task nobody awaited, with scope and task info', async () => {
    const scope = new Scope({ name: 's' });
    scope.spawn(async () => { throw new Error('lost'); }, { name: 'bg' });
    await tick();
    await tick();
    expect(reports).toHaveLength(1);
    expect((reports[0]!.error as Error).message).toBe('lost');
    expect(reports[0]!.scope).toBe(scope);
    expect(reports[0]!.task?.name).toBe('bg');
  });

  test('does not report a failure the caller awaited', async () => {
    const scope = new Scope();
    await expect(scope.spawn(async () => { throw new Error('seen'); })).rejects.toThrow('seen');
    await tick();
    expect(reports).toEqual([]);
  });

  test('does not report a failure the caller handled with catch', async () => {
    const scope = new Scope();
    scope.spawn(async () => { throw new Error('caught'); }).catch(() => {});
    await tick();
    await tick();
    expect(reports).toEqual([]);
  });

  test('does not report aborts', async () => {
    const scope = new Scope();
    scope.spawn(sig => sleep(1000, sig));
    scope.abort();
    await tick();
    await tick();
    expect(reports).toEqual([]);
  });

  test('does not report the error that Scope.run surfaces', async () => {
    await expect(Scope.run(async scope => {
      scope.spawn(async () => { throw new Error('surfaced'); });
      await sleep(5);
      return 'unreachable';
    })).rejects.toThrow('surfaced');
    await tick();
    expect(reports).toEqual([]);
  });

  test('unsubscribe stops delivery', async () => {
    unsubscribe();
    const scope = new Scope();
    scope.spawn(async () => { throw new Error('silent'); });
    await tick();
    await tick();
    expect(reports).toEqual([]);
  });
});

describe('Scope.run error precedence', () => {
  test('when the body dies of a sibling abort, run throws the original sibling error', async () => {
    await expect(Scope.run(async scope => {
      scope.spawn(async () => { throw new Error('root cause'); });
      await scope.spawn(sig => sleep(1000, sig));   // will be aborted by the sibling failure
    })).rejects.toThrow('root cause');
  });
});

describe('close with grace', () => {
  test('a task that ignores the signal blocks close() without grace', async () => {
    const scope = new Scope();
    scope.spawn(() => new Promise(() => {}), { name: 'stubborn' });
    const closed = scope.close().then(() => 'closed');
    await expect(Promise.race([closed, sleep(30).then(() => 'still waiting')])).resolves.toBe('still waiting');
  });

  test('close({ grace }) resolves after the grace period and reports stuck tasks', async () => {
    const scope = new Scope({ name: 'leaky' });
    scope.spawn(() => new Promise(() => {}), { name: 'stubborn' });
    scope.spawn(sig => sleep(1, sig), { name: 'polite' });
    let cleaned = false;
    scope.defer(() => { cleaned = true; });

    await scope.close({ grace: 20 });

    expect(cleaned).toBe(true);
    expect(reports).toHaveLength(1);
    const err = reports[0]!.error as ScopeStuckError;
    expect(err).toBeInstanceOf(ScopeStuckError);
    expect(err.tasks.map(t => t.name)).toEqual(['stubborn']);
    expect(err.message).toContain('stubborn');
    expect(reports[0]!.scope).toBe(scope);
  });

  test('grace can be set as a scope default and is used by await using', async () => {
    {
      await using scope = new Scope({ grace: 20 });
      scope.spawn(() => new Promise(() => {}), { name: 'stubborn' });
    }
    expect(reports.map(r => (r.error as Error).name)).toEqual(['ScopeStuckError']);
  });

  test('a stuck child scope is reported through the parent close', async () => {
    const parent = new Scope({ name: 'parent', grace: 20 });
    const child = parent.child({ name: 'child' });
    child.spawn(() => new Promise(() => {}), { name: 'stubborn' });
    await parent.close();
    expect(reports).toHaveLength(1);
    expect((reports[0]!.error as ScopeStuckError).tasks[0]!.name).toBe('stubborn');
  });
});

describe('deadline', () => {
  test('a scope with timeout exposes an absolute deadline and remaining()', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const scope = new Scope({ timeout: 1000 });
    expect(scope.deadline).toBe(performance.now() + 1000);
    vi.advanceTimersByTime(300);
    expect(scope.remaining()).toBe(700);
    vi.useRealTimers();
    scope.abort();
  });

  test('a scope without timeout has no deadline and infinite remaining', () => {
    const scope = new Scope();
    expect(scope.deadline).toBeUndefined();
    expect(scope.remaining()).toBe(Infinity);
  });

  test('child deadline is the earliest of its own and the parent one', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const parent = new Scope({ timeout: 1000 });
    const shorter = parent.child({ timeout: 100 });
    const longer = parent.child({ timeout: 5000 });
    const none = parent.child();
    expect(shorter.deadline).toBe(performance.now() + 100);
    expect(longer.deadline).toBe(performance.now() + 1000);
    expect(none.deadline).toBe(performance.now() + 1000);
    vi.useRealTimers();
    parent.abort();
  });
});

describe('isAbort still holds for scope aborts', () => {
  test('sanity', async () => {
    const scope = new Scope();
    const p = scope.spawn(sig => sleep(100, sig));
    scope.abort();
    await expect(p).rejects.toSatisfy(isAbort);
  });
});
