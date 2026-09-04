# Svelte, SolidJS, Angular, Web Components

Адаптеры поставляются как `@nursery/svelte`, `@nursery/solid` и `@nursery/angular`.
Во всех подход один: nursery создаётся, когда компонент или эффект стартует, и закрывается в
cleanup.

Svelte 5: руны это компилятор, поэтому перезапуск остаётся в вашем `$effect`, а `nurseryEffect`
и `eventStream` возвращают cleanup:

```svelte
<script lang="ts">
  let { id } = $props();
  let user = $state(null);
  $effect(() => nurseryEffect(async nursery => { user = await http.get(`/users/${id}`, { nursery }); }));
  $effect(() => eventStream(button, 'click', onClick));
</script>
```

Для состояния загрузки есть `asyncStore`: обычный Svelte-store со статусом, `refresh()` для
перезапуска из `$effect` и `nursery`, привязанный к компоненту:

```svelte
<script lang="ts">
  const user = asyncStore(nursery => http.get(`/users/${id}`, { nursery }));
  $effect(() => { void id; user.refresh(); });
</script>
{#if $user.status === 'success'}{$user.data.name}{/if}
```

## Svelte 5 (runes)

```ts
import { useNursery, nurseryEffect, asyncStore, useLatest, eventStream, useWorker } from '@nursery/svelte';
```


```svelte
<script lang="ts">
  import { nurseryEffect } from '$lib/nursery.svelte';
  let { id }: { id: string } = $props();
  let user = $state<User | null>(null);

  nurseryEffect(async nursery => {
    const current = id;                 // читаем синхронно: это зависимость эффекта
    user = await http.get<User>(`/users/${current}`, { signal: nursery.signal });
  });
</script>
```

Как и во Vue, зависимости собираются из синхронной части. Смена `id` перезапускает эффект,
предыдущий nursery закрывается, старый запрос отменяется.

Поиск:

```svelte
<script lang="ts">
  import { latest } from '@nursery/core/latest';
  let query = $state('');
  let results = $state<Item[]>([]);
  const search = latest((q: string, signal) => http.get<Item[]>('/search', { signal, query: { q } }));

  $effect(() => {
    const q = query;
    search(q).then(r => (results = r)).catch(ignoreAbort);
    return () => search.cancel();
  });
</script>
```

Svelte 4 со сторами: та же логика в `onMount`, возвращающем cleanup, и
`onDestroy(() => nursery.close())`.

## SolidJS

```ts
import { createNursery, nurseryEffect, createAsync, createLatest, createEventStream, createWorker } from '@nursery/solid';
import { createSignal, createResource, onCleanup } from 'solid-js';
import { latest } from '@nursery/core/latest';
import { on } from '@nursery/core/events';
```


`createResource` сам передаёт сигнал не везде, но даёт `refetching`; проще всего строить
ресурс поверх `Nursery.run`:

```ts
const [id, setId] = createSignal('1');
const [user] = createResource(id, id =>
  Nursery.run(nursery => http.get<User>(`/users/${id}`, { signal: nursery.signal }), { timeout: 10_000 }),
);
```

Отмена предыдущего запроса при смене `id`:

```ts
const load = latest((id: string, signal) => http.get<User>(`/users/${id}`, { signal }));
const [user] = createResource(id, id => load(id));
onCleanup(() => load.cancel());
```

События:

```ts
nurseryEffect(async nursery => {
  for await (const e of on<KeyboardEvent>(window, 'keydown', { signal: nursery.signal })) {
    if (e.key === 'Escape') setOpen(false);
  }
});
```

## Angular

```ts
import { injectNursery, nurseryEffect, injectAsync, injectLatest, injectEventStream, injectWorker } from '@nursery/angular';
import { Component, Injectable, effect, input, signal } from '@angular/core';
import { latest } from '@nursery/core/latest';
import { on } from '@nursery/core/events';
import { isAbort } from '@nursery/core/signal';
```

`DestroyRef` даёт хук на уничтожение, `inject` работает в конструкторе и полях.


```ts
@Component({ /* ... */ })
export class UserCardComponent {
  private nursery = injectNursery();
  user = signal<User | null>(null);
  id = input.required<string>();

  constructor() {
    effect(onCleanup => {
      const child = this.nursery.child();
      onCleanup(() => void child.close());
      const id = this.id();
      child.spawn(async sig => this.user.set(await http.get<User>(`/users/${id}`, { signal: sig })));
    });
  }
}
```

Сервис с корневым nursery:

```ts
@Injectable({ providedIn: 'root' })
export class CatalogService {
  private nursery = new Nursery();
  private reload = latest((_: void, signal) => http.get<Item[]>('/items', { signal }));
  items = signal<Item[]>([]);

  async refresh() {
    this.items.set(await this.reload(undefined, this.nursery.signal));
  }
}
```

Мост в RxJS, если нужен `Observable`:

```ts
import { Observable } from 'rxjs';

export function fromAsyncIterable<T>(make: (signal: AbortSignal) => AsyncIterable<T>): Observable<T> {
  return new Observable<T>(sub => {
    const ctrl = new AbortController();
    (async () => {
      try {
        for await (const v of make(ctrl.signal)) sub.next(v);
        sub.complete();
      } catch (err) {
        if (!isAbort(err)) sub.error(err);
      }
    })();
    return () => ctrl.abort();
  });
}

const keys$ = fromAsyncIterable(sig => on<KeyboardEvent>(window, 'keydown', { signal: sig }));
```

## Web Components / vanilla

```ts
import { Nursery } from '@nursery/core/nursery';
import { on } from '@nursery/core/events';
import { pipe, throttle } from '@nursery/core/iter';
```

```ts
class LiveChart extends HTMLElement {
  #nursery?: Nursery;

  connectedCallback() {
    const nursery = (this.#nursery = new Nursery());
    nursery.spawn(async sig => {
      for await (const tick of pipe(on<MessageEvent>(ws, 'message', { signal: sig }), throttle(100))) {
        this.draw(JSON.parse(tick.data));
      }
    });
    nursery.spawn(async sig => {
      const history = await http.get<Point[]>('/history', { signal: sig });
      this.draw(history);
    });
  }

  disconnectedCallback() {
    void this.#nursery?.close();
  }

  draw(points: unknown) {
    /* ... */
  }
}
```

Без фреймворка тоже нет флагов и ручного `removeEventListener`: `disconnectedCallback`
закрывает nursery, nursery закрывает всё остальное.

## Общая таблица

| Фреймворк | Где создать nursery | Где закрыть |
|---|---|---|
| React | `useEffect` | cleanup эффекта |
| Vue | `watchEffect` / setup | `onCleanup` / `onScopeDispose` |
| Svelte 5 | `$effect` | возвращаемая функция |
| Solid | `createEffect` / setup | `onCleanup` |
| Angular | конструктор / `effect` | `DestroyRef.onDestroy` / `onCleanup` |
| Web Components | `connectedCallback` | `disconnectedCallback` |
