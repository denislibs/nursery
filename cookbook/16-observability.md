# Наблюдаемость: имена, дамп, зависшие задачи, необработанные ошибки

## Имена задач и дамп дерева

```ts
const page = new Scope({ name: 'orders-page' });
page.spawn(sig => pollStatus(sig), { name: 'poll' });
const widget = page.child({ name: 'chart' });
widget.spawn(sig => stream(sig), { name: 'ws' });

console.log(page.dump());
// orders-page [open]
//   - poll 1203ms
//   chart [open]
//     - ws 1198ms
```

`scope.tasks`, `scope.children` и `scope.inspect()` дают то же в виде объектов. Повесьте
`window.__scopes = rootScope` в dev-сборке, и «кто держит страницу» находится за секунду.

## Необработанные ошибки

Задача, которую никто не `await`, при ошибке не создаёт `unhandledrejection`. Она уходит
в `Scope.onUnhandled`:

```ts
Scope.onUnhandled((error, { scope, task }) => {
  Sentry.captureException(error, { tags: { scope: scope.name, task: task?.name } });
});
```

Без подписчиков ошибка печатается в `console.error`. Не считаются необработанными:
отмены, ошибки, которые вызывающий дождался или поймал через `catch` в течение одной
макрозадачи, и первая ошибка, которую пробрасывает `Scope.run`.

## Зависшие задачи

`close()` ждёт детей. Задача, игнорирующая сигнал, повесит его навсегда. Grace-период
ограничивает ожидание:

```ts
await using scope = new Scope({ name: 'modal', grace: 5000 });
// или разово: await scope.close({ grace: 5000 })
```

Через 5 секунд `close()` завершится, cleanup выполнится, а в `Scope.onUnhandled` придёт
`ScopeStuckError` со списком задач, их именами и временем жизни. Grace наследуется дочерними
скоупами. Это диагностика, а не лечение: задача должна принимать сигнал.

## Дедлайн

```ts
const scope = new Scope({ timeout: 10_000 });
scope.deadline;      // performance.now() + 10000
scope.remaining();   // сколько осталось
const child = scope.child({ timeout: 60_000 });   // дедлайн ребёнка = дедлайн родителя
```

`http` читает дедлайн из опции `scope`, свои функции могут делать так же:

```ts
async function withBudget(scope: Scope) {
  if (scope.remaining() < 500) throw timeoutError('Not enough time budget');
}
```

## Scope.current() и профилирование

```ts
await scope.spawn(async () => {
  Scope.current();          // == scope в синхронной части задачи
  await something();
  Scope.current();          // undefined без AsyncContext, scope там, где он есть
});
scope.enter(() => Scope.current());   // явный вход
```

Правило: пробрасывайте скоуп аргументом, а `Scope.current()` используйте для диагностики и в
местах, где аргумент физически не пробросить.

```ts
Scope.profiling = true;   // в dev
// Performance-панель DevTools: measure 'scopekit:page/loadUser' с detail { scope, task, status }
// и 'scopekit:page' на время жизни скоупа
```
