import { createElement, StrictMode, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { useScope, useScopedEffect, useWorker, ScopeProvider } from '../../src/react.js';
import { Scope } from '../../src/scope.js';
import { sleep } from '../../src/signal.js';
import type { api as EchoApi } from './fixtures/echo.worker.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const render = (node: Parameters<Root['render']>[0]) => act(async () => root.render(createElement(StrictMode, null, node)));

describe('React StrictMode', () => {
  test('useScope under a provider leaves exactly one tracked child after mount and none after unmount', async () => {
    const page = new Scope({ name: 'page' });
    let seen: Scope | undefined;
    function C() { seen = useScope(); return null; }
    await render(createElement(ScopeProvider, { scope: page }, createElement(C)));
    expect(page.children).toHaveLength(1);
    expect(seen!.closed).toBe(false);
    expect(page.children[0]).toBe(seen);
    await act(async () => root.unmount());
    root = createRoot(container);
    expect(page.children).toHaveLength(0);
    await page.close();
  });

  test('useScopedEffect runs the effect body for the surviving scope only once', async () => {
    const runs: AbortSignal[] = [];
    function C() { useScopedEffect(scope => { runs.push(scope.signal); }, []); return null; }
    await render(createElement(C));
    await sleep(5);
    const alive = runs.filter(s => !s.aborted);
    expect(alive).toHaveLength(1);
  });

  test('useWorker keeps a working remote across the simulated remount and terminates on unmount', async () => {
    let remote!: ReturnType<typeof useWorker<typeof EchoApi>>;
    const factory = vi.fn(() => new Worker(new URL('./fixtures/echo.worker.ts', import.meta.url), { type: 'module' }));
    function C() { remote = useWorker<typeof EchoApi>(factory); return null; }
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
      useScopedEffect(async scope => { await sleep(5, scope.signal); setV('loaded'); }, []);
      rendered = v;
      return null;
    }
    await render(createElement(C));
    await act(() => sleep(20));
    expect(rendered).toBe('loaded');
  });
});
