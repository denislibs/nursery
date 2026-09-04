# Антипаттерны

Список того, что регулярно всплывает на ревью, и как это исправить.

```ts
import { Scope } from '@scopekit/core/scope';
import { isAbort, sleep } from '@scopekit/core/signal';
import { retry, withTimeout } from '@scopekit/core/combine';
import { latest } from '@scopekit/core/latest';
import { on } from '@scopekit/core/events';
import { useScopedEffect } from '@scopekit/react';
```

## Функция без signal

```ts
// плохо: вызывающий не может отменить
async function loadUser(id: string) { return fetch(`/users/${id}`).then(r => r.json()); }
```

```ts
// хорошо
async function loadUser(id: string, signal: AbortSignal) {
  return http.get<User>(`/users/${id}`, { signal });
}
```

Если сегодня отмена не нужна, сигнал всё равно должен быть в сигнатуре. Добавить его
потом означает пройти по всем вызывающим.

## catch, который глотает отмену вместе с ошибками

```ts
// плохо: пользователь увидит тост «Ошибка» при каждом уходе со страницы
try { await load(signal); } catch (e) { toast('Ошибка'); }
```

```ts
// хорошо
try { await load(signal); } catch (e) { if (!isAbort(e)) toast('Ошибка'); }
```

## Проверка e.name === 'AbortError'

Пропускает `TimeoutError`. Всегда `isAbort`.

## setState после await без отменяемой операции

```ts
// плохо: sleep без сигнала не бросит при unmount, setState уйдёт в мёртвый компонент
useScopedEffect(async scope => {
  await sleep(500);
  setOpen(true);
}, []);
```

```ts
// хорошо
useScopedEffect(async scope => {
  await sleep(500, scope.signal);
  setOpen(true);
}, []);
```

Правило: между отменяемым `await` и `setState` не должно быть неотменяемых `await`.

## withTimeout поверх retry

```ts
// плохо: одна зависшая попытка съест весь бюджет
await withTimeout(sig => retry(s => api.x(s), { retries: 3, signal: sig }), 5000);
```

```ts
// хорошо: таймаут на попытку, общий дедлайн отдельно, если нужен
await retry(sig => api.x(sig), { retries: 3, attemptTimeout: 5000 });
```

## Promise.all вместо Scope

```ts
// плохо: при ошибке b запрос a продолжает жить
const [a, b] = await Promise.all([api.a(signal), api.b(signal)]);
```

```ts
// хорошо
const [a, b] = await Scope.run(async scope =>
  Promise.all([scope.spawn(sig => api.a(sig)), scope.spawn(sig => api.b(sig))]),
  { signal });
```

## Глобальный Scope

Скоуп, который никогда не закрывается, это `AbortController`, который никогда не абортится,
плюс fail-fast, который однажды отменит всё приложение из-за одного упавшего прогрева
кеша. Скоуп на экран, виджет, операцию.

## spawn без await и без catch в долгоживущем скоупе

```ts
// плохо: ошибка тихо отменит соседей, никто не узнает
pageScope.spawn(sig => prefetch(sig));
```

```ts
// хорошо: либо await, либо ловим внутри
pageScope.spawn(sig => prefetch(sig).catch(err => { if (!isAbort(err)) log.warn(err); }));
```

## Channel.send с .catch как «неблокирующая отправка»

`send` на заполненном канале ждёт. `.catch` подавляет только ошибку закрытого канала.
Для отбрасывания проверяйте `size` или используйте `on` с `buffer`.

## latest без внешнего сигнала

```ts
// плохо: unmount не отменит последний запрос
const search = latest((q, sig) => api.search(q, sig));
search(q);
```

```ts
// хорошо
search(q, scope.signal);
// или useLatestCallback из React-рецептов, он вызывает cancel() при unmount
```

## Retry небезопасных методов

`POST` без idempotency key ретраить нельзя. `createHttp` по умолчанию так и делает,
явный `retry` на POST это осознанное решение с ключом.

## Ретрай в двух слоях

TanStack Query с `retry: 3` и `createHttp` с `retry: { retries: 2 }` дают до 12 запросов.
Один слой.

## Семафор «на всякий случай»

Лимит должен соответствовать ресурсу: соединения, квота, CPU. Семафор с произвольной
цифрой создаёт очередь, которую никто не понимает.

## for await по on() с тяжёлым телом и без buffer

```ts
// плохо: pointermove буферизуется без ограничений, обработка отстаёт на секунды
for await (const e of on(el, 'pointermove', { signal })) await heavy(e);
```

```ts
// хорошо: важно только последнее положение
for await (const e of on(el, 'pointermove', { signal, buffer: 1 })) await heavy(e);
```

## Выбрасывать из цикла on() при abort

`on` завершает итерацию при abort, а не бросает. Код после цикла выполнится. Если после
цикла есть логика «успешного завершения», проверьте `signal.aborted`.

## chunked для вычислений

`chunked` не ускоряет, а размазывает работу. Секунды CPU уходят в воркер.

## Комментарии вида «// TODO: добавить отмену»

Добавить отмену потом дороже, чем сразу. Сигнал в сигнатуре, скоуп в эффекте.
