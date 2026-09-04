import { createRoot, createSignal } from 'solid-js';
import {
  createNursery,
  nurseryEffect,
  createAsync,
  createLatest,
  createEventStream,
  createWorker,
} from '../src/index.js';
import { sleep, isAbort } from '@nursery/core/signal';
import type { api as EchoApi } from '../../core/test/browser/fixtures/echo.worker.js';

describe('solid adapter', () => {
  test('createNursery closes on root disposal', () => {
    let signal!: AbortSignal;
    const dispose = createRoot(d => {
      signal = createNursery().signal;
      return d;
    });
    expect(signal.aborted).toBe(false);
    dispose();
    expect(signal.aborted).toBe(true);
  });

  test('nurseryEffect re-runs with a fresh nursery when a signal changes', async () => {
    const [id, setId] = createSignal(1);
    const signals: AbortSignal[] = [];
    const dispose = createRoot(d => {
      nurseryEffect(nursery => {
        void id();
        signals.push(nursery.signal);
      });
      return d;
    });
    await sleep(0);
    setId(2);
    await sleep(0);
    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
    dispose();
    expect(signals[1]!.aborted).toBe(true);
  });

  test('createAsync tracks state and ignores cancelled runs', async () => {
    const [id, setId] = createSignal(1);
    let state!: ReturnType<typeof createAsync<string>>;
    const dispose = createRoot(d => {
      state = createAsync(async nursery => {
        const cur = id();
        await sleep(cur === 1 ? 50 : 5, nursery.signal);
        return `user-${cur}`;
      });
      return d;
    });
    await sleep(0);
    expect(state.loading()).toBe(true);
    setId(2);
    await sleep(80);
    expect(state.data()).toBe('user-2');
    expect(state.loading()).toBe(false);
    dispose();
  });

  test('createLatest cancels older calls and tracks pending', async () => {
    let api!: ReturnType<typeof createLatest<string, string>>;
    const dispose = createRoot(d => {
      api = createLatest(async (q: string, sig) => {
        await sleep(q === 'a' ? 50 : 5, sig);
        return q;
      });
      return d;
    });
    const results: string[] = [];
    api
      .run('a')
      .then(r => results.push(r))
      .catch((e: unknown) => {
        if (!isAbort(e)) throw e;
      });
    api
      .run('ab')
      .then(r => results.push(r))
      .catch((e: unknown) => {
        if (!isAbort(e)) throw e;
      });
    expect(api.pending()).toBe(true);
    await sleep(80);
    expect(results).toEqual(['ab']);
    expect(api.pending()).toBe(false);
    dispose();
  });

  test('createEventStream listens while the root lives', async () => {
    const button = document.createElement('button');
    document.body.append(button);
    const seen: string[] = [];
    const dispose = createRoot(d => {
      createEventStream<MouseEvent>(button, 'click', e => {
        seen.push(e.type);
      });
      return d;
    });
    button.click();
    await sleep(5);
    expect(seen).toEqual(['click']);
    dispose();
    button.click();
    await sleep(5);
    expect(seen).toEqual(['click']);
    button.remove();
  });

  test('createWorker terminates on disposal', async () => {
    let remote!: ReturnType<typeof createWorker<typeof EchoApi>>;
    const dispose = createRoot(d => {
      remote = createWorker<typeof EchoApi>(
        () =>
          new Worker(new URL('../../core/test/browser/fixtures/echo.worker.ts', import.meta.url), {
            type: 'module',
          }),
      );
      return d;
    });
    await expect(remote.double(2)).resolves.toBe(4);
    dispose();
    await expect(remote.double(1)).rejects.toThrow(/disposed/);
  });
});
