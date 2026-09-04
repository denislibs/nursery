# Retry и таймауты

```ts
import { withTimeout, retry, race } from 'scopekit/combine';
```

## Таймаут на операцию

```ts
const user = await withTimeout(sig => api.user(id, sig), 5000, scope.signal);
```

Внутри создаётся сигнал, который абортится через 5 секунд `TimeoutError` **или** когда
абортится `scope.signal`. Таймер очищается при любом исходе. `withTimeout` не «забывает»
задачу: она реально получает abort, а не продолжает крутиться в фоне.

## Retry с экспоненциальным backoff

```ts
const data = await retry(sig => api.report(sig), {
  retries: 3,        // до 4 попыток всего
  delay: 200,        // 200, 400, 800 мс
  factor: 2,
  jitter: 0.2,       // ±20 %, чтобы клиенты не били в сервер синхронно
  maxDelay: 5000,
  signal: scope.signal,
});
```

Правила по умолчанию:

- Отмена извне не ретраится никогда. Если `scope.signal` абортился во время backoff,
  `retry` сразу отвергается причиной отмены.
- Любая другая ошибка ретраится, пока есть попытки.

## Таймаут на каждую попытку

Самая частая ошибка: обернуть `retry` в `withTimeout`. Тогда одна зависшая попытка съест
весь бюджет. Нужен таймаут **на попытку**, это `attemptTimeout`:

```ts
await retry(sig => api.flaky(sig), {
  retries: 2,
  attemptTimeout: 3000,   // попытка, не ответившая за 3 с, отменяется и считается неудачей
  delay: 100,
});
```

Истёкшая попытка ретраится, хотя её ошибка это `TimeoutError`. Внешняя отмена по-прежнему
не ретраится. Общий дедлайн, если он нужен, добавляется поверх:

```ts
await withTimeout(
  sig => retry(s => api.flaky(s), { retries: 2, attemptTimeout: 3000, signal: sig }),
  10_000,
  scope.signal,
);
```

## Решать, что ретраить

`retryOn` получает ошибку и номер попытки. Возвращает `false` (стоп), `true` (ретрай с
расчётной задержкой) или число миллисекунд (ретрай через ровно столько).

```ts
await retry(sig => api.create(payload, sig), {
  retries: 4,
  retryOn: (err, attempt) => {
    if (err instanceof HttpError) {
      if (err.status === 429) return Number(err.response.headers.get('retry-after') ?? 1) * 1000;
      if (err.status >= 500) return true;
      return false;                      // 4xx: бессмысленно
    }
    if (err instanceof TypeError) return attempt < 2;   // сетевые сбои, но не бесконечно
    return false;
  },
});
```

`scopekit/http` делает ровно это из коробки, см. [08-http.md](08-http.md).

## Идемпотентность

Ретраить POST без идемпотентного ключа опасно: сервер может выполнить действие дважды.
Либо генерируйте ключ на клиенте и передавайте в заголовке, либо не ретраите.

```ts
const key = crypto.randomUUID();
await retry(sig => http.post('/payments', { signal: sig, body, headers: { 'idempotency-key': key } }),
  { retries: 2, retryOn: err => err instanceof HttpError && err.status >= 500 });
```

## Гонка источников: race с отменой проигравших

`Promise.race` оставляет проигравших жить. `race` из scopekit отменяет их.

```ts
const config = await race([
  sig => loadFromIndexedDb(sig),
  sig => http.get('/config', { signal: sig }),
], scope.signal);
```

Первая ошибка тоже «побеждает» и отвергает результат. Нужно «первый успешный»? Тогда это не
`race`, а `Promise.any` поверх скоупа:

```ts
const config = await Scope.run(async scope =>
  Promise.any([
    scope.spawn(sig => loadFromIndexedDb(sig)),
    scope.spawn(sig => http.get('/config', { signal: sig })),
  ]),
);
// Scope.run закроет скоуп на выходе и отменит второго
```

Внимание: `Scope` fail-fast отменит соседа при ошибке первого. Для «первого успешного»
задачи должны ловить свои ошибки и отвергаться уже в `Promise.any`, либо используйте
дочерние скоупы на каждую задачу.

## Ждать всех и разобрать результаты

`settle` это `Promise.allSettled` с разложением по корзинам:

```ts
const { fulfilled, rejected } = await settle(urls.map(u => fetchJson(u, signal)));
if (rejected.length) console.warn(`${rejected.length} из ${urls.length} не загрузились`);
render(fulfilled);
```

## Опрос с backoff до условия

```ts
async function waitForJob(id: string, signal: AbortSignal) {
  return retry(async sig => {
    const job = await http.get<Job>(`/jobs/${id}`, { signal: sig });
    if (job.status === 'pending') throw new Error('still pending');
    return job;
  }, {
    retries: 30,
    delay: 500,
    factor: 1.5,
    maxDelay: 5000,
    retryOn: err => (err as Error).message === 'still pending',
    signal,
  });
}
```

## Тесты с фейковыми таймерами

```ts
vi.useFakeTimers();
const p = retry(async () => { throw new Error('x'); }, { retries: 2, delay: 100 });
p.catch(() => {});                       // навесить обработчик до продвижения времени
await vi.runAllTimersAsync();
await expect(p).rejects.toThrow('x');
```

Обработчик до `runAllTimersAsync` обязателен: иначе промис отвергнется, когда на нём ещё
нет `catch`, и vitest сочтёт это unhandled rejection.
