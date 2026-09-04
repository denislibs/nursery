# Воркеры

```ts
import { expose } from '@nursery/core/worker';                    // в воркере
import { wrap, type Remote, type Endpoint } from '@nursery/core/worker';   // в главном потоке
import { isAbort } from '@nursery/core/signal';
import { Queue, map } from '@nursery/core/limit';
```

## Минимальный пример

```ts
// parser.worker.ts
import { expose } from '@nursery/core/worker';

export const api = {
  async parse(src: string, opts: { signal: AbortSignal }) {
    const ast = heavyParse(src, opts.signal);   // signal живой, throwIfAborted внутри работает
    return ast;
  },
};
expose(api);
```

```ts
// main.ts
import { wrap } from '@nursery/core/worker';
import type { api } from './parser.worker.js';

const worker = new Worker(new URL('./parser.worker.ts', import.meta.url), { type: 'module' });
const parser = wrap<typeof api>(worker);

const ast = await parser.parse(source, { signal: nursery.signal });
```

`typeof api` даёт полную типизацию: аргументы и результат проверяются компилятором,
результат обёрнут в `Promise`.

## Как доезжает AbortSignal

`wrap` ищет `AbortSignal` среди аргументов: позиционный или поле объекта верхнего уровня.
Он заменяется маркером, в воркере на его месте создаётся `AbortController`. Когда сигнал
в главном потоке абортится, воркеру уходит сообщение, и его контроллер абортится с той же
причиной. Задача в воркере, ждущая `sleep(ms, signal)` или проверяющая `throwIfAborted`,
завершится.

Вызов в главном потоке отвергается **сразу** при abort, не дожидаясь ответа воркера.

Ограничение: сигнал должен быть верхнеуровневым аргументом или полем объекта верхнего
уровня. Внутри вложенных структур он не найдётся.

## Ошибки

Ошибка из воркера приезжает как `Error` с теми же `name`, `message` и `stack`. `AbortError`
и `TimeoutError` восстанавливаются как `DOMException`, поэтому `isAbort` работает на
обеих сторонах.

```ts
try {
  await parser.parse(src, { signal });
} catch (err) {
  if (isAbort(err)) return;
  if (err instanceof Error && err.name === 'SyntaxError') showSyntaxError(err.message);
}
```

Значение, которое нельзя склонировать (функция, DOM-узел), отвергает вызов ошибкой
`DataCloneError`, а не подвешивает его.

## Жизненный цикл в Nursery

```ts
await using nursery = new Nursery();
const worker = new Worker(new URL('./w.ts', import.meta.url), { type: 'module' });
const remote = wrap<Api>(worker);
nursery.defer(() => { remote[Symbol.dispose](); worker.terminate(); });

const result = await remote.compute(data, { signal: nursery.signal });
```

`Symbol.dispose` снимает слушатель и отвергает все незавершённые вызовы. Обычный `using`
тоже работает:

```ts
using remote = wrap<Api>(worker);
```

## Пул воркеров

```ts
export function workerPool<T>(url: URL, size = navigator.hardwareConcurrency ?? 4) {
  const workers = Array.from({ length: size }, () => {
    const w = new Worker(url, { type: 'module' });
    return { worker: w, remote: wrap<T>(w) };
  });
  const queue = new Queue({ concurrency: size });
  let rr = 0;

  return {
    run<R>(fn: (remote: Remote<T>, signal: AbortSignal) => Promise<R>, signal: AbortSignal) {
      return queue.add(sig => fn(workers[rr++ % size]!.remote, sig), signal);
    },
    dispose() {
      for (const { worker, remote } of workers) { remote[Symbol.dispose](); worker.terminate(); }
    },
  };
}

const pool = workerPool<typeof api>(new URL('./parser.worker.ts', import.meta.url));
const results = await map(files, (f, _i, sig) => pool.run((p, s) => p.parse(f, { signal: s }), sig), {
  concurrency: 8,
});
```

## Воркер вызывает главный поток

`expose` и `wrap` симметричны. Главный поток может экспонировать API для воркера
на том же `Worker`-объекте, а воркер обернуть `self`:

```ts
// main
expose({ log: async (msg: string) => console.log('[worker]', msg) }, worker);
// worker
const main = wrap<{ log: (m: string) => Promise<void> }>(self as unknown as Endpoint);
await main.log('started');
```

Сообщения двух протоколов не конфликтуют: ответы ищут `id` только среди своих ожидающих.

## SharedWorker и MessagePort

`Endpoint` это всё, у чего есть `postMessage` и события `message`: `Worker`, `MessagePort`,
`DedicatedWorkerGlobalScope`. Для `SharedWorker` оборачивайте `worker.port`:

```ts
const shared = new SharedWorker(new URL('./shared.ts', import.meta.url), { type: 'module' });
const remote = wrap<Api>(shared.port);
```

## Transferables

Текущая версия не поддерживает список transferable-объектов, большие `ArrayBuffer`
копируются. Для гигабайтных буферов это заметно. Обходной путь: передавать
`SharedArrayBuffer` при включённых COOP/COEP.

## Тесты без браузера

В Node есть `MessageChannel`, на нём протокол проверяется целиком:

```ts
const api = { add: async (a: number, b: number) => a + b };
const { port1, port2 } = new MessageChannel();
const stop = expose(api, port1);
const remote = wrap<typeof api>(port2);
await expect(remote.add(2, 3)).resolves.toBe(5);
remote[Symbol.dispose](); stop(); port1.close(); port2.close();
```

Настоящий `Worker` покрыт браузерными тестами в `test/browser/worker.browser.test.ts`.

## transfer: перемещать буферы вместо копирования

```ts
import { transfer } from '@nursery/core/worker';

const pixels = new Uint8ClampedArray(w * h * 4);
const out = await remote.blur(transfer({ pixels, w, h }, [pixels.buffer]), { signal });
// pixels.buffer.byteLength === 0: буфер уехал в воркер

// и обратно, на стороне воркера
export const workerApi = {
  async blur(img: { pixels: Uint8ClampedArray; w: number; h: number }) {
    const result = process(img);
    return transfer(result, [result.pixels.buffer]);
  },
};
```

## callback: прогресс и вопросы из воркера

```ts
import { callback } from '@nursery/core/worker';

await remote.index(files, {
  signal,
  onProgress: callback((done: number, total: number) => setProgress(done / total)),
  confirmOverwrite: callback(async (path: string) => confirm(`Перезаписать ${path}?`)),
});
```

В воркере колбэк это async-функция: вызов уходит в главный поток, результат возвращается
промисом. Колбэки живут, пока живёт вызов, который их принёс; после его завершения ссылки
освобождаются.

## Пул воркеров

```ts
import { createPool } from '@nursery/core/worker';

const pool = createPool<typeof api>(
  () => new Worker(new URL('./parser.worker.ts', import.meta.url), { type: 'module' }),
  { size: navigator.hardwareConcurrency ?? 4, signal: nursery.signal },
);

const ast = await pool.api.parse(src, { signal });   // очередь, наименее занятый воркер
pool.queued; pool.pending; pool.size;
pool.dispose();                                        // или `using pool = createPool(...)`
```

Воркеры создаются лениво, до `size`. `AbortSignal` в аргументах снимает вызов с очереди, а
если он уже выполняется, доезжает до воркера.

## Колбэки и transfer на любой глубине

`callback()` и `transfer()` работают внутри массивов и вложенных объектов, в аргументах и
результатах колбэков, а колбэк может принимать колбэк:

```ts
import { callback, transfer } from '@nursery/core/worker';
await remote.run(chunks.map(c => ({ chunk: transfer(c, [c.buffer]), onDone: callback(markDone) })));
await remote.produce(callback(async (chunk: ArrayBuffer) => transfer(process(chunk), [chunk])));
```

Ограничение: сигналы, колбэки и transfer ищутся в plain-объектах и массивах. Внутри `Map`,
`Set` или экземпляров классов они не найдутся, потому что structured clone не сохранит их.
