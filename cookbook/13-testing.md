# Тестирование кода на scopekit

Библиотека проектировалась так, чтобы код на ней тестировался без моков сети и без
реального времени. Примеры на vitest, для jest отличия косметические.

## Фейковые таймеры

`sleep`, `retry`, `withTimeout`, `debounce`, `throttle`, `Scope({ timeout })` работают на
`setTimeout`, поэтому `vi.useFakeTimers()` делает их мгновенными и детерминированными.

```ts
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test('таймаут на попытку ретраится', async () => {
  let attempts = 0;
  const p = retry(async sig => {
    attempts++;
    if (attempts === 1) await sleep(10_000, sig);   // «зависла»
    return 'ok';
  }, { retries: 1, delay: 0, attemptTimeout: 100 });

  await vi.advanceTimersByTimeAsync(100);   // истёк attemptTimeout
  await vi.runAllTimersAsync();             // backoff
  await expect(p).resolves.toBe('ok');
  expect(attempts).toBe(2);
});
```

`advanceTimersByTimeAsync` вместо `advanceTimersByTime`: async-версия прогоняет микрозадачи
между таймерами, иначе промисы не продвинутся.

## Порядок: обработчик до продвижения времени

Промис, который отвергнется во время `advanceTimersByTimeAsync`, должен уже иметь
обработчик. Иначе vitest зарегистрирует unhandled rejection.

```ts
// плохо
const p = withTimeout(sig => sleep(1000, sig), 100);
await vi.advanceTimersByTimeAsync(100);        // p отвергся без обработчика
await expect(p).rejects.toThrow();

// хорошо
const expectation = expect(withTimeout(sig => sleep(1000, sig), 100)).rejects.toSatisfy(isAbort);
await vi.advanceTimersByTimeAsync(100);
await expectation;

// тоже хорошо
const p = withTimeout(sig => sleep(1000, sig), 100);
p.catch(() => {});
await vi.advanceTimersByTimeAsync(100);
await expect(p).rejects.toSatisfy(isAbort);
```

## Проверять отмену

Тест на «unmount отменяет запрос» пишется через сигнал, который дошёл до `fetch`:

```ts
test('закрытие скоупа отменяет запрос', async () => {
  let seen: AbortSignal | undefined;
  const http = createHttp({
    fetch: (_u, init) => new Promise((_r, rej) => {
      seen = init!.signal!;
      seen.addEventListener('abort', () => rej(seen!.reason));
    }),
  });
  const scope = new Scope();
  const p = scope.spawn(sig => http.get('/x', { signal: sig }));
  await scope.close();
  await expect(p).rejects.toSatisfy(isAbort);
  expect(seen!.aborted).toBe(true);
});
```

## Проверять fail-fast

```ts
test('ошибка одного отменяет остальных', async () => {
  let siblingAborted = false;
  await expect(Scope.run(async scope => {
    scope.spawn(async () => { throw new Error('boom'); });
    await scope.spawn(sig => sleep(1000, sig).catch(e => { siblingAborted = isAbort(e); throw e; }));
  })).rejects.toThrow('boom');
  expect(siblingAborted).toBe(true);
});
```

## Проверять latest

```ts
test('старый ответ не перетирает новый', async () => {
  vi.useFakeTimers();
  const delays: Record<string, number> = { a: 100, ab: 10 };
  const search = latest(async (q: string, sig) => { await sleep(delays[q]!, sig); return q; });
  const results: string[] = [];

  search('a').then(r => results.push(r)).catch(ignoreAbort);
  search('ab').then(r => results.push(r)).catch(ignoreAbort);
  await vi.runAllTimersAsync();

  expect(results).toEqual(['ab']);
});
```

## http без сети

Передайте `fetch` в `createHttp`. Ответы стройте через `Response`, он есть в Node 18+ и в
браузере:

```ts
const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, ...init });

const calls: string[] = [];
const http = createHttp({
  retry: { retries: 2, delay: 0 },
  fetch: async input => {
    calls.push(String(input));
    return calls.length === 1 ? json({}, { status: 503 }) : json({ ok: true });
  },
});
const p = http.get('/x', { signal: new AbortController().signal });
await vi.runAllTimersAsync();
await expect(p).resolves.toEqual({ ok: true });
expect(calls).toHaveLength(2);
```

Ретраи, `Retry-After`, дедупликация проверяются так же, полный набор в `test/http.test.ts`.

## Воркеры без браузера

`MessageChannel` в Node достаточно для протокола `wrap`/`expose`:

```ts
const { port1, port2 } = new MessageChannel();
const stop = expose(api, port1);
const remote = wrap<typeof api>(port2);
try {
  await expect(remote.add(2, 3)).resolves.toBe(5);
} finally {
  remote[Symbol.dispose](); stop(); port1.close(); port2.close();
}
```

## Компоненты React

Скоуп внутри `useScopedEffect` закрывается при unmount, поэтому Testing Library не оставит
висящих запросов:

```tsx
const http = createHttp({ fetch: async () => json({ name: 'Ann' }) });
render(<UserCard id="1" />);
expect(await screen.findByText('Ann')).toBeInTheDocument();
```

Для теста «ушли до ответа» используйте `fetch`, который никогда не резолвится, `unmount()`
и проверяйте, что сигнал абортился.

## Настоящий браузер

Node эмулирует `AbortSignal`, `DOMException`, `Response`, `MessageChannel`, но не `Worker`,
не DOM и не `scheduler.yield`. Для них vitest browser mode с Playwright, конфиг в
`vitest.config.ts` этого репозитория: тот же набор тестов гоняется и в Node, и в Chromium.

## scopekit/testing

Хелперы, которые иначе приходится писать в каждом проекте:

```ts
import { fakeFetch, jsonResponse, streamResponse, mockWorker, expectAborted, settle, fakeClock, tick } from 'scopekit/testing';

const f = fakeFetch({
  'GET /users/:id': ({ params }) => ({ id: params.id }),               // объект → JSON 200
  'POST /users': () => jsonResponse({ ok: true }, { status: 201 }),
  '/events': () => streamResponse(['data: a\n\n', 'data: b\n\n'], { headers: { 'content-type': 'text/event-stream' } }),
});
const http = createHttp({ fetch: f.fetch });
f.calls[0].headers.get('authorization');

const remote = wrap<typeof api>(mockWorker(api));   // тот же протокол, без Worker
const pool = createPool(() => mockWorker(api), { size: 2 });

const reason = await expectAborted(promise);         // бросит, если промис не был отменён
const clock = fakeClock(vi);
clock.install();
const rejection = clock.rejection(retry(...));       // обработчик навешен до продвижения времени
await clock.tick(1000);
expect((await rejection).message).toBe('...');
clock.uninstall();
```
