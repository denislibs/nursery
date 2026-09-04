import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue';
import { useScope, useScopedWatch, useAsync, useLatest, useEventStream, useWorker } from '../../src/vue.js';
import { sleep, isAbort } from '../../src/signal.js';
import type { api as EchoApi } from './fixtures/echo.worker.js';

let container: HTMLDivElement;
let app: App | undefined;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(() => {
  app?.unmount();
  app = undefined;
  container.remove();
});
const mount = (component: ReturnType<typeof defineComponent>, props?: Record<string, unknown>) => {
  app = createApp(component, props);
  app.mount(container);
  return app;
};

describe('useScope', () => {
  test('scope closes when the component unmounts', async () => {
    let signal!: AbortSignal;
    mount(
      defineComponent({
        setup() {
          signal = useScope().signal;
          return () => h('div');
        },
      }),
    );
    expect(signal.aborted).toBe(false);
    app!.unmount();
    app = undefined;
    await nextTick();
    expect(signal.aborted).toBe(true);
  });
});

describe('useScopedWatch', () => {
  test('re-runs with a fresh scope when a dependency changes, closing the old one', async () => {
    const id = ref(1);
    const signals: AbortSignal[] = [];
    mount(
      defineComponent({
        setup() {
          useScopedWatch(scope => {
            void id.value;
            signals.push(scope.signal);
          });
          return () => h('div');
        },
      }),
    );
    id.value = 2;
    await nextTick();
    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
  });
});

describe('useAsync', () => {
  test('tracks loading/data and drops results of cancelled runs', async () => {
    const id = ref(1);
    let state!: ReturnType<typeof useAsync<string>>;
    mount(
      defineComponent({
        setup() {
          state = useAsync(async scope => {
            const cur = id.value;
            await sleep(cur === 1 ? 50 : 5, scope.signal);
            return `user-${cur}`;
          });
          return () => h('div');
        },
      }),
    );
    expect(state.loading.value).toBe(true);
    id.value = 2;
    await nextTick();
    await sleep(80);
    expect(state.data.value).toBe('user-2');
    expect(state.loading.value).toBe(false);
    expect(state.error.value).toBeNull();
  });
});

describe('useLatest', () => {
  test('cancels the previous call and exposes pending', async () => {
    let api!: ReturnType<typeof useLatest<string, string>>;
    mount(
      defineComponent({
        setup() {
          api = useLatest(async (q: string, signal) => {
            await sleep(q === 'a' ? 50 : 5, signal);
            return q;
          });
          return () => h('div');
        },
      }),
    );
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
    expect(api.pending.value).toBe(true);
    await sleep(80);
    expect(results).toEqual(['ab']);
    expect(api.pending.value).toBe(false);
  });
});

describe('useEventStream', () => {
  test('subscribes when the element ref is set and stops on unmount', async () => {
    const seen: string[] = [];
    const el = ref<HTMLButtonElement | null>(null);
    mount(
      defineComponent({
        setup() {
          useEventStream<MouseEvent>(el, 'click', e => {
            seen.push(e.type);
          });
          return () => h('button', { ref: el });
        },
      }),
    );
    await nextTick();
    const button = container.querySelector('button')!;
    button.click();
    await sleep(5);
    expect(seen).toEqual(['click']);
    app!.unmount();
    app = undefined;
    button.click();
    await sleep(5);
    expect(seen).toEqual(['click']);
  });
});

describe('useWorker', () => {
  test('exposes the remote api and terminates on unmount', async () => {
    let remote!: ReturnType<typeof useWorker<typeof EchoApi>>;
    mount(
      defineComponent({
        setup() {
          remote = useWorker<typeof EchoApi>(
            () => new Worker(new URL('./fixtures/echo.worker.ts', import.meta.url), { type: 'module' }),
          );
          return () => h('div');
        },
      }),
    );
    await expect(remote.double(21)).resolves.toBe(42);
    app!.unmount();
    app = undefined;
    await expect(remote.double(1)).rejects.toThrow(/disposed/);
  });
});
