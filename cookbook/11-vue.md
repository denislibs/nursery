# Vue 3

Композаблы поставляются как `@nursery/vue`.

```ts
import { useNursery, useNurseryWatch, useAsync, useLatest, useEventStream, useWorker } from '@nursery/vue';
import { ref, shallowRef, watch } from 'vue';
import { Nursery } from '@nursery/core/nursery';
import { latest } from '@nursery/core/latest';
import { on, Channel } from '@nursery/core/events';
import { pipe, debounce } from '@nursery/core/iter';
```

| Композабл | Что делает |
|---|---|
| `useNursery()` | nursery, который закрывается в `onScopeDispose` |
| `useNurseryWatch(fn)` | `watchEffect` со nursery; перезапуск закрывает предыдущий |
| `useAsync(fn)` | `{ data, error, loading }` как refs, результат отменённого запуска не попадает в refs |
| `useLatest(fn)` | `{ run, pending, cancel }`, `pending` это `Ref<boolean>` |
| `useEventStream(elRef, type, handler)` | события с элемента из `ref`, подписка появляется, когда элемент смонтирован |
| `useWorker(factory)` | воркер на время жизни компонента |

Зависимости `useNurseryWatch` и `useAsync` собираются из синхронной части функции: читайте
`props.id` до первого `await`.

## useNursery: nursery на компонент


```vue
<script setup lang="ts">
const nursery = useNursery();
const user = shallowRef<User | null>(null);

http.get<User>('/me', { signal: nursery.signal }).then(u => (user.value = u)).catch(ignoreAbort);
</script>
```

## useNurseryWatch: перезапуск при изменении зависимостей


Внимание: реактивные зависимости собираются только из синхронной части `effect`. Читайте
`props.id` до первого `await`:

```ts
const props = defineProps<{ id: string }>();
const user = shallowRef<User | null>(null);

useNurseryWatch(async nursery => {
  const id = props.id;                       // синхронно, попадёт в зависимости
  user.value = await http.get<User>(`/users/${id}`, { signal: nursery.signal });
});
```

## useAsync


```vue
<script setup lang="ts">
const props = defineProps<{ userId: string }>();
const { data: orders, loading } = useAsync(nursery =>
  http.get<Order[]>('/orders', { signal: nursery.signal, query: { userId: props.userId } }),
);
</script>
```

## Поиск без гонок


```vue
<script setup lang="ts">
const query = ref('');
const results = shallowRef<Item[]>([]);
const { call: search, pending } = useLatest((q: string, signal) => http.get<Item[]>('/search', { signal, query: { q } }));

watch(query, q => { search(q).then(r => (results.value = r)).catch(ignoreAbort); });
</script>

<template>
  <input v-model="query" />
  <Spinner v-if="pending" />
  <List :items="results" />
</template>
```

Debounce через `iter`, если хочется потоком:

```ts
const nursery = useNursery();
const queries = new Channel<string>(50);
watch(query, q => void queries.send(q));
nursery.spawn(async sig => {
  for await (const q of pipe(queries, debounce(250))) {
    results.value = await search(q).catch(() => results.value);
  }
});
nursery.defer(() => queries.close());
```

## События DOM через on()

```ts
const el = ref<HTMLElement | null>(null);
const nursery = useNursery();

watch(el, (node, _old, onCleanup) => {
  if (!node) return;
  const child = nursery.child();
  onCleanup(() => void child.close());
  child.spawn(async sig => {
    for await (const e of on<PointerEvent>(node, 'pointermove', { signal: sig, buffer: 1 })) draw(e);
  });
});
```

## Pinia store с отменой

Долгоживущие сторы держат корневой nursery, действия порождают дочерние:

```ts
export const useCatalog = defineStore('catalog', () => {
  const nursery = new Nursery();
  const items = shallowRef<Item[]>([]);
  const reload = latest((_: void, signal) => http.get<Item[]>('/items', { signal }));

  async function refresh() {
    items.value = await reload(undefined, nursery.signal);
  }

  function dispose() { void nursery.close(); }
  return { items, refresh, dispose };
});
```

## Воркер


## Nuxt useAsyncData

`useAsyncData` не передаёт сигнал, но даёт `onCancel`? Нет, в текущих версиях нет.
Оборачивайте вручную:

```ts
const { data } = await useAsyncData('user', () =>
  Nursery.run(async nursery => http.get<User>('/me', { signal: nursery.signal }), { timeout: 10_000 }),
);
```

На сервере nursery закроется после `run`, на клиенте тоже. Отмена при уходе со страницы
здесь не сработает, `useAsyncData` её не поддерживает.
