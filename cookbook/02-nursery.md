# Nursery: структурная конкурентность

`Nursery` из `@nursery/core/nursery` это «владелец» группы задач. У него один `AbortSignal`, один
контекст, список детей и гарантия: **когда nursery закрыт, ничего из него больше не работает**.

```ts
import { Nursery, contextKey } from '@nursery/core/nursery';
import { sleep } from '@nursery/core/signal';
import { latest } from '@nursery/core/latest';
import { createHttp } from '@nursery/core/http';
```

## Базовый сценарий: экран загружает несколько вещей

```ts
async function loadDashboard(userId: string) {
  await using nursery = new Nursery({ timeout: 10_000 });

  const profile = nursery.spawn(sig => api.profile(userId, sig));
  const orders  = nursery.spawn(sig => api.orders(userId, sig));
  const notes   = nursery.spawn(sig => api.notes(userId, sig));

  return { profile: await profile, orders: await orders, notes: await notes };
}
```

Что здесь гарантируется:

- Три запроса идут параллельно.
- Если `orders` упал, `profile` и `notes` получают `AbortError` с `cause` равным ошибке
  `orders`. Никто не продолжает жечь сеть ради ответа, который уже не нужен.
- Если всё не уложилось в 10 секунд, все три получают `TimeoutError`.
- При выходе из функции, любым путём, nursery закрыт, таймер очищен.

Без `await using` то же самое пишется через `Nursery.run`:

```ts
const data = await Nursery.run(async nursery => {
  const profile = nursery.spawn(sig => api.profile(userId, sig));
  const orders  = nursery.spawn(sig => api.orders(userId, sig));
  return { profile: await profile, orders: await orders };
}, { timeout: 10_000 });
```

`Nursery.run` ещё и пробрасывает ошибку не дождавшегося ребёнка: если вы породили задачу
и забыли её `await`, а она упала, `run` отвергнется её ошибкой, а не вернёт результат.

## Fail-fast: почему ошибка одного отменяет всех

Классический `Promise.all` отвергается при первой ошибке, но остальные промисы продолжают
жить. В `Nursery` первая не-abort ошибка ребёнка вызывает `nursery.abort()`. Все, кто держит
`nursery.signal`, получают отмену.

```ts
await Nursery.run(async nursery => {
  nursery.spawn(async sig => { await sleep(10, sig); throw new Error('db down'); });
  nursery.spawn(sig => api.slowReport(sig));   // отменится через 10 мс, а не через минуту
});
// бросит Error('db down')
```

Если fail-fast не нужен и все задачи должны дойти до конца, используйте `mapSettled` из
`@nursery/core/limit` или ловите ошибки внутри самой задачи.

## Отмена не считается ошибкой

Задача, которая отвергается `AbortError`, не роняет nursery. Это важно для `latest` и
пользовательских отмен внутри nursery:

```ts
await Nursery.run(async nursery => {
  const search = latest((q: string, sig) => api.search(q, sig));
  nursery.spawn(sig => search('a', sig)).catch(ignoreAbort);
  nursery.spawn(sig => search('ab', sig)); // первый вызов отменён, nursery жив
});
```

## Что происходит при close()

Порядок:

1. `closed` становится `true`, новые `spawn` отвергаются `NurseryClosedError`.
2. Сигнал nursery абортится с `AbortError('Nursery closed')`, если ещё не был.
3. Ожидаются все дети, включая дочерние nursery.
4. Выполняются `defer`-колбэки в обратном порядке регистрации.
5. Снимается связь с родительским сигналом.

`close()` идемпотентен: повторный вызов просто ждёт завершения.

## defer: ресурсы живут столько же, сколько nursery

```ts
await using nursery = new Nursery();

const ws = new WebSocket(url);
nursery.defer(() => ws.close());

const sub = store.subscribe(onChange);
nursery.defer(sub);                        // subscribe вернул unsubscribe

const worker = new Worker('./w.js', { type: 'module' });
nursery.defer(() => worker.terminate());

// ... работа ...
// при выходе: worker.terminate(), sub(), ws.close() — именно в таком порядке
```

`defer` может быть async, `close()` дождётся.

## Дочерние nursery

Nursery на страницу, nursery на виджет, nursery на одно действие. Дети наследуют сигнал и
контекст, а родитель при закрытии ждёт детей.

```ts
const page = new Nursery({ ctx: [TraceId.with(newTraceId())] });

function mountWidget(el: HTMLElement) {
  const widget = page.child({ timeout: 30_000 });
  widget.spawn(sig => renderWidget(el, sig));
  return () => widget.close();          // отмонтировать виджет, страница живёт
}

// уход со страницы: закрываются и все виджеты
await page.close();
```

Дочерний `abort()` не трогает родителя. Родительский `abort()` доходит до всех потомков.

## Контекст вместо AsyncContext

`contextKey` даёт типизированные значения, которые «текут» по дереву nursery без
пробрасывания через аргументы.

```ts
const TraceId = contextKey<string>('traceId');
const Locale  = contextKey('locale', 'en');      // с дефолтом: get всегда вернёт string
const User    = contextKey<User>('user');

const root = new Nursery({ ctx: [TraceId.with('t-1'), User.with(currentUser)] });
const child = root.child({ ctx: [Locale.with('ru')] });

child.get(TraceId);   // 't-1'  (от родителя)
child.get(Locale);    // 'ru'
root.get(Locale);     // 'en'   (дефолт)
child.get(User);      // User | undefined — ключ без дефолта
child.has(Locale);    // true, has смотрит только явные привязки
```

Практика: логгер и http-клиент читают `TraceId` из nursery, а не из аргументов.

```ts
function log(nursery: Nursery, msg: string) {
  console.log(`[${nursery.get(TraceId) ?? '-'}] ${msg}`);
}

const http = createHttp({ baseUrl });
function apiCall(nursery: Nursery, path: string) {
  return http.get(path, {
    signal: nursery.signal,
    headers: { 'x-trace-id': nursery.get(TraceId) ?? '' },
  });
}
```

## Задача получает nursery вторым аргументом

Внутри задачи можно породить подзадачи и читать контекст:

```ts
nursery.spawn(async (sig, s) => {
  const items = await api.list(sig);
  // подзадачи в том же nursery: их ошибки тоже fail-fast
  return Promise.all(items.map(it => s.spawn(sig2 => api.detail(it.id, sig2))));
});
```

Нужна изоляция, чтобы ошибка подзадачи не роняла всё? Дочерний nursery:

```ts
nursery.spawn(async (_sig, s) => {
  await using inner = s.child();
  inner.spawn(sig => optionalPrefetch(sig)).catch(() => {}); // упадёт, но только inner
});
```

Внимание: `inner.spawn(...).catch(() => {})` подавляет ошибку для вызывающего, но `inner`
всё равно запомнит её в `inner.error` и отменит своих братьев. Для «мягких» задач ловите
ошибку внутри самой задачи.

## Внешний сигнал

Nursery можно привязать к чужому сигналу, например к `signal` из React Router loader или
к `AbortSignal.timeout`:

```ts
export async function loader({ request }: LoaderFunctionArgs) {
  return Nursery.run(async nursery => {
    const a = nursery.spawn(sig => api.a(sig));
    const b = nursery.spawn(sig => api.b(sig));
    return { a: await a, b: await b };
  }, { signal: request.signal });
}
```

## Ждать без отмены: settled()

`close()` отменяет. Если нужно только дождаться, пока все дети завершатся сами:

```ts
nursery.spawn(sig => flushAnalytics(sig));
nursery.spawn(sig => saveDraft(sig));
await nursery.settled();      // ничего не отменяет
```

## Антипаттерны

**Nursery как глобальный синглтон.** Он никогда не закроется, `defer` никогда не выполнится,
ошибка одного случайного запроса отменит всё приложение. Nursery живёт столько, сколько
экран, виджет или операция.

**`spawn` без `await` и без `catch` в долгоживущем nursery.** Ошибка не станет
`unhandledrejection`, но тихо отменит соседей. Либо `await`, либо ловите внутри задачи.

**Передавать `nursery.signal` в задачу руками.** `spawn` уже делает это. Ручная передача
работает, но при рефакторинге на дочерний nursery легко передать не тот сигнал.
