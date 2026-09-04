# Главный поток: не блокировать ввод

```ts
import { yieldToMain, chunked, idle, frame } from 'scopekit/schedule';
```

## Тяжёлый цикл

Было:

```ts
for (const row of rows) table.append(renderRow(row));   // 50 000 строк, вкладка замирает
```

Стало:

```ts
for await (const row of chunked(rows, { budget: 8, signal })) table.append(renderRow(row));
```

`chunked` отдаёт элементы по одному и смотрит на часы: как только с последней уступки
прошло больше `budget` мс, он делает `await yieldToMain()`. Браузер успевает обработать
клик и отрисовать кадр. Бюджет 8 мс это примерно половина кадра при 60 fps.

Источник может быть массивом, генератором или async-итератором.

## yieldToMain напрямую

Когда цикл не по элементам, а по фазам:

```ts
await parsePhase();
await yieldToMain(signal);
await layoutPhase();
await yieldToMain(signal);
await paintPhase();
```

Внутри `scheduler.yield()`, если он есть: продолжение сохраняет приоритет и не встаёт в конец
очереди за чужими задачами. Иначе `MessageChannel`, который в отличие от `setTimeout(0)`
не клампится до 4 мс во вложенных вызовах.

## idle: делать неважное, когда браузер свободен

Прогрев кеша, предзагрузка следующего экрана, отправка метрик:

```ts
scope.spawn(async sig => {
  const deadline = await idle({ timeout: 2000, signal: sig });
  while (deadline.timeRemaining() > 0 && queue.length) prewarm(queue.shift()!);
});
```

Safari без `requestIdleCallback` получает фолбэк на таймер с синтетическим `deadline`.

## frame: синхронизироваться с отрисовкой

```ts
async function animate(el: HTMLElement, signal: AbortSignal) {
  const start = await frame(signal);
  for (;;) {
    const t = await frame(signal);
    const p = Math.min(1, (t - start) / 300);
    el.style.opacity = String(p);
    if (p === 1) return;
  }
}
```

Отмена сигнала вызывает `cancelAnimationFrame` и отвергает промис, цикл завершается сам.

## Измерять до и после

Chrome DevTools → Performance → запись → длинные задачи подсвечены красным. После
`chunked` на месте одной задачи в 400 мс должны появиться десятки по 8–10 мс с зазорами.
Второй способ: `PerformanceObserver` на `longtask` в dev-режиме:

```ts
new PerformanceObserver(list => {
  for (const e of list.getEntries()) console.warn('long task', Math.round(e.duration), 'ms');
}).observe({ type: 'longtask', buffered: true });
```

## Когда этого мало

`chunked` разбивает работу, но не ускоряет её. Если работа занимает секунды, она должна
уйти в воркер, см. [09-workers.md](09-workers.md). Хорошее правило: `chunked` для работы
с DOM, воркер для чистых вычислений.

## Взаимодействие с фреймворками

React, Vue и остальные батчат обновления. Вызов `setState` внутри `chunked`-цикла на каждой
итерации сработает, но каждая уступка главному потоку даст фреймворку возможность
отрендерить промежуточное состояние. Обычно это желаемое поведение (прогресс-бар).
Если нет, копите результат и делайте один `setState` в конце.

## postTask: приоритеты

```ts
import { postTask } from 'scopekit/schedule';

await postTask(() => renderVisibleRows(), { priority: 'user-blocking', signal });
await postTask(() => warmCache(), { priority: 'background', signal, delay: 500 });
```

На `scheduler.postTask` приоритет отдаётся браузеру. Без него задачи встают в очередь
макрозадач, но порядок `user-blocking` → `user-visible` → `background` среди уже
запланированных сохраняется.
