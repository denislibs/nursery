# Отмена: сигналы, таймауты, sleep

Всё в scopekit держится на одном правиле: **любая async-функция, которая ждёт сеть, таймер
или событие, принимает `AbortSignal`**. Этот файл о примитивах из `scopekit/signal`.

```ts
import { sleep, isAbort, anySignal, timeoutSignal, throwIfAborted, abortError } from 'scopekit/signal';
```

## Отменяемая задержка

`sleep` вместо `new Promise(r => setTimeout(r, ms))`. Разница: при abort таймер очищается,
а промис отвергается с причиной отмены.

```ts
const ctrl = new AbortController();

async function pollUntilReady(signal: AbortSignal) {
  while (!(await isReady(signal))) {
    await sleep(500, signal);   // abort прерывает ожидание сразу, а не через 500 мс
  }
}

pollUntilReady(ctrl.signal).catch(err => {
  if (isAbort(err)) return;     // отмена это не ошибка
  reportError(err);
});

// пользователь ушёл со страницы
ctrl.abort();
```

## Отличать отмену от ошибки

`isAbort` возвращает `true` для `AbortError` и `TimeoutError`. Это единственный правильный
способ: сравнение по `err.name` не ловит `TimeoutError`, `instanceof DOMException` ловит лишнее.

```ts
try {
  await loadData(signal);
} catch (err) {
  if (isAbort(err)) return;          // молча выходим
  showErrorToast(err);               // всё остальное показываем
}
```

Хелпер, который встречается в каждом проекте:

```ts
export function ignoreAbort(err: unknown): undefined {
  if (isAbort(err)) return undefined;
  throw err;
}

loadData(signal).then(render).catch(ignoreAbort);
```

## Объединять несколько причин отмены

Запрос должен отмениться, если пользователь ушёл со страницы **или** нажал «отмена»
**или** истёк общий таймаут. `anySignal` собирает их в один сигнал.

```ts
const pageSignal = scope.signal;                      // жизнь страницы
const userCancel = new AbortController();             // кнопка «Отмена»
const deadline = timeoutSignal(30_000);               // общий дедлайн

const signal = anySignal([pageSignal, userCancel.signal, deadline]);
await uploadFile(file, signal);
```

`signal.reason` будет причиной того сигнала, который сработал первым. Так в обработчике
можно понять, что произошло:

```ts
try {
  await uploadFile(file, signal);
} catch (err) {
  if (isAbort(err) && (err as DOMException).name === 'TimeoutError') {
    toast('Загрузка заняла слишком много времени');
    return;
  }
  if (isAbort(err)) return;
  throw err;
}
```

## Долгоживущий родительский сигнал и утечки

`AbortSignal.any` в браузере держит слабые ссылки, дочерний сигнал можно бросить и забыть.
Ручной фолбэк для старых браузеров держит сильные слушатели. Если код должен работать и там,
и вы создаёте много короткоживущих сигналов от одного долгоживущего, используйте `linkSignals`
и снимайте связь явно:

```ts
import { linkSignals } from 'scopekit/signal';

async function withRequestSignal<T>(parent: AbortSignal, fn: (s: AbortSignal) => Promise<T>) {
  const link = linkSignals([parent, timeoutSignal(10_000)]);
  try {
    return await fn(link.signal);
  } finally {
    link.unlink();    // no-op в браузерах с нативным AbortSignal.any
  }
}
```

`Scope` делает это сам при `close()`.

## Проверять отмену внутри длинного синхронного кода

В цикле без `await` сигнал никто не проверит. `throwIfAborted` делает это в одну строку:

```ts
function parseHuge(rows: string[], signal: AbortSignal) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    if (i % 1000 === 0) throwIfAborted(signal);   // бросит signal.reason
    out.push(parseRow(rows[i]));
  }
  return out;
}
```

Если цикл тяжёлый и блокирует UI, см. [07-main-thread.md](07-main-thread.md), `chunked`
делает то же и ещё уступает главный поток.

## Собственная причина отмены

`abortError(message)` создаёт `DOMException` с именем `AbortError`. Осмысленная причина
помогает в логах и в тестах.

```ts
ctrl.abort(abortError('Пользователь закрыл диалог'));

// где-то глубже
catch (err) {
  if (isAbort(err)) console.debug('cancelled:', (err as Error).message);
}
```

## Обернуть API, которое не принимает signal

Некоторые библиотеки дают только `cancel()`. Оборачиваем в промис с сигналом:

```ts
function geocode(address: string, signal: AbortSignal): Promise<Coords> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const req = legacyGeocoder.lookup(address, { onSuccess: resolve, onError: reject });
    signal.addEventListener('abort', () => {
      req.cancel();
      reject(signal.reason);
    }, { once: true });
  });
}
```

Шаблон всегда один: проверить на входе, подписаться на `abort` с `{ once: true }`,
отменить нижележащую операцию, отвергнуть промис `signal.reason`.

## Сигнал для колбэков DOM

`addEventListener` умеет принимать `signal` сам, это часть платформы:

```ts
window.addEventListener('resize', onResize, { signal: scope.signal });
// при закрытии скоупа слушатель снимется, removeEventListener не нужен
```

## Чек-лист

- Параметр `signal` есть у каждой функции, которая может ждать. Даже если сегодня вызывающий
  передаёт `undefined`, завтра появится отмена.
- Отмена не логируется как ошибка. `isAbort` в каждом `catch`, который что-то показывает.
- Никаких `setTimeout` без очистки. Используйте `sleep(ms, signal)`.
- Одна операция, один сигнал. Несколько причин собираются через `anySignal`, а не вложенными
  `try/catch`.
