<script lang="ts">
  import { asyncStore } from '../../../src/svelte.js';
  import { sleep } from '../../../src/signal.js';

  let { id, onStore }: { id: number; onStore: (s: ReturnType<typeof asyncStore<string>>) => void } = $props();

  const user = asyncStore(async scope => { await sleep(id === 1 ? 50 : 5, scope.signal); return `user-${id}`; });
  onStore(user);
  $effect(() => { void id; user.refresh(); });
</script>

<p>{$user.status === 'success' ? $user.data : $user.status}</p>
