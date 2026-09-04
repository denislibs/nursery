import { Nursery, NurseryClosedError, contextKey } from '../src/nursery.js';

const TraceId = contextKey<string>('traceId');
const User = contextKey<string>('user');
const Region = contextKey('region', 'eu');
import { isAbort, sleep } from '../src/signal.js';

const tick = () => new Promise<void>(r => setTimeout(r, 0));

describe('Nursery', () => {
  test('spawn passes the nursery signal and abort() cancels children', async () => {
    const nursery = new Nursery();
    const p = nursery.spawn(sig => sleep(1000, sig));
    nursery.abort();
    await expect(p).rejects.toSatisfy(isAbort);
    expect(nursery.signal.aborted).toBe(true);
  });

  test('a failing child aborts its siblings with an AbortError caused by the failure', async () => {
    const nursery = new Nursery();
    const boom = new Error('boom');
    const failing = nursery.spawn(async () => {
      throw boom;
    });
    const sibling = nursery.spawn(sig => sleep(1000, sig));
    await expect(failing).rejects.toBe(boom);
    await expect(sibling).rejects.toSatisfy((e: unknown) => isAbort(e) && (e as Error).cause === boom);
    expect(nursery.error).toBe(boom);
  });

  test('an aborted child does not count as a failure', async () => {
    const nursery = new Nursery();
    const c = new AbortController();
    const p = nursery.spawn(sig =>
      sleep(1000, sig).catch(() => {
        c.abort();
        throw c.signal.reason;
      }),
    );
    c.abort();
    const other = nursery.spawn(async () => 'fine');
    nursery.abort();
    await p.catch(() => {});
    await expect(other).resolves.toBe('fine');
    expect(nursery.error).toBeUndefined();
  });

  test('unawaited failing spawn does not produce an unhandled rejection', async () => {
    const off = Nursery.onUnhandled(() => {}); // reported through the hook, not the platform
    try {
      const nursery = new Nursery();
      nursery.spawn(async () => {
        throw new Error('ignored by caller');
      });
      await nursery.settled();
      expect((nursery.error as Error).message).toBe('ignored by caller');
      await new Promise(r => setTimeout(r, 0));
    } finally {
      off();
    }
  });

  test('await using aborts pending children and waits for them to settle', async () => {
    const log: string[] = [];
    {
      await using nursery = new Nursery();
      nursery.spawn(async sig => {
        try {
          await sleep(1000, sig);
        } finally {
          log.push('child cleanup');
        }
      });
      log.push('leaving block');
    }
    log.push('after block');
    expect(log).toEqual(['leaving block', 'child cleanup', 'after block']);
  });

  test('spawn after close rejects with NurseryClosedError', async () => {
    const nursery = new Nursery();
    await nursery.close();
    await expect(nursery.spawn(async () => 1)).rejects.toBeInstanceOf(NurseryClosedError);
  });

  test('timeout option aborts with TimeoutError and the timer is cleared on close', async () => {
    vi.useFakeTimers();
    const nursery = new Nursery({ timeout: 100 });
    const p = nursery.spawn(sig => sleep(1000, sig));
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).rejects.toSatisfy((e: unknown) => (e as DOMException).name === 'TimeoutError');
    await nursery.close();
    expect(vi.getTimerCount()).toBe(0);

    const fast = new Nursery({ timeout: 100 });
    await fast.close();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  test('links to an external signal', async () => {
    const c = new AbortController();
    const nursery = new Nursery({ signal: c.signal });
    const p = nursery.spawn(sig => sleep(1000, sig));
    c.abort();
    await expect(p).rejects.toSatisfy(isAbort);
  });

  test('child nursery inherits ctx and cancellation from parent, but not the other way round', async () => {
    const parent = new Nursery({ ctx: [TraceId.with('t1'), User.with('u')] });
    const child = parent.child({ ctx: [User.with('override')] });
    expect(child.get(TraceId)).toBe('t1');
    expect(child.get(User)).toBe('override');
    expect(parent.get(User)).toBe('u');

    child.abort();
    expect(parent.signal.aborted).toBe(false);

    const child2 = parent.child();
    parent.abort();
    expect(child2.signal.aborted).toBe(true);
  });

  test('get() falls back to the key default and has() reports explicit bindings only', () => {
    const nursery = new Nursery();
    expect(nursery.get(Region)).toBe('eu');
    expect(nursery.has(Region)).toBe(false);
    expect(nursery.get(TraceId)).toBeUndefined();
    const child = nursery.child({ ctx: [Region.with('us')] });
    expect(child.get(Region)).toBe('us');
    expect(child.has(Region)).toBe(true);
  });

  test('spawned task receives the nursery as second argument', async () => {
    const nursery = new Nursery({ ctx: [TraceId.with('t9')] });
    const result = await nursery.spawn(async (_sig, s) => {
      const inner = await s.spawn(async (_s2, s2) => s2.get(TraceId));
      return `${s.get(TraceId)}/${inner}`;
    });
    expect(result).toBe('t9/t9');
  });

  test('close() unlinks from the parent signal when the manual fallback is used', async () => {
    const native = (AbortSignal as any).any;
    (AbortSignal as any).any = undefined;
    try {
      const parent = new Nursery();
      const spy = vi.spyOn(parent.signal, 'removeEventListener');
      const child = parent.child();
      expect(spy).not.toHaveBeenCalled();
      await child.close();
      expect(spy).toHaveBeenCalledWith('abort', expect.any(Function));
    } finally {
      (AbortSignal as any).any = native;
    }
  });

  test('parent close waits for child nurseries', async () => {
    const log: string[] = [];
    const parent = new Nursery();
    const child = parent.child();
    child.spawn(async sig => {
      try {
        await sleep(1000, sig);
      } finally {
        log.push('grandchild done');
      }
    });
    await parent.close();
    expect(log).toEqual(['grandchild done']);
  });

  test('defer callbacks run on close in reverse order, after children settle', async () => {
    const log: string[] = [];
    const nursery = new Nursery();
    nursery.defer(() => log.push('first registered'));
    nursery.defer(async () => {
      await tick();
      log.push('second registered');
    });
    nursery.spawn(async sig => {
      try {
        await sleep(1000, sig);
      } finally {
        log.push('child');
      }
    });
    await nursery.close();
    expect(log).toEqual(['child', 'second registered', 'first registered']);
  });

  test('Nursery.run returns the body result and closes the nursery afterwards', async () => {
    let captured: Nursery | undefined;
    const result = await Nursery.run(async nursery => {
      captured = nursery;
      const a = nursery.spawn(async () => 1);
      const b = nursery.spawn(async () => 2);
      return (await a) + (await b);
    });
    expect(result).toBe(3);
    expect(captured!.closed).toBe(true);
    expect(captured!.signal.aborted).toBe(true);
  });

  test('Nursery.run rethrows the body error and cancels children', async () => {
    let childAborted = false;
    await expect(
      Nursery.run(async nursery => {
        nursery.spawn(sig =>
          sleep(1000, sig).catch(e => {
            childAborted = isAbort(e);
            throw e;
          }),
        );
        throw new Error('body failed');
      }),
    ).rejects.toThrow('body failed');
    expect(childAborted).toBe(true);
  });

  test('Nursery.run: unawaited child failure surfaces as the run error when the body succeeds', async () => {
    await expect(
      Nursery.run(async nursery => {
        nursery.spawn(async () => {
          throw new Error('child failed');
        });
        return 'ok';
      }),
    ).rejects.toThrow('child failed');
  });
});
