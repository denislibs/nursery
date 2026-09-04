import { createElement, StrictMode, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { useNursery, useNurseryEffect, useWorker, NurseryProvider } from '../src/index.js';
import { Nursery } from '@nursery/core/nursery';
import { sleep } from '@nursery/core/signal';
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
const render = (node: Parameters<Root['render']>[0]) =>
  act(async () => root.render(createElement(StrictMode, null, node)));

describe('React StrictMode', () => {
  test('useNursery under a provider leaves exactly one tracked child after mount and none after unmount', async () => {
    const page = new Nursery({ name: 'page' });
    let seen: Nursery | undefined;
    function C() {
      seen = useNursery();
      return null;
    }
    await render(createElement(NurseryProvider, { nursery: page }, createElement(C)));
    expect(page.children).toHaveLength(1);
    expect(seen!.closed).toBe(false);
    expect(page.children[0]).toBe(seen);
    await act(async () => root.unmount());
    root = createRoot(container);
    expect(page.children).toHaveLength(0);
    await page.close();
  });

  test('useNurseryEffect runs the effect body for the surviving nursery only once', async () => {
    const runs: AbortSignal[] = [];
    function C() {
      useNurseryEffect(nursery => {
        runs.push(nursery.signal);
      }, []);
      return null;
    }
    await render(createElement(C));
    await sleep(5);
    const alive = runs.filter(s => !s.aborted);
    expect(alive).toHaveLength(1);
  });

  test('useWorker keeps a working remote across the simulated remount and terminates on unmount', async () => {
    let remote!: ReturnType<typeof useWorker<typeof EchoApi>>;
    const factory = vi.fn(
      () =>
        new Worker(new URL('../../core/test/browser/fixtures/echo.worker.ts', import.meta.url), {
          type: 'module',
        }),
    );
    function C() {
      remote = useWorker<typeof EchoApi>(factory);
      return null;
    }
    await render(createElement(C));
    await expect(remote.double(3)).resolves.toBe(6);
    expect(factory.mock.calls.length).toBeLessThanOrEqual(2);
    await act(async () => root.unmount());
    root = createRoot(container);
    await expect(remote.double(1)).rejects.toThrow(/disposed/);
  });

  test('state updates from a scoped effect survive StrictMode double effects', async () => {
    let rendered = '';
    function C() {
      const [v, setV] = useState('init');
      useNurseryEffect(async nursery => {
        await sleep(5, nursery.signal);
        setV('loaded');
      }, []);
      rendered = v;
      return null;
    }
    await render(createElement(C));
    await act(() => sleep(20));
    expect(rendered).toBe('loaded');
  });
});
