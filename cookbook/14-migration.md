# Миграция с других библиотек

Шпаргалка «было → стало». Полной замены RxJS или TanStack Query здесь нет и не
планируется, но большая часть повседневных сценариев переезжает один к одному.

## RxJS

| RxJS | scopekit |
|---|---|
| `fromEvent(el, 'click')` | `on(el, 'click', { signal })` |
| `switchMap(q => search(q))` | `latest((q, signal) => search(q, signal))` |
| `debounceTime(300)` | `iter.debounce(300)` |
| `throttleTime(100)` | `iter.throttle(100)` |
| `bufferTime(1000)` | `iter.buffer({ ms: 1000 })` |
| `bufferCount(10)` | `iter.buffer(10)` |
| `take(n)` | `iter.take(n)` |
| `map`, `filter` | `iter.map`, `iter.filter` |
| `takeUntil(destroy$)` | `signal` скоупа, передаётся в `on` и в задачи |
| `forkJoin([a, b])` | `Scope.run` с двумя `spawn` |
| `race(a, b)` | `race([a, b])` |
| `retry({ count, delay })` | `retry(task, { retries, delay })` |
| `timeout(ms)` | `withTimeout(task, ms)` |
| `Subject` с backpressure | `Channel<T>(capacity)` |
| `mergeMap(fn, concurrency)` | `map(items, fn, { concurrency })` или `Queue` |
| `shareReplay(1)` для запроса | `singleFlight` для дедупликации, кеш отдельно |

Пример:

```ts
// skip-check
// RxJS
fromEvent<InputEvent>(input, 'input').pipe(
  map(e => (e.target as HTMLInputElement).value),
  debounceTime(300),
  distinctUntilChanged(),
  switchMap(q => from(api.search(q))),
  takeUntil(destroy$),
).subscribe(render);

// scopekit
const search = latest((q: string, signal) => api.search(q, signal));
scope.spawn(async sig => {
  let last = '';
  for await (const q of pipe(on<InputEvent>(input, 'input', { signal: sig }),
                             map(e => (e.target as HTMLInputElement).value),
                             debounce(300))) {
    if (q === last) continue;
    last = q;
    search(q).then(render).catch(ignoreAbort);
  }
});
```

Чего нет: `combineLatest`, `withLatestFrom`, `scan`, горячие мультикаст-потоки. Если
композиция потоков сложная, оставьте RxJS и стыкуйте через `AsyncIterable`: RxJS умеет
`from(asyncIterable)`, а обратный мост в [12-svelte-solid-angular.md](12-svelte-solid-angular.md).

## p-limit, p-queue, p-map, p-retry, p-timeout

| было | стало |
|---|---|
| `pLimit(4)` + `limit(() => fn())` | `new Semaphore(4)` + `sem.run(sig => fn(sig), signal)` |
| `new PQueue({ concurrency })` | `new Queue({ concurrency, signal })` |
| `pMap(items, fn, { concurrency })` | `map(items, fn, { concurrency, signal })` |
| `pMap` с `stopOnError: false` | `mapSettled` |
| `pRetry(fn, { retries, factor })` | `retry(fn, { retries, factor })` |
| `pTimeout(promise, ms)` | `withTimeout(sig => task(sig), ms)` |
| `delay(ms)` | `sleep(ms, signal)` |

Разница по смыслу: в `p-*` отмена появляется как опция, здесь она встроена в каждую
функцию. `pTimeout` по истечении просто отвергает промис, задача продолжает работать;
`withTimeout` передаёт задаче abort.

## axios, ky

| было | стало |
|---|---|
| `axios.create({ baseURL, timeout })` | `createHttp({ baseUrl, timeout })` |
| `axios.get(url, { params })` | `http.get(url, { signal, query })` |
| `axios.post(url, data)` | `http.post(url, { signal, body: data })` |
| interceptors.request | обёртка над `fetch` в опциях `createHttp` |
| `axios-retry` | встроенный `retry` |
| `CancelToken` / `signal` | `signal` обязателен |
| `error.response.status` | `err instanceof HttpError && err.status` |
| `error.response.data` | `err.body` |
| ky `hooks.afterResponse` | обёртка над `fetch` |
| ky `retry` | `retry` с `retryStatuses`, `Retry-After` учитывается |

Чего нет: перехватчики как отдельная концепция, трансформеры ответов, XSRF-логика,
прогресс загрузки через события. Всё это делается через `fetch`-обёртку или `request()`.

## Comlink

| Comlink | scopekit |
|---|---|
| `Comlink.expose(api)` | `expose(api)` |
| `Comlink.wrap<T>(worker)` | `wrap<T>(worker)` |
| `Comlink.proxy(cb)` для колбэков | нет; используйте события или обратный `expose` |
| `Comlink.transfer(buf, [buf])` | нет, копирование |
| отмена | `AbortSignal` в аргументах доезжает до воркера |
| `remote[Comlink.releaseProxy]()` | `remote[Symbol.dispose]()` или `using` |

Главное отличие: отмена. В Comlink её нет, задача в воркере доработает до конца.

## Голый AbortController

| было | стало |
|---|---|
| `AbortSignal.any([a, b])` | `anySignal([a, b])` с фолбэком для старых браузеров |
| `AbortSignal.timeout(ms)` | `timeoutSignal(ms)` или `withTimeout` |
| `if (signal.aborted) throw signal.reason` | `throwIfAborted(signal)` |
| `err.name === 'AbortError'` | `isAbort(err)` (ловит и `TimeoutError`) |
| `new Promise(r => setTimeout(r, ms))` | `sleep(ms, signal)` |
| контроллер на компонент + `abort()` в cleanup | `Scope` в эффекте + `close()` в cleanup |

## TanStack Query, SWR

Не заменяются. Они про кеш, инвалидацию и синхронизацию с сервером. scopekit работает
внутри их `queryFn`:

```ts
queryFn: ({ signal }) => Scope.run(async scope => {
  const a = scope.spawn(sig => http.get('/a', { signal: sig }));
  const b = scope.spawn(sig => http.get('/b', { signal: sig }));
  return { a: await a, b: await b };
}, { signal });
```

Retry оставьте одному слою, иначе попытки перемножатся: либо `retry: 0` в Query, либо
без `retry` в `createHttp`.
