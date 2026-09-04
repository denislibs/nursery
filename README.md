# scopekit

Тонкий слой над нативными `AbortSignal` / `Promise` для браузера: структурная конкурентность,
отмена, таймауты, retry, лимиты и защита от гонок. Без зависимостей, всё принимает и
возвращает платформенные типы.

Правило одно: любая async-функция, которая ждёт сеть или событие, принимает `AbortSignal`.

## Модули

| Модуль | Экспорты |
|---|---|
| `signal` | `isAbort`, `abortError`, `timeoutError`, `throwIfAborted`, `anySignal`, `timeoutSignal`, `sleep` |
| `combine` | `withTimeout`, `retry`, `race`, `settle` |
| `limit` | `Semaphore`, `Mutex`, `map` |
| `latest` | `latest`, `singleFlight` |
| `scope` | `Scope`, `ScopeClosedError` |

## Scope

```ts
import { Scope } from 'scopekit';

// вариант 1: await using (TS 5.2+, esbuild/babel транспилируют)
{
  await using scope = new Scope({ timeout: 5000, ctx: { traceId } });
  const user  = scope.spawn(sig => api.user(id, sig));
  const posts = scope.spawn(sig => api.posts(id, sig));
  render(await user, await posts);
} // выход из блока: всё незавершённое отменено, cleanup выполнен

// вариант 2: Scope.run
const total = await Scope.run(async scope => {
  const a = scope.spawn(sig => fetchA(sig));
  const b = scope.spawn(sig => fetchB(sig));
  return (await a) + (await b);
});
```

Семантика:

- `spawn(task)` даёт задаче `scope.signal`. Первая не-abort ошибка ребёнка отменяет остальных
  с `AbortError`, у которого `cause` равен исходной ошибке. Ошибка лежит в `scope.error`.
- Не дождавшийся ребёнок с ошибкой не создаёт `unhandledrejection`.
- `close()` идемпотентен: отменяет живых детей, ждёт их, затем запускает `defer` в обратном порядке.
- `child()` наследует сигнал и `ctx`, но не отменяет родителя. Родитель при закрытии ждёт детей.
- `ctx` — явная замена AsyncContext, пока его нет в платформе.

## Комбинаторы

```ts
await withTimeout(sig => fetch(url, { signal: sig }), 3000, scope.signal);

await retry(sig => fetch(url, { signal: sig }), {
  retries: 3, delay: 200, factor: 2, jitter: 0.2,
  retryOn: err => !(err instanceof HttpError && err.status < 500),
  signal: scope.signal,
});

const first = await race([sig => fromCache(sig), sig => fromNetwork(sig)]); // проигравший отменён
```

## Лимиты

```ts
const sem = new Semaphore(4);
await sem.run(() => upload(file), scope.signal);

const results = await map(urls, (u, _i, sig) => fetchJson(u, sig), { concurrency: 3, signal: scope.signal });
// порядок сохранён; при первой ошибке остальные отменяются и не стартуют
```

## Гонки и дедупликация

```ts
const search = latest((q: string, sig) => api.search(q, sig));
input.addEventListener('input', () => search(input.value).then(render).catch(ignoreAbort));
// старый запрос отменён, старый ответ никогда не перетрёт новый

const loadUser = singleFlight((id: number) => api.user(id));
loadUser(1); loadUser(1); // один запрос, два ожидающих
```

## Разработка

```bash
npm test
npm run typecheck
```

Компилятор: TypeScript 7 (нативный, на Go). `tsc` из пакета `typescript@7.0.2` — это
платформенный бинарник из `@typescript/typescript-<os>-<arch>`, не JS. Сборка в `dist`:

```bash
npm run build
```
