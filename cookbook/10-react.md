# React

Идея одна: **скоуп живёт столько же, сколько эффект**. Всё остальное это хуки поверх этого.

```ts
import { useEffect, useState, useRef, useCallback, useSyncExternalStore, type DependencyList } from 'react';
import { Scope, type ScopeOptions } from 'scopekit/scope';
import { latest } from 'scopekit/latest';
import { isAbort } from 'scopekit/signal';
import { on } from 'scopekit/events';
```

## useScopedEffect: базовый хук

```ts
export function useScopedEffect(
  effect: (scope: Scope) => void | Promise<void>,
  deps: DependencyList,
  opts?: ScopeOptions,
) {
  useEffect(() => {
    const scope = new Scope(opts);
    Promise.resolve(effect(scope)).catch(err => {
      if (!isAbort(err)) reportError(err);
    });
    return () => {
      void scope.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
```

Что это даёт:

- Каждый запуск эффекта получает новый скоуп, предыдущий закрывается в cleanup. Запросы
  прошлого запуска отменяются, их ответы не попадут в состояние.
- StrictMode в dev монтирует дважды: первый скоуп закроется, второй будет работать. Ничего
  специального делать не нужно.
- Ошибки, кроме отмены, уходят в `reportError` (глобальный `error` event), а не теряются.

Использование:

```tsx
function UserCard({ id }: { id: string }) {
  const [user, setUser] = useState<User | null>(null);

  useScopedEffect(async scope => {
    const u = await http.get<User>(`/users/${id}`, { signal: scope.signal });
    setUser(u);          // после unmount сюда не дойдём: запрос отменён, await бросил
  }, [id]);

  return user ? <Card user={user} /> : <Skeleton />;
}
```

Никаких `let cancelled = false`, никаких `if (!cancelled) setUser(u)`.

## useAsync: загрузка с состоянием

```ts
type AsyncState<T> =
  | { status: 'loading' }
  | { status: 'success'; data: T }
  | { status: 'error'; error: unknown };

export function useAsync<T>(fn: (scope: Scope) => Promise<T>, deps: DependencyList): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' });
  useScopedEffect(async scope => {
    setState({ status: 'loading' });
    try {
      setState({ status: 'success', data: await fn(scope) });
    } catch (error) {
      if (!isAbort(error)) setState({ status: 'error', error });
    }
  }, deps);
  return state;
}
```

```tsx
function Orders({ userId }: { userId: string }) {
  const orders = useAsync(scope => http.get<Order[]>('/orders', { signal: scope.signal, query: { userId } }), [userId]);
  if (orders.status === 'loading') return <Spinner />;
  if (orders.status === 'error') return <ErrorBox error={orders.error} />;
  return <OrderList orders={orders.data} />;
}
```

Параллельная загрузка с fail-fast бесплатно:

```tsx
const page = useAsync(async scope => {
  const profile = scope.spawn(sig => http.get<Profile>('/me', { signal: sig }));
  const feed = scope.spawn(sig => http.get<Post[]>('/feed', { signal: sig }));
  return { profile: await profile, feed: await feed };
}, []);
```

## useLatestCallback: поиск без гонок

Для действий, которые инициирует пользователь, а не рендер:

```ts
export function useLatestCallback<A, R>(fn: (arg: A, signal: AbortSignal) => Promise<R>) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const wrapped = useRef(latest<A, R>((arg, signal) => fnRef.current(arg, signal))).current;
  useEffect(() => () => wrapped.cancel(), [wrapped]);
  return wrapped;
}
```

```tsx
function Search() {
  const [results, setResults] = useState<Item[]>([]);
  const search = useLatestCallback((q: string, signal) => http.get<Item[]>('/search', { signal, query: { q } }));

  return (
    <>
      <input onChange={e => search(e.target.value).then(setResults).catch(ignoreAbort)} />
      {search.pending && <Spinner />}
      <List items={results} />
    </>
  );
}
```

Новый ввод отменяет предыдущий запрос, unmount отменяет последний. `search.pending`
читается при рендере, но не является реактивным. Для спиннера, который обновляется без
лишнего `setState`, см. `useLatestState` ниже.

## useLatestState: pending как состояние

```ts
export function useLatestState<A, R>(fn: (arg: A, signal: AbortSignal) => Promise<R>) {
  const [pending, setPending] = useState(false);
  const run = useLatestCallback(fn);
  const call = useCallback(async (arg: A) => {
    setPending(true);
    try {
      return await run(arg);
    } finally {
      if (!run.pending) setPending(false);   // false только когда никто не в полёте
    }
  }, [run]);
  return [call, pending] as const;
}
```

## useEventStream: события DOM как цикл

```ts
export function useEventStream<E extends Event>(
  target: EventTarget | null | undefined,
  type: string,
  handler: (e: E, scope: Scope) => void | Promise<void>,
  deps: DependencyList = [],
) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useScopedEffect(async scope => {
    if (!target) return;
    for await (const e of on<E>(target, type, { signal: scope.signal })) {
      await handlerRef.current(e, scope);
    }
  }, [target, type, ...deps]);
}
```

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

  useScopedEffect(async scope => {
    for await (const latestDoc of pipe(changes, debounce(800))) {
      await http.put('/draft', { signal: scope.signal, body: { doc: latestDoc } }).catch(ignoreAbort);
    }
  }, [changes]);

  return null;
}
```

## Воркер в компоненте

```ts
export function useWorker<T>(factory: () => Worker) {
  const [remote] = useState(() => {
    const worker = factory();
    return { worker, api: wrap<T>(worker) };
  });
  useEffect(() => () => { remote.api[Symbol.dispose](); remote.worker.terminate(); }, [remote]);
  return remote.api;
}
```

```tsx
const parser = useWorker<typeof api>(() => new Worker(new URL('./parser.worker.ts', import.meta.url), { type: 'module' }));
const ast = useAsync(scope => parser.parse(src, { signal: scope.signal }), [src, parser]);
```

## Тяжёлый рендер списка без фриза

```tsx
function BigTable({ rows }: { rows: Row[] }) {
  const [rendered, setRendered] = useState<Row[]>([]);
  useScopedEffect(async scope => {
    const acc: Row[] = [];
    for await (const row of chunked(rows, { budget: 6, signal: scope.signal })) {
      acc.push(enrich(row));
      if (acc.length % 200 === 0) setRendered([...acc]);   // прогрессивный рендер
    }
    setRendered(acc);
  }, [rows]);
  return <Table rows={rendered} />;
}
```

## React Router loaders

Loader получает `request.signal`, который абортится при смене маршрута. Привяжите скоуп:

```ts
export async function loader({ params, request }: LoaderFunctionArgs) {
  return Scope.run(async scope => {
    const user = scope.spawn(sig => http.get<User>(`/users/${params.id}`, { signal: sig }));
    const posts = scope.spawn(sig => http.get<Post[]>(`/users/${params.id}/posts`, { signal: sig }));
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

Для сложного `queryFn` с несколькими запросами внутри используйте `Scope.run` с этим
сигналом. Retry и дедупликацию оставьте одному слою: либо Query, либо `http`, иначе
попытки перемножатся.

## Контекст скоупа через React Context

Скоуп страницы, к которому подключаются дочерние скоупы компонентов:

```tsx
const ScopeContext = createContext<Scope | null>(null);

export function ScopeProvider({ children, ...opts }: PropsWithChildren<ScopeOptions>) {
  const [scope] = useState(() => new Scope(opts));
  useEffect(() => () => { void scope.close(); }, [scope]);
  return <ScopeContext.Provider value={scope}>{children}</ScopeContext.Provider>;
}

export function useScopedEffectIn(effect: (scope: Scope) => void | Promise<void>, deps: DependencyList) {
  const parent = useContext(ScopeContext);
  useEffect(() => {
    const scope = parent ? parent.child() : new Scope();
    Promise.resolve(effect(scope)).catch(err => { if (!isAbort(err)) reportError(err); });
    return () => { void scope.close(); };
  }, deps);
}
```

Теперь `TraceId` и прочие ключи контекста доступны в любом компоненте через
`scope.get(TraceId)`, а закрытие провайдера отменяет всё дерево.

## Suspense и use()

React 19 `use(promise)` требует стабильный промис между рендерами. Кешируйте его по ключу
и отменяйте при удалении из кеша:

```ts
const cache = new Map<string, { promise: Promise<unknown>; scope: Scope }>();

export function suspend<T>(key: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  let entry = cache.get(key);
  if (!entry) {
    const scope = new Scope();
    entry = { scope, promise: scope.spawn(sig => fn(sig)) };
    cache.set(key, entry);
  }
  return entry.promise as Promise<T>;
}

export function invalidate(key: string) {
  const entry = cache.get(key);
  if (entry) { cache.delete(key); void entry.scope.close(); }
}
```

## Чек-лист для ревью React-кода

- В `useEffect` с запросом есть `scope.signal` или сигнал из `AbortController` с cleanup.
- Нет `isMounted`-флагов и `let cancelled = false`.
- Поиск и фильтры идут через `latest` или его хук.
- `setState` после `await` стоит там, где `await` бросит при отмене, то есть после
  отменяемой операции, а не после `sleep(0)` без сигнала.
