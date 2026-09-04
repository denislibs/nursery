<script lang="ts">
  import { scopedEffect, useScope, useLatest, eventStream, useWorker } from '../../../src/svelte.js';
  import { sleep } from '../../../src/signal.js';
  import type { Scope } from '../../../src/scope.js';
  import type { api as EchoApi } from './echo.worker.js';

  let { id, onScope, onClick, onRemote }: {
    id: number;
    onScope: (s: Scope) => void;
    onClick: (type: string) => void;
    onRemote: (r: ReturnType<typeof useWorker<typeof EchoApi>>, latest: ReturnType<typeof useLatest<string, string>>) => void;
  } = $props();

  let user = $state<string | null>(null);
  let button = $state<HTMLButtonElement | null>(null);

  const component = useScope({ name: 'component' });
  onScope(component);

  const search = useLatest(async (q: string, sig: AbortSignal) => { await sleep(q === 'a' ? 50 : 5, sig); return q; });
  const remote = useWorker<typeof EchoApi>(() => new Worker(new URL('./echo.worker.ts', import.meta.url), { type: 'module' }));
  onRemote(remote, search);

  $effect(() => scopedEffect(async scope => {
    const current = id;
    onScope(scope);
    await sleep(current === 1 ? 50 : 5, scope.signal);
    user = `user-${current}`;
  }));

  $effect(() => eventStream<MouseEvent>(button, 'click', e => { onClick(e.type); }));
</script>

<button bind:this={button}>{user ?? 'loading'}</button>
