# Гонки состояния: latest и singleFlight

```ts
import { latest, singleFlight } from 'scopekit/latest';
```

## Проблема

Пользователь печатает «react»: уходят запросы для «r», «re», «rea» и так далее. Ответ на «re»
может прийти **после** ответа на «react» и перетереть правильный результат. Это самая
частая гонка в UI.

## latest: побеждает последний вызов

```ts
const search = latest((q: string, signal: AbortSignal) => api.search(q, signal));

input.addEventListener('input', () => {
  search(input.value).then(render).catch(ignoreAbort);
});
```

Каждый новый вызов абортит предыдущий в полёте. Старый промис отвергается `AbortError`,
поэтому `render` для него никогда не вызовется. Не нужно сравнивать `requestId`, не нужен
флаг `isLatest`.

`search.pending` показывает, идёт ли запрос сейчас, `search.cancel()` отменяет текущий:

```ts
clearButton.onclick = () => { search.cancel(); render([]); };
spinner.hidden = !search.pending;
```

Внешний сигнал складывается с внутренним:

```ts
search(q, scope.signal);   // отменится и при новом вызове, и при закрытии скоупа
```

## latest + debounce

Debounce уменьшает число запросов, `latest` защищает от гонки тех, что всё же ушли. Нужны
оба:

```ts
for await (const e of iter.pipe(on<InputEvent>(input, 'input', { signal }), iter.debounce(250))) {
  search((e.target as HTMLInputElement).value).then(render).catch(ignoreAbort);
}
```

## latest по ключу

«Последний» часто нужен не глобально, а на каждую сущность: открыто пять карточек, у каждой
свой «последний запрос деталей».

```ts
const detailLoaders = new Map<string, ReturnType<typeof latest<void, Detail>>>();

function loadDetail(id: string, signal: AbortSignal) {
  let loader = detailLoaders.get(id);
  if (!loader) {
    loader = latest((_: void, sig) => api.detail(id, sig));
    detailLoaders.set(id, loader);
  }
  return loader(undefined, signal);
}
```

## singleFlight: один запрос на N одинаковых вызовов

Пять компонентов на экране одновременно просят `/me`. Уйти должен один запрос.

```ts
const loadMe = singleFlight((_: void) => api.me());

// пять вызовов за один тик → один HTTP-запрос, пять одинаковых результатов
await Promise.all([loadMe(), loadMe(), loadMe()]);
```

Ключ по умолчанию это сам аргумент, для объектов задайте `key`:

```ts
const loadUser = singleFlight((p: { id: string; fields: string[] }) => api.user(p.id, p.fields), {
  key: p => `${p.id}:${p.fields.join(',')}`,
});
```

После завершения ничего не кешируется: следующий вызов пойдёт в сеть снова. Это
дедупликация, а не кеш. Для кеша с TTL и инвалидацией берите TanStack Query или SWR, они
как раз про это, а `singleFlight` пригодится внутри их `queryFn`.

Ошибка не «залипает»: если общий полёт упал, следующий вызов сделает новую попытку.

## singleFlight и отмена

`singleFlight` не принимает сигнал: если один из подписчиков отменился, остальным результат
всё ещё нужен. Отмена делается снаружи, на стороне вызывающего:

```ts
const p = loadMe();
// подписчик ушёл, но запрос продолжает жить для остальных
```

Нужна отмена общего запроса, когда ушли **все** подписчики? Так работает дедупликация в
`scopekit/http`: там считаются подписчики и общий `fetch` абортится на нулевом счётчике.

## Ещё один вариант гонки: «сохранить, потом перечитать»

Нажали «сохранить» дважды. Второй save должен подождать первого, а не гнаться с ним.
Это не `latest`, а очередь с `concurrency: 1`:

```ts
const saves = new Queue({ concurrency: 1 });
saveButton.onclick = () => saves.add(sig => api.save(form.value, sig));
```

## Сводка

| Ситуация | Инструмент |
|---|---|
| Новый ввод делает старый ответ ненужным | `latest` |
| Много одинаковых одновременных запросов | `singleFlight` |
| Действия должны выполняться строго по очереди | `Queue({ concurrency: 1 })` |
| Первый из нескольких источников | `race` |
| Нужен кеш с TTL | TanStack Query / SWR поверх этих примитивов |

## latestBy: последний по ключу

```ts
import { latestBy } from 'scopekit/latest';

const loadDetail = latestBy((id: string) => id, (id, signal) => api.detail(id, signal));

loadDetail('a'); loadDetail('b'); loadDetail('a');   // отменён только первый 'a'
loadDetail.pending('a'); loadDetail.cancel('b'); loadDetail.cancel();
```

Ключи, у которых нет вызова в полёте, из внутренней карты удаляются, `size` показывает живые.
