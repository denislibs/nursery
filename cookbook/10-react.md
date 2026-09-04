# React

Хуки поставляются как `@nursery/react`. Идея одна: **nursery живёт столько же, сколько эффект**,
всё остальное надстройки.

```ts
import { NurseryProvider, useNursery, useNurseryEffect, useAsync, useLatest, useEventStream, useWorker } from '@nursery/react';
import { useState, useEffect, useRef } from 'react';
import { Nursery } from '@nursery/core/nursery';
import { Channel } from '@nursery/core/events';
import { pipe, debounce } from '@nursery/core/iter';
import { chunked } from '@nursery/core/schedule';
import { isAbort } from '@nursery/core/signal';
```

| Хук | Что делает |
|---|---|
| `useNurseryEffect(fn, deps)` | `useEffect`, где `fn` получает `Nursery`; предыдущий nursery закрывается на cleanup |
| `useAsync(fn, deps)` | `{ status: 'loading' \| 'success' \| 'error' }`, результат отменённого запуска не попадает в state |
| `useLatest(fn)` | `{ run, pending, cancel }`: новый `run` отменяет прошлый, unmount отменяет последний |
| `useEventStream(target, type, handler)` | события DOM в цикле `for await`, handler может быть async |
| `useNursery()` | nursery на время монтирования, ребёнок ближайшего `NurseryProvider` |
| `NurseryProvider` | родительский nursery для всего поддерева, даёт контекст и общую отмену |
| `useWorker(factory)` | воркер создаётся один раз, `terminate` на unmount |

Ошибки эффектов, кроме отмены, уходят в `Nursery.onUnhandled`. StrictMode в dev монтирует дважды,
хуки это учитывают: первый nursery закрывается, второй работает.

## useNurseryEffect: базовый хук

`useNurseryEffect(fn, deps)` это `useEffect`, где `fn` получает `Nursery`. Каждый запуск эффекта
получает новый nursery, предыдущий закрывается в cleanup, поэтому ответы устаревшего запуска в
состояние не попадают. Ошибки, кроме отмены, уходят в `Nursery.onUnhandled`.


Что это даёт:

- Каждый запуск эффекта получает новый nursery, предыдущий закрывается в cleanup. Запросы
  прошлого запуска отменяются, их ответы не попадут в состояние.
- StrictMode в dev монтирует дважды: первый nursery закроется, второй будет работать. Ничего
  специального делать не нужно.
- Ошибки, кроме отмены, уходят в `reportError` (глобальный `error` event), а не теряются.

Использование:

```tsx
function UserCard({ id }: { id: string }) {
  const [user, setUser] = useState<User | null>(null);

  useNurseryEffect(async nursery => {
    const u = await http.get<User>(`/users/${id}`, { signal: nursery.signal });
    setUser(u);          // после unmount сюда не дойдём: запрос отменён, await бросил
  }, [id]);

  return user ? <Card user={user} /> : <Skeleton />;
}
```

Никаких `let cancelled = false`, никаких `if (!cancelled) setUser(u)`.

## useAsync: загрузка с состоянием

`useAsync(fn, deps)` возвращает `{ status: 'loading' } | { status: 'success', data } | { status: 'error', error }`.


```tsx
function Orders({ userId }: { userId: string }) {
  const orders = useAsync(nursery => http.get<Order[]>('/orders', { signal: nursery.signal, query: { userId } }), [userId]);
  if (orders.status === 'loading') return <Spinner />;
  if (orders.status === 'error') return <ErrorBox error={orders.error} />;
  return <OrderList orders={orders.data} />;
}
```

Параллельная загрузка с fail-fast бесплатно:

```tsx
const page = useAsync(async nursery => {
  const profile = nursery.spawn(sig => http.get<Profile>('/me', { signal: sig }));
  const feed = nursery.spawn(sig => http.get<Post[]>('/feed', { signal: sig }));
  return { profile: await profile, feed: await feed };
}, []);
```

## useLatest: поиск без гонок

Для действий, которые инициирует пользователь, а не рендер:

```tsx
function Search() {
  const [results, setResults] = useState<Item[]>([]);
  const { run: search, pending } = useLatest((q: string, signal) => http.get<Item[]>('/search', { signal, query: { q } }));

  return (
    <>
      <input onChange={e => search(e.target.value).then(setResults).catch(ignoreAbort)} />
      {pending && <Spinner />}
      <List items={results} />
    </>
  );
}
```

Новый ввод отменяет предыдущий запрос, unmount отменяет последний. `pending` реактивный:
становится `false`, только когда ни один вызов не в полёте.

## useEventStream: события DOM как цикл


```tsx
useEventStream<KeyboardEvent>(window, 'keydown', e => {
  if (e.key === 'Escape') close();
});
```

Обработчик с `await` внутри не теряет события: они буферизуются.

## Debounce ввода через iter

```tsx
function AutoSave({ doc }: { doc: string }) {
  const docRef = useRef(doc);
  docRef.current = doc;
  const changes = useRef(new Channel<string>(100)).current;

  useEffect(() => { void changes.send(doc); }, [doc, changes]);

  useNurseryEffect(async nursery => {
    for await (const latestDoc of pipe(changes, debounce(800))) {
      await http.put('/draft', { signal: nursery.signal, body: { doc: latestDoc } }).catch(ignoreAbort);
    }
  }, [changes]);

  return null;
}
```

## Воркер в компоненте

`useWorker(factory)` создаёт воркер один раз на монтирование и делает `terminate` на unmount.


```tsx
const parser = useWorker<typeof api>(() => new Worker(new URL('./parser.worker.ts', import.meta.url), { type: 'module' }));
const ast = useAsync(nursery => parser.parse(src, { signal: nursery.signal }), [src, parser]);
```

## Тяжёлый рендер списка без фриза

```tsx
function BigTable({ rows }: { rows: Row[] }) {
  const [rendered, setRendered] = useState<Row[]>([]);
  useNurseryEffect(async nursery => {
    const acc: Row[] = [];
    for await (const row of chunked(rows, { signal: nursery.signal })) {
      acc.push(enrich(row));
      if (acc.length % 200 === 0) setRendered([...acc]);   // прогрессивный рендер
    }
    setRendered(acc);
  }, [rows]);
  return <Table rows={rendered} />;
}
```

## React Router loaders

Loader получает `request.signal`, который абортится при смене маршрута. Привяжите nursery:

```ts
export async function loader({ params, request }: LoaderFunctionArgs) {
  return Nursery.run(async nursery => {
    const user = nursery.spawn(sig => http.get<User>(`/users/${params.id}`, { signal: sig }));
    const posts = nursery.spawn(sig => http.get<Post[]>(`/users/${params.id}/posts`, { signal: sig }));
    return { user: await user, posts: await posts };
  }, { signal: request.signal, timeout: 15_000 });
}
```

## TanStack Query

`queryFn` получает `signal`. Пробрасывайте его, и отмена запросов при unmount заработает:

```ts
useQuery({
  queryKey: ['user', id],
  queryFn: ({ signal }) => http.get<User>(`/users/${id}`, { signal }),
});
```

Для сложного `queryFn` с несколькими запросами внутри используйте `Nursery.run` с этим
сигналом. Retry и дедупликацию оставьте одному слою: либо Query, либо `http`, иначе
попытки перемножатся.

## NurseryProvider: nursery страницы

```tsx
function Page() {
  const [nursery] = useState(() => new Nursery({ name: 'page', ctx: [TraceId.with(newTraceId())], grace: 5000 }));
  useEffect(() => () => { void nursery.close(); }, [nursery]);
  return <NurseryProvider nursery={nursery}><Dashboard /></NurseryProvider>;
}

function Dashboard() {
  const nursery = useNursery();                 // ребёнок nursery страницы
  const trace = nursery.get(TraceId);
  useNurseryEffect(async s => { /* s тоже ребёнок страницы */ }, []);
  return <Widget trace={trace} />;
}
```

Все хуки под провайдером создают дочерние nursery: контекст наследуется, закрытие nursery
страницы отменяет всё дерево, а `nursery.dump()` на странице показывает, какие компоненты и
задачи ещё живы.

## Suspense и use()

React 19 `use(promise)` требует стабильный промис между рендерами. Кешируйте его по ключу
и отменяйте при удалении из кеша:

```ts
const cache = new Map<string, { promise: Promise<unknown>; nursery: Nursery }>();

export function suspend<T>(key: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  let entry = cache.get(key);
  if (!entry) {
    const nursery = new Nursery();
    entry = { nursery, promise: nursery.spawn(sig => fn(sig)) };
    cache.set(key, entry);
  }
  return entry.promise as Promise<T>;
}

export function invalidate(key: string) {
  const entry = cache.get(key);
  if (entry) { cache.delete(key); void entry.nursery.close(); }
}
```

## Чек-лист для ревью React-кода

- В `useEffect` с запросом есть `nursery.signal` или сигнал из `AbortController` с cleanup.
- Нет `isMounted`-флагов и `let cancelled = false`.
- Поиск и фильтры идут через `latest` или его хук.
- `setState` после `await` стоит там, где `await` бросит при отмене, то есть после
  отменяемой операции, а не после `sleep(0)` без сигнала.
