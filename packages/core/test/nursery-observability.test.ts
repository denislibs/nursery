import { Nursery, NurseryStuckError } from '../src/nursery.js';
import { isAbort, sleep } from '../src/signal.js';

const tick = () => new Promise<void>(r => setTimeout(r, 0));
let reports: Array<{ error: unknown; nursery: Nursery; task?: { name: string } }> = [];
let unsubscribe: () => void;

beforeEach(() => {
  reports = [];
  unsubscribe = Nursery.onUnhandled((error, ctx) =>
    reports.push({ error, nursery: ctx.nursery, task: ctx.task }),
  );
});
afterEach(() => unsubscribe());

describe('task names and introspection', () => {
  test('spawn accepts a name; running tasks are listed with elapsed time', async () => {
    const nursery = new Nursery({ name: 'page' });
    const p = nursery.spawn(sig => sleep(50, sig), { name: 'loadUser' });
    expect(nursery.name).toBe('page');
    expect(nursery.tasks.map(t => t.name)).toEqual(['loadUser']);
    expect(nursery.tasks[0]!.elapsed).toBeGreaterThanOrEqual(0);
    await p;
    expect(nursery.tasks).toEqual([]);
  });

  test('unnamed tasks get a fallback name', () => {
    const nursery = new Nursery();
    nursery.spawn(sig => sleep(10, sig));
    expect(nursery.tasks[0]!.name).toBe('task#1');
    nursery.abort();
  });

  test('children are listed and removed when closed', async () => {
    const parent = new Nursery({ name: 'root' });
    const child = parent.child({ name: 'widget' });
    expect(parent.children.map(c => c.name)).toEqual(['widget']);
    await child.close();
    expect(parent.children).toEqual([]);
  });

  test('inspect() returns the tree and dump() renders it', async () => {
    const root = new Nursery({ name: 'root' });
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
  test('reports a failed task nobody awaited, with nursery and task info', async () => {
    const nursery = new Nursery({ name: 's' });
    nursery.spawn(
      async () => {
        throw new Error('lost');
      },
      { name: 'bg' },
    );
    await tick();
    await tick();
    expect(reports).toHaveLength(1);
    expect((reports[0]!.error as Error).message).toBe('lost');
    expect(reports[0]!.nursery).toBe(nursery);
    expect(reports[0]!.task?.name).toBe('bg');
  });

  test('does not report a failure the caller awaited', async () => {
    const nursery = new Nursery();
    await expect(
      nursery.spawn(async () => {
        throw new Error('seen');
      }),
    ).rejects.toThrow('seen');
    await tick();
    expect(reports).toEqual([]);
  });

  test('does not report a failure the caller handled with catch', async () => {
    const nursery = new Nursery();
    nursery
      .spawn(async () => {
        throw new Error('caught');
      })
      .catch(() => {});
    await tick();
    await tick();
    expect(reports).toEqual([]);
  });

  test('does not report aborts', async () => {
    const nursery = new Nursery();
    nursery.spawn(sig => sleep(1000, sig));
    nursery.abort();
    await tick();
    await tick();
    expect(reports).toEqual([]);
  });

  test('does not report the error that Nursery.run surfaces', async () => {
    await expect(
      Nursery.run(async nursery => {
        nursery.spawn(async () => {
          throw new Error('surfaced');
        });
        await sleep(5);
        return 'unreachable';
      }),
    ).rejects.toThrow('surfaced');
    await tick();
    expect(reports).toEqual([]);
  });

  test('unsubscribe stops delivery', async () => {
    unsubscribe();
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {}); // default sink, expected here
    const nursery = new Nursery();
    nursery.spawn(async () => {
      throw new Error('silent');
    });
    await tick();
    await tick();
    expect(reports).toEqual([]);
    quiet.mockRestore();
  });
});

describe('Nursery.run error precedence', () => {
  test('when the body dies of a sibling abort, run throws the original sibling error', async () => {
    await expect(
      Nursery.run(async nursery => {
        nursery.spawn(async () => {
          throw new Error('root cause');
        });
        await nursery.spawn(sig => sleep(1000, sig)); // will be aborted by the sibling failure
      }),
    ).rejects.toThrow('root cause');
  });
});

describe('close with grace', () => {
  test('a task that ignores the signal blocks close() without grace', async () => {
    const nursery = new Nursery();
    nursery.spawn(() => new Promise(() => {}), { name: 'stubborn' });
    const closed = nursery.close().then(() => 'closed');
    await expect(Promise.race([closed, sleep(30).then(() => 'still waiting')])).resolves.toBe(
      'still waiting',
    );
  });

  test('close({ grace }) resolves after the grace period and reports stuck tasks', async () => {
    const nursery = new Nursery({ name: 'leaky' });
    nursery.spawn(() => new Promise(() => {}), { name: 'stubborn' });
    nursery.spawn(sig => sleep(1, sig), { name: 'polite' });
    let cleaned = false;
    nursery.defer(() => {
      cleaned = true;
    });

    await nursery.close({ grace: 20 });

    expect(cleaned).toBe(true);
    expect(reports).toHaveLength(1);
    const err = reports[0]!.error as NurseryStuckError;
    expect(err).toBeInstanceOf(NurseryStuckError);
    expect(err.tasks.map(t => t.name)).toEqual(['stubborn']);
    expect(err.message).toContain('stubborn');
    expect(reports[0]!.nursery).toBe(nursery);
  });

  test('grace can be set as a nursery default and is used by await using', async () => {
    {
      await using nursery = new Nursery({ grace: 20 });
      nursery.spawn(() => new Promise(() => {}), { name: 'stubborn' });
    }
    expect(reports.map(r => (r.error as Error).name)).toEqual(['NurseryStuckError']);
  });

  test('a stuck child nursery is reported through the parent close', async () => {
    const parent = new Nursery({ name: 'parent', grace: 20 });
    const child = parent.child({ name: 'child' });
    child.spawn(() => new Promise(() => {}), { name: 'stubborn' });
    await parent.close();
    expect(reports).toHaveLength(1);
    expect((reports[0]!.error as NurseryStuckError).tasks[0]!.name).toBe('stubborn');
  });
});

describe('deadline', () => {
  test('a nursery with timeout exposes an absolute deadline and remaining()', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const nursery = new Nursery({ timeout: 1000 });
    expect(nursery.deadline).toBe(performance.now() + 1000);
    vi.advanceTimersByTime(300);
    expect(nursery.remaining()).toBe(700);
    vi.useRealTimers();
    nursery.abort();
  });

  test('a nursery without timeout has no deadline and infinite remaining', () => {
    const nursery = new Nursery();
    expect(nursery.deadline).toBeUndefined();
    expect(nursery.remaining()).toBe(Infinity);
  });

  test('child deadline is the earliest of its own and the parent one', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const parent = new Nursery({ timeout: 1000 });
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

describe('isAbort still holds for nursery aborts', () => {
  test('sanity', async () => {
    const nursery = new Nursery();
    const p = nursery.spawn(sig => sleep(100, sig));
    nursery.abort();
    await expect(p).rejects.toSatisfy(isAbort);
  });
});
