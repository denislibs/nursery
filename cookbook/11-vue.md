# Vue 3

Композаблы поставляются как `@scopekit/vue`.

```ts
import { useScope, useScopedWatch, useAsync, useLatest, useEventStream, useWorker } from '@scopekit/vue';
import { ref, shallowRef, watch } from 'vue';
import { Scope } from '@scopekit/core/scope';
import { latest } from '@scopekit/core/latest';
import { on, Channel } from '@scopekit/core/events';
import { pipe, debounce } from '@scopekit/core/iter';
```

| Композабл | Что делает |
|---|---|
| `useScope()` | скоуп, который закрывается в `onScopeDispose` |
| `useScopedWatch(fn)` | `watchEffect` со скоупом; перезапуск закрывает предыдущий |
| `useAsync(fn)` | `{ data, error, loading }` как refs, результат отменённого запуска не попадает в refs |
| `useLatest(fn)` | `{ run, pending, cancel }`, `pending` это `Ref<boolean>` |
| `useEventStream(elRef, type, handler)` | события с элемента из `ref`, подписка появляется, когда элемент смонтирован |
| `useWorker(factory)` | воркер на время жизни компонента |

Зависимости `useScopedWatch` и `useAsync` собираются из синхронной части функции: читайте
`props.id` до первого `await`.

## useScope: скоуп на компонент


```vue
<script setup lang="ts">
const scope = useScope();
const user = shallowRef<User | null>(null);

http.get<User>('/me', { signal: scope.signal }).then(u => (user.value = u)).catch(ignoreAbort);
</script>
```

## useScopedWatch: перезапуск при изменении зависимостей


Внимание: реактивные зависимости собираются только из синхронной части `effect`. Читайте
`props.id` до первого `await`:

```ts
const props = defineProps<{ id: string }>();
const user = shallowRef<User | null>(null);

useScopedWatch(async scope => {
  const id = props.id;                       // синхронно, попадёт в зависимости
  user.value = await http.get<User>(`/users/${id}`, { signal: scope.signal });
});
```

## useAsync


```vue
<script setup lang="ts">
const props = defineProps<{ userId: string }>();
const { data: orders, loading } = useAsync(scope =>
  http.get<Order[]>('/orders', { signal: scope.signal, query: { userId: props.userId } }),
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
const scope = useScope();
const queries = new Channel<string>(50);
watch(query, q => void queries.send(q));
scope.spawn(async sig => {
  for await (const q of pipe(queries, debounce(250))) {
    results.value = await search(q).catch(() => results.value);
  }
});
scope.defer(() => queries.close());
```

## События DOM через on()

```ts
const el = ref<HTMLElement | null>(null);
const scope = useScope();

watch(el, (node, _old, onCleanup) => {
  if (!node) return;
  const child = scope.child();
  onCleanup(() => void child.close());
  child.spawn(async sig => {
    for await (const e of on<PointerEvent>(node, 'pointermove', { signal: sig, buffer: 1 })) draw(e);
  });
});
```

## Pinia store с отменой

Долгоживущие сторы держат корневой скоуп, действия порождают дочерние:

```ts
export const useCatalog = defineStore('catalog', () => {
  const scope = new Scope();
  const items = shallowRef<Item[]>([]);
  const reload = latest((_: void, signal) => http.get<Item[]>('/items', { signal }));

  async function refresh() {
    items.value = await reload(undefined, scope.signal);
  }

  function dispose() { void scope.close(); }
  return { items, refresh, dispose };
});
```

## Воркер


## Nuxt useAsyncData

`useAsyncData` не передаёт сигнал, но даёт `onCancel`? Нет, в текущих версиях нет.
Оборачивайте вручную:

```ts
const { data } = await useAsyncData('user', () =>
  Scope.run(async scope => http.get<User>('/me', { signal: scope.signal }), { timeout: 10_000 }),
);
```

На сервере скоуп закроется после `run`, на клиенте тоже. Отмена при уходе со страницы
здесь не сработает, `useAsyncData` её не поддерживает.
