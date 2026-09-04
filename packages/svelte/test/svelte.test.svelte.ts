import { mount, unmount, flushSync } from 'svelte';
import Nursed from './fixtures/Nursed.svelte';
import { sleep, isAbort } from '@nursery/core/signal';
import type { Nursery } from '@nursery/core/nursery';
import type { useLatest, useWorker } from '../src/index.js';
import type { api as EchoApi } from '../../core/test/browser/fixtures/echo.worker.js';

let target: HTMLDivElement;
beforeEach(() => {
  target = document.createElement('div');
  document.body.append(target);
});
afterEach(() => target.remove());

describe('svelte adapter', () => {
  test('component nursery, effect scopes, event stream, latest and worker follow the component lifecycle', async () => {
    const nurseries: Nursery[] = [];
    const clicks: string[] = [];
    let remote!: ReturnType<typeof useWorker<typeof EchoApi>>;
    let search!: ReturnType<typeof useLatest<string, string>>;
    const props = $state({ id: 1 });
    const instance = mount(Nursed, {
      target,
      props: {
        get id() {
          return props.id;
        },
        onNursery: (s: Nursery) => nurseries.push(s),
        onClick: (t: string) => clicks.push(t),
        onRemote: (
          r: ReturnType<typeof useWorker<typeof EchoApi>>,
          l: ReturnType<typeof useLatest<string, string>>,
        ) => {
          remote = r;
          search = l;
        },
      },
    });
    flushSync();
    expect(nurseries.map(s => s.name)).toEqual(['component', expect.any(String)]);
    const [component, effect1] = nurseries as [Nursery, Nursery];

    // effect re-run on prop change closes the previous effect scope
    props.id = 2;
    flushSync();
    await sleep(20);
    expect(nurseries).toHaveLength(3);
    expect(effect1.signal.aborted).toBe(true);
    expect(target.querySelector('button')!.textContent).toBe('user-2');

    // events
    target.querySelector('button')!.click();
    await sleep(5);
    expect(clicks).toEqual(['click']);

    // latest
    const results: string[] = [];
    search
      .run('a')
      .then(r => results.push(r))
      .catch((e: unknown) => {
        if (!isAbort(e)) throw e;
      });
    search
      .run('ab')
      .then(r => results.push(r))
      .catch((e: unknown) => {
        if (!isAbort(e)) throw e;
      });
    await sleep(80);
    expect(results).toEqual(['ab']);

    // worker
    await expect(remote.double(5)).resolves.toBe(10);

    unmount(instance);
    await sleep(5);
    expect(component.signal.aborted).toBe(true);
    expect(nurseries[2]!.signal.aborted).toBe(true);
    await expect(remote.double(1)).rejects.toThrow(/disposed/);
    target.querySelector('button')?.click();
    await sleep(5);
    expect(clicks).toEqual(['click']);
  });
});
