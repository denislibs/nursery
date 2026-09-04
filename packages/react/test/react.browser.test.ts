import { createElement, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import {
  useNurseryEffect,
  useAsync,
  useLatest,
  useEventStream,
  useWorker,
  NurseryProvider,
  useNursery,
} from '../src/index.js';
import { sleep, isAbort } from '@nursery/core/signal';
import { Nursery, contextKey } from '@nursery/core/nursery';
import type { api as EchoApi } from '../../core/test/browser/fixtures/echo.worker.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const render = (node: ReactNode) => act(async () => root.render(node));

describe('useNurseryEffect', () => {
  test('closes the previous nursery when deps change and on unmount', async () => {
    const signals: AbortSignal[] = [];
    function C({ id }: { id: number }) {
      useNurseryEffect(
        nursery => {
          signals.push(nursery.signal);
        },
        [id],
      );
      return null;
    }
    await render(createElement(C, { id: 1 }));
    await render(createElement(C, { id: 2 }));
    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
    await act(async () => root.unmount());
    root = createRoot(container); // afterEach unmounts again; keep it valid
    expect(signals[1]!.aborted).toBe(true);
  });
});

describe('useAsync', () => {
  test('goes loading → success and ignores results of a cancelled run', async () => {
    const states: string[] = [];
    function C({ id }: { id: number }) {
      const s = useAsync(
        async nursery => {
          await sleep(id === 1 ? 50 : 5, nursery.signal);
          return `user-${id}`;
        },
        [id],
      );
      states.push(s.status === 'success' ? s.data : s.status);
      return null;
    }
    await render(createElement(C, { id: 1 }));
    await render(createElement(C, { id: 2 })); // cancels the slow run for id 1
    await act(() => sleep(80));
    expect(states).not.toContain('user-1');
    expect(states.at(-1)).toBe('user-2');
  });
  test('reports non-abort errors', async () => {
    let last: unknown;
    function C() {
      const s = useAsync(async () => {
        throw new Error('boom');
      }, []);
      last = s.status === 'error' ? (s.error as Error).message : s.status;
      return null;
    }
    await render(createElement(C));
    await act(() => sleep(5));
    expect(last).toBe('boom');
  });
});

describe('useLatest', () => {
  test('newer calls cancel older ones and pending tracks in-flight work', async () => {
    const results: string[] = [];
    let api!: ReturnType<typeof useLatest<string, string>>;
    function C() {
      api = useLatest(async (q: string, signal) => {
        await sleep(q === 'a' ? 500 : 150, signal);
        return q;
      });
      return null;
    }
    await render(createElement(C));
    await act(async () => {
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
    });
    expect(api.pending).toBe(true);
    await act(() => sleep(400));
    expect(results).toEqual(['ab']);
    expect(api.pending).toBe(false);
  });
});

describe('useEventStream', () => {
  test('handles DOM events and stops after unmount', async () => {
    const button = document.createElement('button');
    document.body.append(button);
    const seen: string[] = [];
    function C() {
      useEventStream<MouseEvent>(button, 'click', e => {
        seen.push(e.type);
      });
      return null;
    }
    await render(createElement(C));
    button.click();
    await act(() => sleep(5));
    expect(seen).toEqual(['click']);
    await act(async () => root.unmount());
    root = createRoot(container);
    button.click();
    await sleep(5);
    expect(seen).toEqual(['click']);
    button.remove();
  });
});

describe('NurseryProvider / useNursery', () => {
  test('component nurseries are children of the provider nursery and inherit context', async () => {
    const Trace = contextKey<string>('trace');
    let seen: string | undefined;
    let parentNursery: Nursery | undefined;
    function C() {
      const nursery = useNursery();
      seen = nursery.get(Trace);
      return null;
    }
    function P() {
      const [nursery] = useState(() => new Nursery({ name: 'page', ctx: [Trace.with('t-42')] }));
      parentNursery = nursery;
      return createElement(NurseryProvider, { nursery }, createElement(C));
    }
    await render(createElement(P));
    expect(seen).toBe('t-42');
    expect(parentNursery!.children).toHaveLength(1);
    await act(async () => root.unmount());
    root = createRoot(container);
    expect(parentNursery!.children).toHaveLength(0);
  });
});

describe('useWorker', () => {
  test('creates the worker once, exposes the remote api, terminates on unmount', async () => {
    let remote!: ReturnType<typeof useWorker<typeof EchoApi>>;
    const factory = vi.fn(
      () =>
        new Worker(new URL('../../core/test/browser/fixtures/echo.worker.ts', import.meta.url), {
          type: 'module',
        }),
    );
    function C({ tick }: { tick: number }) {
      remote = useWorker<typeof EchoApi>(factory);
      return createElement('span', null, String(tick));
    }
    await render(createElement(C, { tick: 1 }));
    await render(createElement(C, { tick: 2 }));
    expect(factory).toHaveBeenCalledTimes(1);
    await expect(remote.double(4)).resolves.toBe(8);
    await act(async () => root.unmount());
    root = createRoot(container);
    await expect(remote.double(1)).rejects.toThrow(/disposed/);
  });
});
