# Наблюдаемость: имена, дамп, зависшие задачи, необработанные ошибки

```ts
import { Nursery } from '@nursery/core/nursery';
import { timeoutError } from '@nursery/core/signal';
```

## Имена задач и дамп дерева

```ts
const page = new Nursery({ name: 'orders-page' });
page.spawn(sig => pollStatus(sig), { name: 'poll' });
const widget = page.child({ name: 'chart' });
widget.spawn(sig => stream(sig), { name: 'ws' });

console.log(page.dump());
// orders-page [open]
//   - poll 1203ms
//   chart [open]
//     - ws 1198ms
```

`nursery.tasks`, `nursery.children` и `nursery.inspect()` дают то же в виде объектов. Повесьте
`window.__nurseries = rootNursery` в dev-сборке, и «кто держит страницу» находится за секунду.

## Необработанные ошибки

Задача, которую никто не `await`, при ошибке не создаёт `unhandledrejection`. Она уходит
в `Nursery.onUnhandled`:

```ts
Nursery.onUnhandled((error, { nursery, task }) => {
  Sentry.captureException(error, { tags: { nursery: nursery.name, task: task?.name } });
});
```

Без подписчиков ошибка печатается в `console.error`. Не считаются необработанными:
отмены, ошибки, которые вызывающий дождался или поймал через `catch` в течение одной
макрозадачи, и первая ошибка, которую пробрасывает `Nursery.run`.

## Зависшие задачи

`close()` ждёт детей. Задача, игнорирующая сигнал, повесит его навсегда. Grace-период
ограничивает ожидание:

```ts
await using nursery = new Nursery({ name: 'modal', grace: 5000 });
// или разово: await nursery.close({ grace: 5000 })
```

Через 5 секунд `close()` завершится, cleanup выполнится, а в `Nursery.onUnhandled` придёт
`NurseryStuckError` со списком задач, их именами и временем жизни. Grace наследуется дочерними
nursery. Это диагностика, а не лечение: задача должна принимать сигнал.

## Дедлайн

```ts
const nursery = new Nursery({ timeout: 10_000 });
nursery.deadline;      // performance.now() + 10000
nursery.remaining();   // сколько осталось
const child = nursery.child({ timeout: 60_000 });   // дедлайн ребёнка = дедлайн родителя
```

`http` читает дедлайн из опции `nursery`, свои функции могут делать так же:

```ts
async function withBudget(nursery: Nursery) {
  if (nursery.remaining() < 500) throw timeoutError('Not enough time budget');
}
```

## Nursery.current() и профилирование

```ts
await nursery.spawn(async () => {
  Nursery.current();          // == nursery в синхронной части задачи
  await something();
  Nursery.current();          // undefined без AsyncContext, nursery там, где он есть
});
nursery.enter(() => Nursery.current());   // явный вход
```

Правило: пробрасывайте nursery аргументом, а `Nursery.current()` используйте для диагностики и в
местах, где аргумент физически не пробросить.

```ts
Nursery.profiling = true;   // в dev
// Performance-панель DevTools: measure 'nursery:page/loadUser' с detail { nursery, task, status }
// и 'nursery:page' на время жизни nursery
```
