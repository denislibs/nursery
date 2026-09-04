# HTTP-клиент

```ts
import { createHttp, HttpError } from 'scopekit/http';
```

## Клиент на приложение

```ts
export const http = createHttp({
  baseUrl: import.meta.env.VITE_API_URL,
  timeout: 15_000,                       // на попытку
  retry: { retries: 2, delay: 300, jitter: 0.3 },
  headers: { accept: 'application/json' },
});
```

Что вы получаете:

- `signal` обязателен в каждом запросе. Без него `TypeError`. Это намеренно: запрос без
  владельца это утечка.
- Таймаут на попытку, `TimeoutError` через `isAbort`.
- Retry по сетевым ошибкам, таймаутам и статусам 408/425/429/5xx, только для идемпотентных
  методов (GET, HEAD, OPTIONS, PUT, DELETE). `Retry-After` учитывается.
- Одинаковые параллельные GET делят один `fetch`.
- Объект в `body` кодируется в JSON, `FormData`, `Blob`, `URLSearchParams`, строки и потоки
  идут как есть.
- Ответ парсится по `content-type`: JSON в объект, остальное в текст, 204 в `undefined`.
- Не-2xx это `HttpError` с `status`, `body` и `response`.

## Типичный вызов

```ts
const user = await http.get<User>('/users/1', { signal: scope.signal, query: { expand: 'roles' } });
await http.post('/users', { signal: scope.signal, body: { name: 'Ann' } });
await http.patch(`/users/${id}`, { signal, body: patch, timeout: 5000 });
```

## Обработка ошибок

```ts
try {
  return await http.get<Order>(`/orders/${id}`, { signal });
} catch (err) {
  if (isAbort(err)) return;                          // отмена или таймаут
  if (err instanceof HttpError) {
    if (err.status === 404) return null;
    if (err.status === 401) return redirectToLogin();
    const message = (err.body as { message?: string })?.message ?? err.message;
    toast(message);
    return;
  }
  throw err;                                         // сетевая ошибка после всех ретраев
}
```

## Авторизация и обновление токена

Заголовки по умолчанию статичны. Для динамического токена оберните `fetch`:

```ts
let accessToken = '';
const refresh = singleFlight(async (_: void) => { accessToken = await refreshToken(); });

export const http = createHttp({
  baseUrl,
  fetch: async (input, init) => {
    const withAuth = (t: string) => ({ ...init, headers: { ...headersOf(init), authorization: `Bearer ${t}` } });
    let res = await fetch(input, withAuth(accessToken));
    if (res.status === 401) {
      await refresh();                              // все параллельные 401 ждут одно обновление
      res = await fetch(input, withAuth(accessToken));
    }
    return res;
  },
});

function headersOf(init?: RequestInit) {
  const h: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => (h[k] = v));
  return h;
}
```

`signal` из `init` доходит до обоих `fetch`, отмена работает и во время обновления токена.

## Отменять при уходе со страницы

Всё, что нужно: передавать `scope.signal`. Скоуп страницы закрывается при навигации,
все запросы этой страницы получают abort, общий `fetch` под дедупликацией отменится, когда
уйдёт последний подписчик.

```ts
export function pageScope(): Scope {
  const scope = new Scope();
  router.onLeave(() => void scope.close());
  return scope;
}
```

## Дедупликация: как она себя ведёт

```ts
const a = http.get('/me', { signal: s1 });
const b = http.get('/me', { signal: s2 });   // тот же fetch
```

- Ключ: метод + полный URL с query. Разные query это разные запросы.
- Каждый подписчик получает свой `Response` через `clone()`, тело можно читать независимо.
- Отмена `s1` отвергает только `a`. Общий `fetch` живёт, пока есть хоть один подписчик.
- `dedupe: false` на запросе или на клиенте выключает поведение.
- POST и другие небезопасные методы не дедуплицируются никогда.

## Ретрай POST осознанно

```ts
await http.post('/payments', {
  signal,
  body,
  headers: { 'idempotency-key': crypto.randomUUID() },
  retry: { retries: 2 },        // явный retry включает его и для POST
});
```

## Пагинация как поток

```ts
async function* allItems(signal: AbortSignal) {
  let cursor: string | undefined;
  do {
    const page = await http.get<{ items: Item[]; next?: string }>('/items', { signal, query: { cursor } });
    yield* page.items;
    cursor = page.next;
  } while (cursor);
}

for await (const item of pipe(allItems(scope.signal), filter(i => i.active), take(100))) render(item);
```

`take(100)` завершит генератор, следующая страница не запросится.

## Загрузка с прогрессом

`fetch` не даёт прогресс отправки без потокового тела, а оно поддерживается не везде.
Прогресс скачивания доступен через `request` и `ReadableStream`:

```ts
const res = await http.request('/export.csv', { signal });
const total = Number(res.headers.get('content-length'));
const reader = res.body!.getReader();
let received = 0;
const chunks: Uint8Array[] = [];
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  chunks.push(value);
  received += value.length;
  onProgress(received / total);
}
```

Отмена сигнала прервёт `reader.read()`.

## Сырой Response

`request()` не бросает на не-2xx и не парсит тело. Для редких случаев вроде HEAD-проверок
или нестандартных форматов:

```ts
const res = await http.request('/health', { signal, method: 'HEAD' });
const ok = res.status === 200;
```

## Тестирование кода с http

Подмените `fetch` при создании клиента, реальных запросов не будет:

```ts
const http = createHttp({
  fetch: async () => new Response(JSON.stringify({ id: 1 }), { headers: { 'content-type': 'application/json' } }),
});
```

С фейковыми таймерами ретраи и таймауты проверяются детерминированно, см.
`test/http.test.ts`.

## Что клиент не делает

- Не кеширует. Для кеша есть TanStack Query, SWR, и `http` хорошо ложится в их `queryFn`.
- Не сериализует вложенные query-объекты: `query` это плоский `Record<string, primitive>`.
- Не ретраит по умолчанию небезопасные методы.
- Не следит за куками и CSRF: передайте `credentials: 'include'` и заголовок как обычно,
  всё из `RequestInit` проходит насквозь.

## Хуки onRequest и onResponse

Вместо обёртки над `fetch`:

```ts
const http = createHttp({
  baseUrl,
  onRequest: (url, init) => ({ init: { ...init, headers: { ...headersOf(init), authorization: `Bearer ${getToken()}` } } }),
  onResponse: (res, { attempt }) => { metrics.http(res.status, attempt); return res; },
});
```

`onRequest` может быть async и вернуть новый `url` и/или `init`. `onResponse` вызывается на
каждую попытку до решения о ретрае и может подменить `Response`.

## Валидация ответа

Опция `parse` принимает функцию или объект с `parse()`, то есть любую zod/valibot-схему.
Тип результата выводится из схемы:

```ts
const User = z.object({ id: z.number(), name: z.string() });
const user = await http.get('/users/1', { scope, parse: User });   // тип z.infer<typeof User>
```

Ошибка схемы отвергает запрос, у неё есть поле `response` с исходным ответом.

## Владелец запроса: signal, scope, deadline

Вместо `signal` можно передать `scope`: клиент возьмёт `scope.signal` и `scope.deadline`.
Если у скоупа осталось две секунды, попытка не будет ждать пятнадцать:

```ts
await using scope = new Scope({ timeout: 2000 });
await http.get('/slow', { scope });            // TimeoutError через 2 с, не через 15
```

`deadline` можно передать и явно, это абсолютное время по `performance.now()`. Просроченный
дедлайн отвергает запрос до `fetch`, ретраи после дедлайна не делаются.

## NDJSON и Server-Sent Events

```ts
for await (const row of http.stream<Row>('/export', { scope })) append(row);

for await (const e of http.sse('/events', { scope, reconnect: { delay: 1000, maxDelay: 30_000 } })) {
  if (e.event === 'order') handle(JSON.parse(e.data));
}
```

`sse` идёт через `fetch`, поэтому работают заголовки авторизации, чего `EventSource` не умеет.
При обрыве без отмены и включённом `reconnect` соединение переоткрывается с `Last-Event-ID`,
задержка берётся из поля `retry:`, если сервер его прислал. `break` из цикла отменяет тело
ответа.
