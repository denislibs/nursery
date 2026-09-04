# Лимиты конкурентности

```ts
import { Semaphore, Mutex, map, mapSettled, Queue } from 'scopekit/limit';
```

## map: обработать список с ограничением

```ts
const thumbnails = await map(files, (file, i, sig) => makeThumbnail(file, sig), {
  concurrency: 4,
  signal: scope.signal,
});
```

- Результаты в порядке входа, независимо от того, кто закончил первым.
- Первая ошибка: остальные в полёте получают abort, невзятые не стартуют, ошибка
  пробрасывается наружу.
- Источник может быть массивом, генератором или async-итератором, порядок всё равно
  сохраняется.

```ts
async function* pages(sig: AbortSignal) {
  for (let p = 1; ; p++) {
    const page = await http.get<Item[]>('/items', { signal: sig, query: { page: p } });
    if (page.length === 0) return;
    yield* page;
  }
}
const enriched = await map(pages(scope.signal), (item, _i, sig) => enrich(item, sig), { concurrency: 8 });
```

Здесь `map` тянет страницы по мере необходимости, а не грузит всё в память.

## mapSettled: довести всё до конца

Когда важен каждый элемент, а не «всё или ничего»:

```ts
const results = await mapSettled(emails, (e, _i, sig) => send(e, sig), { concurrency: 5, signal });
const failed = results
  .map((r, i) => (r.status === 'rejected' ? { email: emails[i], reason: r.reason } : null))
  .filter(Boolean);
```

Только внешний `signal` может остановить `mapSettled` досрочно.

## Semaphore: N одновременных из любого места

`map` работает над одним списком. Семафор ограничивает всех, кто его держит, где бы они
ни вызывались.

```ts
export const uploadSlots = new Semaphore(3);

export function upload(file: File, signal: AbortSignal) {
  return uploadSlots.run(sig => doUpload(file, sig), signal);
}
```

`run` берёт разрешение, выполняет функцию с тем же сигналом, отпускает при любом исходе.
Ожидание разрешения отменяемо: abort во время ожидания выбрасывает из очереди без утечки.

Ручной вариант, когда критическая секция не укладывается в один вызов:

```ts
const release = await uploadSlots.acquire(signal);
try {
  await step1();
  await step2();
} finally {
  release();     // повторный вызов безопасен
}
```

`sem.available` и `sem.pending` полезны для индикатора «в очереди: 4».

## Mutex: строго по одному

Локальный кеш, который не должен заполняться дважды:

```ts
const cacheLock = new Mutex();
let cached: Config | undefined;

export function getConfig(signal: AbortSignal) {
  return cacheLock.run(async sig => {
    cached ??= await http.get<Config>('/config', { signal: sig });
    return cached;
  }, signal);
}
```

Для дедупликации in-flight запросов чаще подходит `singleFlight`, см.
[05-races.md](05-races.md). Мьютекс нужен, когда есть состояние, которое читается и
пишется в несколько шагов.

## Queue: задачи добавляются со временем

`map` знает весь список заранее. `Queue` живёт долго, задачи прилетают по событиям.

```ts
const saveQueue = new Queue({ concurrency: 1, signal: scope.signal });

editor.on('change', doc => {
  saveQueue.clear();                                // черновики, которые не успели, не нужны
  saveQueue.add(sig => api.saveDraft(doc, sig)).catch(ignoreAbort);
});

// перед уходом дождаться, чтобы последний save ушёл
await saveQueue.idle();
```

- `add(task, signal?)` возвращает промис результата задачи.
- `size` это ожидающие, `pending` это выполняющиеся.
- `clear()` отвергает ожидающих `AbortError`, выполняющихся не трогает.
- Сигнал очереди отменяет выполняющихся и отвергает ожидающих, новые `add` отвергаются.
- Сигнал задачи снимает её с ожидания без влияния на остальных.

## Пул воркеров через Queue

```ts
const workers = Array.from({ length: navigator.hardwareConcurrency ?? 4 }, () =>
  wrap<ParserApi>(new Worker(new URL('./parser.worker.ts', import.meta.url), { type: 'module' })),
);
const pool = new Queue({ concurrency: workers.length });
let next = 0;

export function parse(src: string, signal: AbortSignal) {
  return pool.add(sig => {
    const w = workers[next++ % workers.length]!;
    return w.parse(src, { signal: sig });
  }, signal);
}
```

## Rate limit: не больше N в секунду

Семафор ограничивает одновременность, а не частоту. Для частоты нужен «токен-бакет»,
который собирается из `Semaphore` и `sleep`:

```ts
export function rateLimiter(perSecond: number) {
  const sem = new Semaphore(perSecond);
  return async <T>(fn: (sig: AbortSignal) => Promise<T>, signal: AbortSignal) => {
    const release = await sem.acquire(signal);
    // отпускаем разрешение через секунду, а не по завершении fn
    sleep(1000).then(release);
    return fn(signal);
  };
}

const limited = rateLimiter(5);
await limited(sig => http.get('/search', { signal: sig, query: { q } }), scope.signal);
```

## Ограничить параллелизм внутри Scope

```ts
await Scope.run(async scope => {
  const sem = new Semaphore(2);
  const tasks = ids.map(id => scope.spawn(sig => sem.run(s => api.detail(id, s), sig)));
  return Promise.all(tasks);
});
```

Fail-fast скоупа и лимит семафора работают вместе: ошибка одной задачи отменяет остальные,
включая тех, кто ещё ждёт разрешения.

## Чего не делать

- **Семафор на модуль ради «на всякий случай».** Лимит должен отражать реальный ресурс:
  число соединений, квоту API, CPU.
- **`Promise.all(items.map(...))` для сотен запросов.** Браузер сам ограничит HTTP/1.1
  шестью соединениями, но очередь уже будет в неконтролируемом состоянии, и отмена не
  сработает для тех, кто ещё не начал. `map` с `concurrency` решает обе проблемы.

## Приоритеты в Queue

Картинки в видимой области должны грузиться раньше остальных:

```ts
const images = new Queue({ concurrency: 4, signal: scope.signal });

function load(img: HTMLImageElement, visible: boolean) {
  return images.add(sig => fetchImage(img.dataset.src!, sig), { priority: visible ? 10 : 0 });
}
```

Среди ожидающих первым стартует задача с большим `priority`, при равенстве порядок FIFO.
Уже выполняющиеся задачи приоритет не трогает.

## pause и resume

Остановить фоновые загрузки, пока пользователь скроллит:

```ts
const prefetch = new Queue({ concurrency: 3 });
let idleTimer: ReturnType<typeof setTimeout>;
window.addEventListener('scroll', () => {
  prefetch.pause();
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => prefetch.resume(), 300);
}, { passive: true, signal: scope.signal });
```

`pause` не трогает выполняющиеся задачи и не мешает `add`. `Semaphore.tryAcquire()` даёт
разрешение без ожидания или `undefined`, когда всё занято.
