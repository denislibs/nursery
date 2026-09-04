# Svelte, SolidJS, Angular, Web Components

Адаптеры поставляются как `scopekit/svelte`, `scopekit/solid` и `scopekit/angular`.
Во всех подход один: скоуп создаётся, когда компонент или эффект стартует, и закрывается в
cleanup. Ниже их использование и то, как они устроены внутри.

```ts
import { useScope, scopedEffect, useLatest, eventStream, useWorker } from 'scopekit/svelte';
import { createScope, scopedEffect, createAsync, createLatest, createEventStream, createWorker } from 'scopekit/solid';
import { injectScope, scopedEffect, injectAsync, injectLatest, injectEventStream, injectWorker } from 'scopekit/angular';
```

Svelte 5: руны это компилятор, поэтому перезапуск остаётся в вашем `$effect`, а `scopedEffect`
и `eventStream` возвращают cleanup:

```svelte
<script lang="ts">
  let { id } = $props();
  let user = $state(null);
  $effect(() => scopedEffect(async scope => { user = await http.get(`/users/${id}`, { scope }); }));
  $effect(() => eventStream(button, 'click', onClick));
</script>
```

Для состояния загрузки есть `asyncStore`: обычный Svelte-store со статусом, `refresh()` для
перезапуска из `$effect` и `scope`, привязанный к компоненту:

```svelte
<script lang="ts">
  const user = asyncStore(scope => http.get(`/users/${id}`, { scope }));
  $effect(() => { void id; user.refresh(); });
</script>
{#if $user.status === 'success'}{$user.data.name}{/if}
```

## Svelte 5 (runes)

```ts
// lib/scope.svelte.ts
import { Scope, type ScopeOptions } from 'scopekit/scope';
import { isAbort } from 'scopekit/signal';

export function scopedEffect(effect: (scope: Scope) => void | Promise<void>, opts?: ScopeOptions) {
  $effect(() => {
    const scope = new Scope(opts);
    Promise.resolve(effect(scope)).catch(err => { if (!isAbort(err)) console.error(err); });
    return () => { void scope.close(); };
  });
}
```

```svelte
<script lang="ts">
  import { scopedEffect } from '$lib/scope.svelte';
  let { id }: { id: string } = $props();
  let user = $state<User | null>(null);

  scopedEffect(async scope => {
    const current = id;                 // читаем синхронно: это зависимость эффекта
    user = await http.get<User>(`/users/${current}`, { signal: scope.signal });
  });
</script>
```

Как и во Vue, зависимости собираются из синхронной части. Смена `id` перезапускает эффект,
предыдущий скоуп закрывается, старый запрос отменяется.

Поиск:

```svelte
<script lang="ts">
  import { latest } from 'scopekit/latest';
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
`onDestroy(() => scope.close())`.

## SolidJS

```ts
import { createSignal, createEffect, onCleanup, createResource } from 'solid-js';
import { Scope } from 'scopekit/scope';

export function createScope(opts?: ScopeOptions) {
  const scope = new Scope(opts);
  onCleanup(() => { void scope.close(); });
  return scope;
}

export function scopedEffect(effect: (scope: Scope) => void | Promise<void>) {
  createEffect(() => {
    const scope = new Scope();
    onCleanup(() => { void scope.close(); });
    Promise.resolve(effect(scope)).catch(err => { if (!isAbort(err)) console.error(err); });
  });
}
```

`createResource` сам передаёт сигнал не везде, но даёт `refetching`; проще всего строить
ресурс поверх `Scope.run`:

```ts
const [id, setId] = createSignal('1');
const [user] = createResource(id, id =>
  Scope.run(scope => http.get<User>(`/users/${id}`, { signal: scope.signal }), { timeout: 10_000 }),
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
scopedEffect(async scope => {
  for await (const e of on<KeyboardEvent>(window, 'keydown', { signal: scope.signal })) {
    if (e.key === 'Escape') setOpen(false);
  }
});
```

## Angular

`DestroyRef` даёт хук на уничтожение, `inject` работает в конструкторе и полях.

```ts
import { DestroyRef, inject, Injectable, signal } from '@angular/core';
import { Scope } from 'scopekit/scope';

export function injectScope(opts?: ScopeOptions): Scope {
  const scope = new Scope(opts);
  inject(DestroyRef).onDestroy(() => { void scope.close(); });
  return scope;
}
```

```ts
@Component({ /* ... */ })
export class UserCardComponent {
  private scope = injectScope();
  user = signal<User | null>(null);
  id = input.required<string>();

  constructor() {
    effect(onCleanup => {
      const child = this.scope.child();
      onCleanup(() => void child.close());
      const id = this.id();
      child.spawn(async sig => this.user.set(await http.get<User>(`/users/${id}`, { signal: sig })));
    });
  }
}
```

Сервис с корневым скоупом:

```ts
@Injectable({ providedIn: 'root' })
export class CatalogService {
  private scope = new Scope();
  private reload = latest((_: void, signal) => http.get<Item[]>('/items', { signal }));
  items = signal<Item[]>([]);

  async refresh() {
    this.items.set(await this.reload(undefined, this.scope.signal));
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
class LiveChart extends HTMLElement {
  #scope?: Scope;

  connectedCallback() {
    const scope = (this.#scope = new Scope());
    scope.spawn(async sig => {
      for await (const tick of pipe(on<MessageEvent>(ws, 'message', { signal: sig }), throttle(100))) {
        this.draw(JSON.parse(tick.data));
      }
    });
    scope.spawn(async sig => {
      const history = await http.get<Point[]>('/history', { signal: sig });
      this.draw(history);
    });
  }

  disconnectedCallback() {
    void this.#scope?.close();
  }
}
```

Без фреймворка тоже нет флагов и ручного `removeEventListener`: `disconnectedCallback`
закрывает скоуп, скоуп закрывает всё остальное.

## Общая таблица

| Фреймворк | Где создать скоуп | Где закрыть |
|---|---|---|
| React | `useEffect` | cleanup эффекта |
| Vue | `watchEffect` / setup | `onCleanup` / `onScopeDispose` |
| Svelte 5 | `$effect` | возвращаемая функция |
| Solid | `createEffect` / setup | `onCleanup` |
| Angular | конструктор / `effect` | `DestroyRef.onDestroy` / `onCleanup` |
| Web Components | `connectedCallback` | `disconnectedCallback` |
