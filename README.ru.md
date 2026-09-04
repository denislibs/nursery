# nursery

English: [README.md](README.md).

Тонкий слой над нативными `AbortSignal` / `Promise` для браузера: структурная конкурентность,
отмена, таймауты, retry, лимиты, события как потоки, планирование на главном потоке, воркеры
и `fetch`. Без зависимостей, всё принимает и возвращает платформенные типы.

Правило одно: любая async-функция, которая ждёт сеть или событие, принимает `AbortSignal`.

Компилятор: TypeScript 7 (нативный, на Go). `tsc` из пакета `typescript@7.0.2` — это
платформенный бинарник из `@typescript/typescript-<os>-<arch>`, не JS.

Рецепты по темам и фреймворкам: [cookbook/](cookbook/README.md).

## Импорт

Корневой вход `@nursery/core` реэкспортирует всё. Каждый модуль доступен и как subpath, это
гарантирует tree-shaking в любом бандлере и позволяет не тянуть `http` и `worker` в общий чанк:

```ts
import { Nursery } from '@nursery/core';              // корень
import { debounce } from '@nursery/core/iter';      // subpath: только debounce и его зависимости
import { createHttp } from '@nursery/core/http';
```

Через корень namespace `iter` шейкается rolldown/rollup, но не esbuild, поэтому для операторов
предпочтителен `@nursery/core/iter`.

## Модули

| Модуль | Экспорты |
|---|---|
| `signal` | `isAbort`, `abortError`, `timeoutError`, `throwIfAborted`, `anySignal`, `linkSignals`, `manualAnySignal`, `timeoutSignal`, `sleep` |
| `combine` | `withTimeout`, `retry`, `race`, `settle` |
| `limit` | `Semaphore` (+ `tryAcquire`), `Mutex`, `map`, `mapSettled`, `Queue` (+ `pause`/`resume`, priority) |
| `latest` | `latest`, `latestBy`, `singleFlight` |
| `nursery` | `Nursery`, `contextKey`, `ContextKey`, `NurseryClosedError`, `NurseryStuckError` |
| `events` | `on`, `Channel` (+ `trySend`, `tryReceive`), `select`, `ChannelClosedError` |
| `iter` | `pipe`, `map`, `filter`, `take`, `buffer`, `debounce`, `throttle`, `distinctUntilChanged`, `scan`, `tap`, `merge`, `zip`, `combineLatest`, `share`, `flatMap`, `timeout`, `fromReadableStream`, `toArray` (namespace `iter`) |
| `schedule` | `yieldToMain`, `postTask`, `idle`, `frame`, `frameInterval`, `chunked` (бюджет по частоте экрана) |
| `http` | `createHttp`, `HttpError` |
| `worker` | `expose`, `wrap`, `transfer`, `callback`, `createPool` |
| `testing` | `fakeFetch`, `jsonResponse`, `streamResponse`, `textStream`, `tick`, `settle`, `expectAborted`, `fakeClock`, `portPair`, `mockWorker` |
| `react` | `NurseryProvider`, `useNursery`, `useNurseryEffect`, `useAsync`, `useLatest`, `useEventStream`, `useWorker` |
| `vue` | `useNursery`, `useNurseryWatch`, `useAsync`, `useLatest`, `useEventStream`, `useWorker` |
| `solid` | `createNursery`, `nurseryEffect`, `createAsync`, `createLatest`, `createEventStream`, `createWorker` |
| `svelte` | `useNursery`, `nurseryEffect`, `asyncStore`, `useLatest`, `eventStream`, `useWorker` |
| `angular` | `injectNursery`, `nurseryEffect`, `injectAsync`, `injectLatest`, `injectEventStream`, `injectWorker` |

## Nursery

```ts
import { Nursery, contextKey } from '@nursery/core';

const TraceId = contextKey<string>('traceId');

// вариант 1: await using (TS 5.2+, esbuild/babel транспилируют)
{
  await using nursery = new Nursery({ timeout: 5000, ctx: [TraceId.with('t-1')] });
  const user  = nursery.spawn(sig => api.user(id, sig));
  const posts = nursery.spawn((sig, s) => api.posts(id, sig, s.get(TraceId)));
  render(await user, await posts);
} // выход из блока: всё незавершённое отменено, cleanup выполнен

// вариант 2: Nursery.run
const total = await Nursery.run(async nursery => {
  const a = nursery.spawn(sig => fetchA(sig));
  const b = nursery.spawn(sig => fetchB(sig));
  return (await a) + (await b);
});
```

Семантика:

- `spawn(task)` вызывает `task(signal, nursery)`. Первая не-abort ошибка ребёнка отменяет остальных
  с `AbortError`, у которого `cause` равен исходной ошибке. Ошибка лежит в `nursery.error`.
- Не дождавшийся ребёнок с ошибкой не создаёт `unhandledrejection`.
- `close()` идемпотентен: отменяет живых детей, ждёт их, запускает `defer` в обратном порядке,
  отвязывается от родительского сигнала.
- `child()` наследует сигнал и контекст, но не отменяет родителя. Родитель при закрытии ждёт детей.
- Контекст типизирован: `contextKey<T>(name, default?)`, `key.with(value)`, `nursery.get(key)`,
  `nursery.has(key)`. Это явная замена AsyncContext, пока его нет в платформе.

## Комбинаторы

```ts
await withTimeout(sig => fetch(url, { signal: sig }), 3000, nursery.signal);

await retry(sig => fetch(url, { signal: sig }), {
  retries: 3, delay: 200, factor: 2, jitter: 0.2,
  attemptTimeout: 5000,                       // зависшая попытка считается ошибкой и ретраится
  retryOn: err => (isRateLimited(err) ? 60_000 : !isFatal(err)),  // число = задержка в мс
  signal: nursery.signal,
});

const first = await race([sig => fromCache(sig), sig => fromNetwork(sig)]); // проигравший отменён
```

## Лимиты

```ts
const sem = new Semaphore(4);
await sem.run(sig => upload(file, sig), nursery.signal);

// map: порядок сохранён, при первой ошибке остальные отменяются и не стартуют
const results = await map(urls, (u, _i, sig) => fetchJson(u, sig), { concurrency: 3, signal: nursery.signal });
// mapSettled: всё выполняется до конца, PromiseSettledResult[] в порядке входа
// источник может быть Iterable или AsyncIterable

const queue = new Queue({ concurrency: 2, signal: nursery.signal });
queue.add(sig => process(job, sig));
await queue.idle();
```

## Гонки и дедупликация

```ts
const search = latest((q: string, sig) => api.search(q, sig));
search.pending; // true, пока запрос в полёте
// старый запрос отменён, старый ответ никогда не перетрёт новый

const loadUser = singleFlight((id: number) => api.user(id));
loadUser(1); loadUser(1); // один запрос, два ожидающих
```

## События и потоки

```ts
import { on, Channel, iter } from '@nursery/core';

for await (const e of iter.pipe(on<InputEvent>(input, 'input', { signal }), iter.debounce(300))) {
  search((e.target as HTMLInputElement).value);
}
// abort сигнала завершает цикл, а не бросает; listener снимается всегда

const ch = new Channel<Job>(16);        // 0 = rendezvous, N = буфер; send ждёт, когда полно
producer: await ch.send(job, signal);
consumer: for await (const job of ch) handle(job);
ch.close();                              // буфер дочитывается, ожидающие получают ChannelClosedError

iter.pipe(source, iter.filter(ok), iter.map(parse), iter.buffer({ ms: 100 }), iter.take(10));
```

## Главный поток

```ts
for await (const row of chunked(rows, { signal })) process(row); // yield каждые полкадра работы
await yieldToMain();   // scheduler.yield() или macrotask через MessageChannel
await idle({ timeout: 1000 });
await frame();
```

## HTTP

```ts
const http = createHttp({
  baseUrl: 'https://api.example.com/v1',
  timeout: 10_000,
  retry: { retries: 2, delay: 300 },        // только идемпотентные методы, Retry-After учитывается
  headers: { authorization: `Bearer ${token}` },
});

const user = await http.get<User>('/users/1', { signal: nursery.signal, query: { expand: 'posts' } });
await http.post('/users', { signal, body: { name } });   // объект → JSON; FormData как есть
// signal обязателен, без него TypeError; ошибка статуса — HttpError { status, body, response }
// одинаковые параллельные GET делят один fetch; отмена одного подписчика не гасит общий запрос
```

## Воркеры

```ts
// worker.ts
import { expose } from '@nursery/core';
expose({
  async parse(src: string, { signal }: { signal: AbortSignal }) { /* signal живой */ },
});

// main.ts
import { wrap } from '@nursery/core';
const parser = wrap<typeof import('./worker.js')['api']>(new Worker('./worker.js', { type: 'module' }));
const ast = await parser.parse(src, { signal: nursery.signal }); // abort доходит до воркера
parser[Symbol.dispose]();
```

## Фреймворки

```ts
import { useAsync, useLatest, useEventStream } from '@nursery/react';

const orders = useAsync(nursery => http.get<Order[]>('/orders', { nursery }), [userId]);
const { run: search, pending } = useLatest((q: string, sig) => http.get<Item[]>('/search', { signal: sig, query: { q } }));
useEventStream<KeyboardEvent>(window, 'keydown', e => { if (e.key === 'Escape') close(); });
```

```ts
import { useAsync, useLatest } from '@nursery/vue';
const { data, loading } = useAsync(nursery => http.get<User>(`/users/${props.id}`, { nursery }));
```

Те же примитивы есть для Solid (`@nursery/solid`), Svelte 5 (`@nursery/svelte`) и Angular
(`@nursery/angular`). Все адаптеры это optional peer dependencies.

## Тесты

```ts
import { fakeFetch, mockWorker, expectAborted, fakeClock } from '@nursery/core/testing';

const f = fakeFetch({ 'GET /users/:id': ({ params }) => ({ id: params.id }) });
const http = createHttp({ fetch: f.fetch });
const remote = wrap<typeof api>(mockWorker(api));      // воркер без Worker
await expectAborted(nursery.spawn(sig => sleep(1000, sig)));
```

## Разработка

```bash
npm run check   # oxfmt --check, oxlint, typecheck, tests (node + chromium), build
npm run format
```
