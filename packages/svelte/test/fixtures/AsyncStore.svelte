<script lang="ts">
  import { asyncStore } from '../../src/index.js';
  import { sleep } from '@nursery/core/signal';

  let { id, onStore }: { id: number; onStore: (s: ReturnType<typeof asyncStore<string>>) => void } = $props();

  const user = asyncStore(async nursery => { await sleep(id === 1 ? 50 : 5, nursery.signal); return `user-${id}`; });
  onStore(user);
  $effect(() => { void id; user.refresh(); });
</script>

<p>{$user.status === 'success' ? $user.data : $user.status}</p>
