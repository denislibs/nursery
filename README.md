# scopekit

Тонкий слой над нативными `AbortSignal` / `Promise` для браузера: структурная конкурентность,
отмена, таймауты, retry, лимиты, события как потоки, планирование на главном потоке, воркеры
и `fetch`. Без зависимостей, всё принимает и возвращает платформенные типы.

Правило одно: любая async-функция, которая ждёт сеть или событие, принимает `AbortSignal`.

Компилятор: TypeScript 7 (нативный, на Go). `tsc` из пакета `typescript@7.0.2` — это
платформенный бинарник из `@typescript/typescript-<os>-<arch>`, не JS.

## Модули

| Модуль | Экспорты |
|---|---|
| `signal` | `isAbort`, `abortError`, `timeoutError`, `throwIfAborted`, `anySignal`, `linkSignals`, `manualAnySignal`, `timeoutSignal`, `sleep` |
| `combine` | `withTimeout`, `retry`, `race`, `settle` |
| `limit` | `Semaphore`, `Mutex`, `map`, `mapSettled`, `Queue` |
| `latest` | `latest`, `singleFlight` |
| `scope` | `Scope`, `contextKey`, `ContextKey`, `ScopeClosedError` |
| `events` | `on`, `Channel`, `ChannelClosedError` |
| `iter` | `pipe`, `map`, `filter`, `take`, `buffer`, `debounce`, `throttle`, `toArray` (namespace `iter`) |
| `schedule` | `yieldToMain`, `idle`, `frame`, `chunked` |
| `http` | `createHttp`, `HttpError` |
| `worker` | `expose`, `wrap` |

## Scope

```ts
import { Scope, contextKey } from 'scopekit';

const TraceId = contextKey<string>('traceId');

// вариант 1: await using (TS 5.2+, esbuild/babel транспилируют)
{
  await using scope = new Scope({ timeout: 5000, ctx: [TraceId.with('t-1')] });
  const user  = scope.spawn(sig => api.user(id, sig));
  const posts = scope.spawn((sig, s) => api.posts(id, sig, s.get(TraceId)));
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

- `spawn(task)` вызывает `task(signal, scope)`. Первая не-abort ошибка ребёнка отменяет остальных
  с `AbortError`, у которого `cause` равен исходной ошибке. Ошибка лежит в `scope.error`.
- Не дождавшийся ребёнок с ошибкой не создаёт `unhandledrejection`.
- `close()` идемпотентен: отменяет живых детей, ждёт их, запускает `defer` в обратном порядке,
  отвязывается от родительского сигнала.
- `child()` наследует сигнал и контекст, но не отменяет родителя. Родитель при закрытии ждёт детей.
- Контекст типизирован: `contextKey<T>(name, default?)`, `key.with(value)`, `scope.get(key)`,
  `scope.has(key)`. Это явная замена AsyncContext, пока его нет в платформе.

## Комбинаторы

```ts
await withTimeout(sig => fetch(url, { signal: sig }), 3000, scope.signal);

await retry(sig => fetch(url, { signal: sig }), {
  retries: 3, delay: 200, factor: 2, jitter: 0.2,
  attemptTimeout: 5000,                       // зависшая попытка считается ошибкой и ретраится
  retryOn: err => (isRateLimited(err) ? 60_000 : !isFatal(err)),  // число = задержка в мс
  signal: scope.signal,
});

const first = await race([sig => fromCache(sig), sig => fromNetwork(sig)]); // проигравший отменён
```

## Лимиты

```ts
const sem = new Semaphore(4);
await sem.run(sig => upload(file, sig), scope.signal);

// map: порядок сохранён, при первой ошибке остальные отменяются и не стартуют
const results = await map(urls, (u, _i, sig) => fetchJson(u, sig), { concurrency: 3, signal: scope.signal });
// mapSettled: всё выполняется до конца, PromiseSettledResult[] в порядке входа
// источник может быть Iterable или AsyncIterable

const queue = new Queue({ concurrency: 2, signal: scope.signal });
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
import { on, Channel, iter } from 'scopekit';

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
for await (const row of chunked(rows, { budget: 8, signal })) process(row); // yield каждые ~8 мс работы
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

const user = await http.get<User>('/users/1', { signal: scope.signal, query: { expand: 'posts' } });
await http.post('/users', { signal, body: { name } });   // объект → JSON; FormData как есть
// signal обязателен, без него TypeError; ошибка статуса — HttpError { status, body, response }
// одинаковые параллельные GET делят один fetch; отмена одного подписчика не гасит общий запрос
```

## Воркеры

```ts
// worker.ts
import { expose } from 'scopekit';
expose({
  async parse(src: string, { signal }: { signal: AbortSignal }) { /* signal живой */ },
});

// main.ts
import { wrap } from 'scopekit';
const parser = wrap<typeof import('./worker.js')['api']>(new Worker('./worker.js', { type: 'module' }));
const ast = await parser.parse(src, { signal: scope.signal }); // abort доходит до воркера
parser[Symbol.dispose]();
```

## Разработка

```bash
npm run check   # typecheck + tests + build
```
