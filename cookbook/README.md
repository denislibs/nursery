# scopekit cookbook

Рецепты по использованию scopekit. Каждый файл самодостаточен, но порядок ниже читается
как учебник: от примитивов к фреймворкам.

## Основы

| | Файл | О чём |
|---|---|---|
| 1 | [01-cancellation.md](01-cancellation.md) | `AbortSignal`, `sleep`, `isAbort`, `anySignal`, оборачивание чужих API |
| 2 | [02-scope.md](02-scope.md) | `Scope`: fail-fast, `defer`, дочерние скоупы, контекст через `contextKey` |
| 3 | [03-retry-timeouts.md](03-retry-timeouts.md) | `withTimeout`, `retry`, `attemptTimeout`, `retryOn`, `race`, `settle` |
| 4 | [04-limits.md](04-limits.md) | `map`, `mapSettled`, `Semaphore`, `Mutex`, `Queue`, rate limit |
| 5 | [05-races.md](05-races.md) | `latest`, `singleFlight`, выбор инструмента под гонку |
| 6 | [06-events-streams.md](06-events-streams.md) | `on`, `Channel`, операторы `iter`, drag and drop, WebSocket |
| 7 | [07-main-thread.md](07-main-thread.md) | `chunked`, `yieldToMain`, `idle`, `frame`, измерение long tasks |
| 8 | [08-http.md](08-http.md) | `createHttp`: auth, refresh token, дедупликация, пагинация, прогресс |
| 9 | [09-workers.md](09-workers.md) | `expose`/`wrap`, отмена в воркере, пул, SharedWorker |

## Фреймворки

| | Файл | О чём |
|---|---|---|
| 10 | [10-react.md](10-react.md) | `@scopekit/react`: `useScopedEffect`, `useAsync`, `useLatest`, `ScopeProvider`, Router, TanStack Query, Suspense |
| 11 | [11-vue.md](11-vue.md) | `@scopekit/vue`: `useScope`, `useScopedWatch`, `useAsync`, Pinia, Nuxt |
| 12 | [12-svelte-solid-angular.md](12-svelte-solid-angular.md) | `@scopekit/svelte`, `@scopekit/solid`, `@scopekit/angular`, Web Components, мост в RxJS |

## Практика

| | Файл | О чём |
|---|---|---|
| 13 | [13-testing.md](13-testing.md) | `@scopekit/core/testing`, фейковые таймеры, проверка отмены, http без сети, воркеры в Node |
| 14 | [14-migration.md](14-migration.md) | RxJS, p-*, axios/ky, Comlink, голый AbortController, TanStack Query |
| 15 | [15-antipatterns.md](15-antipatterns.md) | что не делать и почему |
| 16 | [16-observability.md](16-observability.md) | имена задач, `dump()`, `Scope.onUnhandled`, grace, дедлайн |

## Соглашения в примерах

- `http` это клиент из `createHttp`, `scope` это текущий `Scope`, `signal` это `scope.signal`.
- `ignoreAbort` это хелпер из [01-cancellation.md](01-cancellation.md): `err => { if (!isAbort(err)) throw err; }`.
- Импорты указаны в начале каждого файла. Все subpath-экспорты (`@scopekit/core/scope` и т. д.)
  доступны и через корень `@scopekit/core`.
