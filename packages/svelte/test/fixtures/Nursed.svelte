<script lang="ts">
  import { nurseryEffect, useNursery, useLatest, eventStream, useWorker } from '../../src/index.js';
  import { sleep } from '@nursery/core/signal';
  import type { Nursery } from '@nursery/core/nursery';
  import type { api as EchoApi } from '../../../core/test/browser/fixtures/echo.worker.js';

  let { id, onNursery, onClick, onRemote }: {
    id: number;
    onNursery: (s: Nursery) => void;
    onClick: (type: string) => void;
    onRemote: (r: ReturnType<typeof useWorker<typeof EchoApi>>, latest: ReturnType<typeof useLatest<string, string>>) => void;
  } = $props();

  let user = $state<string | null>(null);
  let button = $state<HTMLButtonElement | null>(null);

  const component = useNursery({ name: 'component' });
  onNursery(component);

  const search = useLatest(async (q: string, sig: AbortSignal) => { await sleep(q === 'a' ? 50 : 5, sig); return q; });
  const remote = useWorker<typeof EchoApi>(() => new Worker(new URL('../../../core/test/browser/fixtures/echo.worker.ts', import.meta.url), { type: 'module' }));
  onRemote(remote, search);

  $effect(() => nurseryEffect(async nursery => {
    const current = id;
    onNursery(nursery);
    await sleep(current === 1 ? 50 : 5, nursery.signal);
    user = `user-${current}`;
  }));

  $effect(() => eventStream<MouseEvent>(button, 'click', e => { onClick(e.type); }));
</script>

<button bind:this={button}>{user ?? 'loading'}</button>
