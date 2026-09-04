import { Scope, ScopeClosedError, contextKey } from '../src/scope.js';

const TraceId = contextKey<string>('traceId');
const User = contextKey<string>('user');
const Region = contextKey('region', 'eu');
import { isAbort, sleep } from '../src/signal.js';

const tick = () => new Promise<void>(r => setTimeout(r, 0));

describe('Scope', () => {
  test('spawn passes the scope signal and abort() cancels children', async () => {
    const scope = new Scope();
    const p = scope.spawn(sig => sleep(1000, sig));
    scope.abort();
    await expect(p).rejects.toSatisfy(isAbort);
    expect(scope.signal.aborted).toBe(true);
  });

  test('a failing child aborts its siblings with an AbortError caused by the failure', async () => {
    const scope = new Scope();
    const boom = new Error('boom');
    const failing = scope.spawn(async () => { throw boom; });
    const sibling = scope.spawn(sig => sleep(1000, sig));
    await expect(failing).rejects.toBe(boom);
    await expect(sibling).rejects.toSatisfy((e: unknown) => isAbort(e) && (e as Error).cause === boom);
    expect(scope.error).toBe(boom);
  });

  test('an aborted child does not count as a failure', async () => {
    const scope = new Scope();
    const c = new AbortController();
    const p = scope.spawn(sig => sleep(1000, sig).catch(() => { c.abort(); throw c.signal.reason; }));
    c.abort();
    const other = scope.spawn(async () => 'fine');
    scope.abort();
    await p.catch(() => {});
    await expect(other).resolves.toBe('fine');
    expect(scope.error).toBeUndefined();
  });

  test('unawaited failing spawn does not produce an unhandled rejection', async () => {
    const scope = new Scope();
    scope.spawn(async () => { throw new Error('ignored by caller'); });
    await scope.settled();
    expect((scope.error as Error).message).toBe('ignored by caller');
  });

  test('await using aborts pending children and waits for them to settle', async () => {
    const log: string[] = [];
    {
      await using scope = new Scope();
      scope.spawn(async sig => {
        try { await sleep(1000, sig); } finally { log.push('child cleanup'); }
      });
      log.push('leaving block');
    }
    log.push('after block');
    expect(log).toEqual(['leaving block', 'child cleanup', 'after block']);
  });

  test('spawn after close rejects with ScopeClosedError', async () => {
    const scope = new Scope();
    await scope.close();
    await expect(scope.spawn(async () => 1)).rejects.toBeInstanceOf(ScopeClosedError);
  });

  test('timeout option aborts with TimeoutError and the timer is cleared on close', async () => {
    vi.useFakeTimers();
    const scope = new Scope({ timeout: 100 });
    const p = scope.spawn(sig => sleep(1000, sig));
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).rejects.toSatisfy((e: unknown) => (e as DOMException).name === 'TimeoutError');
    await scope.close();
    expect(vi.getTimerCount()).toBe(0);

    const fast = new Scope({ timeout: 100 });
    await fast.close();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  test('links to an external signal', async () => {
    const c = new AbortController();
    const scope = new Scope({ signal: c.signal });
    const p = scope.spawn(sig => sleep(1000, sig));
    c.abort();
    await expect(p).rejects.toSatisfy(isAbort);
  });

  test('child scope inherits ctx and cancellation from parent, but not the other way round', async () => {
    const parent = new Scope({ ctx: [TraceId.with('t1'), User.with('u')] });
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
    const scope = new Scope();
    expect(scope.get(Region)).toBe('eu');
    expect(scope.has(Region)).toBe(false);
    expect(scope.get(TraceId)).toBeUndefined();
    const child = scope.child({ ctx: [Region.with('us')] });
    expect(child.get(Region)).toBe('us');
    expect(child.has(Region)).toBe(true);
  });

  test('spawned task receives the scope as second argument', async () => {
    const scope = new Scope({ ctx: [TraceId.with('t9')] });
    const result = await scope.spawn(async (_sig, s) => {
      const inner = await s.spawn(async (_s2, s2) => s2.get(TraceId));
      return `${s.get(TraceId)}/${inner}`;
    });
    expect(result).toBe('t9/t9');
  });

  test('close() unlinks from the parent signal when the manual fallback is used', async () => {
    const native = (AbortSignal as any).any;
    (AbortSignal as any).any = undefined;
    try {
      const parent = new Scope();
      const spy = vi.spyOn(parent.signal, 'removeEventListener');
      const child = parent.child();
      expect(spy).not.toHaveBeenCalled();
      await child.close();
      expect(spy).toHaveBeenCalledWith('abort', expect.any(Function));
    } finally {
      (AbortSignal as any).any = native;
    }
  });

  test('parent close waits for child scopes', async () => {
    const log: string[] = [];
    const parent = new Scope();
    const child = parent.child();
    child.spawn(async sig => { try { await sleep(1000, sig); } finally { log.push('grandchild done'); } });
    await parent.close();
    expect(log).toEqual(['grandchild done']);
  });

  test('defer callbacks run on close in reverse order, after children settle', async () => {
    const log: string[] = [];
    const scope = new Scope();
    scope.defer(() => log.push('first registered'));
    scope.defer(async () => { await tick(); log.push('second registered'); });
    scope.spawn(async sig => { try { await sleep(1000, sig); } finally { log.push('child'); } });
    await scope.close();
    expect(log).toEqual(['child', 'second registered', 'first registered']);
  });

  test('Scope.run returns the body result and closes the scope afterwards', async () => {
    let captured: Scope | undefined;
    const result = await Scope.run(async scope => {
      captured = scope;
      const a = scope.spawn(async () => 1);
      const b = scope.spawn(async () => 2);
      return (await a) + (await b);
    });
    expect(result).toBe(3);
    expect(captured!.closed).toBe(true);
    expect(captured!.signal.aborted).toBe(true);
  });

  test('Scope.run rethrows the body error and cancels children', async () => {
    let childAborted = false;
    await expect(Scope.run(async scope => {
      scope.spawn(sig => sleep(1000, sig).catch(e => { childAborted = isAbort(e); throw e; }));
      throw new Error('body failed');
    })).rejects.toThrow('body failed');
    expect(childAborted).toBe(true);
  });

  test('Scope.run: unawaited child failure surfaces as the run error when the body succeeds', async () => {
    await expect(Scope.run(async scope => {
      scope.spawn(async () => { throw new Error('child failed'); });
      return 'ok';
    })).rejects.toThrow('child failed');
  });
});
