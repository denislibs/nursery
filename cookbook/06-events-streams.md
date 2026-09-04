# События как потоки

```ts
import { on, Channel } from 'scopekit/events';
import { pipe, map, filter, take, buffer, debounce, throttle, toArray } from 'scopekit/iter';
```

## on: события в цикле for-await

```ts
for await (const e of on<MouseEvent>(canvas, 'pointermove', { signal: scope.signal })) {
  draw(e.offsetX, e.offsetY);
}
console.log('цикл закончился, скоуп закрыт');
```

- События, пришедшие пока тело цикла ждёт `await`, буферизуются и не теряются.
- Abort сигнала **завершает** цикл, а не бросает. Это сделано намеренно: такой цикл
  обычно и есть тело скоупа, исключение здесь только шум.
- Listener снимается при `break`, `return`, исключении в теле и при abort.
- Опции `capture`, `passive`, `once` передаются в `addEventListener`.

## Буфер с потерей старых

Для высокочастотных событий, где важно только последнее состояние:

```ts
for await (const e of on<PointerEvent>(el, 'pointermove', { signal, buffer: 1 })) {
  await heavyRedraw(e);   // пока рисуем, накапливается только последнее событие
}
```

## Последовательности событий как код

Drag and drop, который читается сверху вниз:

```ts
async function dragLoop(el: HTMLElement, signal: AbortSignal) {
  for await (const down of on<PointerEvent>(el, 'pointerdown', { signal })) {
    el.setPointerCapture(down.pointerId);
    const gesture = new AbortController();
    const stop = anySignal([signal, gesture.signal]);

    on<PointerEvent>(el, 'pointerup', { signal: stop })[Symbol.asyncIterator]().next()
      .then(() => gesture.abort());

    for await (const move of on<PointerEvent>(el, 'pointermove', { signal: stop, buffer: 1 })) {
      el.style.transform = `translate(${move.clientX - down.clientX}px, ${move.clientY - down.clientY}px)`;
    }
    el.releasePointerCapture(down.pointerId);
  }
}
```

Нет флагов `isDragging`, нет трёх обработчиков, которые надо синхронизировать.

## Ждать одно событие

```ts
async function once<E extends Event>(target: EventTarget, type: string, signal: AbortSignal) {
  for await (const e of on<E>(target, type, { signal })) return e;
  throw signal.reason ?? abortError();
}

const msg = await withTimeout(sig => once<MessageEvent>(ws, 'message', sig), 5000, scope.signal);
```

## Операторы

Операторы это функции `AsyncIterable → AsyncIterable`, собираются через `pipe`:

```ts
const stream = pipe(
  on<InputEvent>(input, 'input', { signal }),
  map(e => (e.target as HTMLInputElement).value.trim()),
  filter(v => v.length >= 2),
  debounce(300),
);
for await (const q of stream) search(q).then(render).catch(ignoreAbort);
```

| Оператор | Что делает |
|---|---|
| `map(fn)` | преобразует, `fn` может быть async |
| `filter(fn)` | пропускает по предикату, поддерживает type guard |
| `take(n)` | первые `n`, затем закрывает источник |
| `buffer(n)` | массивы по `n` элементов, остаток в конце |
| `buffer({ ms })` | всё, что пришло за `ms` от первого элемента окна |
| `debounce(ms)` | последнее значение после паузы `ms`; при завершении источника сбрасывает ожидающее |
| `throttle(ms)` | первое сразу, дальше не чаще одного в `ms`, последнее в окне не теряется |
| `toArray(src)` | собрать в массив |

Они работают над любым `AsyncIterable`: `on`, `Channel`, async-генераторами, `ReadableStream`.

## Батчинг событий аналитики

```ts
const events = new Channel<AnalyticsEvent>(1000);

export function track(e: AnalyticsEvent) {
  void events.send(e).catch(() => {});     // при переполнении не блокируем UI, просто теряем
}

scope.spawn(async sig => {
  for await (const batch of pipe(events, buffer({ ms: 2000 }))) {
    await http.post('/analytics', { signal: sig, body: batch }).catch(() => {});
  }
});
scope.defer(() => events.close());
```

Внимание: `send` на полном канале **ждёт**, а не отбрасывает. Строка с `.catch` выше
не сделает его неблокирующим, она лишь подавит ошибку закрытого канала. Если нужно
отбрасывать, проверяйте `events.size` перед `send`.

## Channel: очередь с backpressure

`Channel` это Go-канал. Ёмкость `0` (по умолчанию) означает рандеву: `send` ждёт, пока
кто-то не вызовет `receive`. Положительная ёмкость буферизует.

```ts
const jobs = new Channel<Job>(8);

// продюсер сам замедлится, если потребители не успевают
scope.spawn(async sig => {
  for await (const job of pollJobs(sig)) await jobs.send(job, sig);
  jobs.close();
});

// три потребителя
for (let i = 0; i < 3; i++) {
  scope.spawn(async sig => {
    for await (const job of jobs) await process(job, sig);
  });
}
```

- `send(value, signal?)` и `receive(signal?)` отменяемы.
- `close()`: буфер дочитывается, ожидающие `send`/`receive` получают `ChannelClosedError`,
  итерация завершается.
- `break` из `for await` закрывает канал.

## Channel как мост «колбэки → поток»

Библиотека даёт только `onData(cb)`:

```ts
function streamOf<T>(subscribe: (cb: (v: T) => void) => () => void, signal: AbortSignal): AsyncIterable<T> {
  const ch = new Channel<T>(64);
  const unsub = subscribe(v => { void ch.send(v); });
  signal.addEventListener('abort', () => { unsub(); ch.close(); }, { once: true });
  return ch;
}

for await (const price of pipe(streamOf(ticker.onPrice, signal), throttle(100))) updatePrice(price);
```

## WebSocket как поток сообщений

```ts
async function* messages(ws: WebSocket, signal: AbortSignal) {
  for await (const e of on<MessageEvent>(ws, 'message', { signal })) yield JSON.parse(e.data);
}

for await (const msg of pipe(messages(ws, scope.signal), filter(isChatMessage))) appendMessage(msg);
```

## Отмена в цепочке

Все операторы корректно завершают источник, если потребитель вышел из цикла. `debounce`
и `throttle` очищают свои таймеры. Тест на это есть в `test/iter.test.ts`.
