import { mount, unmount, flushSync } from 'svelte';
import { get } from 'svelte/store';
import AsyncStore from './fixtures/AsyncStore.svelte';
import { sleep } from '@scopekit/core/signal';
import type { asyncStore } from '../src/index.js';

let target: HTMLDivElement;
beforeEach(() => {
  target = document.createElement('div');
  document.body.append(target);
});
afterEach(() => target.remove());

describe('svelte asyncStore', () => {
  test('exposes status/data, cancels a stale run on refresh, closes on unmount', async () => {
    let store!: ReturnType<typeof asyncStore<string>>;
    const props = $state({ id: 1 });
    const instance = mount(AsyncStore, {
      target,
      props: {
        get id() {
          return props.id;
        },
        onStore: (s: ReturnType<typeof asyncStore<string>>) => (store = s),
      },
    });
    flushSync();
    expect(get(store).status).toBe('loading');
    props.id = 2;
    flushSync();
    await sleep(80);
    expect(get(store)).toEqual({ status: 'success', data: 'user-2' });
    expect(target.querySelector('p')!.textContent).toBe('user-2');
    unmount(instance);
    await sleep(5);
    expect(store.scope.closed).toBe(true);
  });
});
