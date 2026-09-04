# nursery

Structured concurrency, cancellation and async utilities for the browser, built on the
platform's own `AbortSignal`, `Promise` and `AsyncIterable`. Zero runtime dependencies,
tree-shakeable, typed with TypeScript 7.

Russian documentation: [README.ru.md](README.ru.md). Recipes (in Russian):
[cookbook/](cookbook/README.md).

> npm names: the core is `@nursery/core`, framework adapters are `@nursery/react`,
> `@nursery/vue`, `@nursery/solid`, `@nursery/svelte`, `@nursery/angular`.

## Why

The browser gives you `AbortSignal` and promises, and stops there. What is missing:

- **Structured concurrency.** `Promise.all` rejects on the first failure but leaves the other
  promises running. Nothing ties a group of tasks to a lifetime.
- **Cancellation ergonomics.** Threading `signal` through every layer by hand, combining
  several reasons for cancellation, telling an abort from a real error.
- **Races.** A stale search response overwriting the fresh one.
- **Events as streams.** `EventTarget` cannot be iterated; debounce and throttle are userland.
- **Main-thread scheduling.** Chunking heavy loops, priorities, idle time.
- **Batteries for `fetch` and `Worker`.** Timeouts, retries, deduplication, SSE with auth
  headers, cancellation that reaches the worker, callbacks and transferables.

nursery is a thin layer that fills those gaps without inventing a new abstraction: every
function accepts and returns platform types.

## Install

```bash
npm i @nursery/core
npm i @nursery/react   # or vue / solid / svelte / angular
```

Every module is also a subpath, which guarantees tree-shaking in any bundler:

```ts
import { Nursery } from '@nursery/core';
import { debounce } from '@nursery/core/iter';
import { createHttp } from '@nursery/core/http';
```

## The one rule

Any async function that waits for the network, a timer or an event takes an `AbortSignal`.
Everything else follows from that.

## Nursery

```ts
import { Nursery, contextKey } from '@nursery/core/nursery';

const TraceId = contextKey<string>('traceId');

await using nursery = new Nursery({ name: 'dashboard', timeout: 10_000, ctx: [TraceId.with('t-1')] });
const user  = nursery.spawn(sig => api.user(id, sig), { name: 'user' });
const posts = nursery.spawn((sig, s) => api.posts(id, sig, s.get(TraceId)), { name: 'posts' });
render(await user, await posts);
// leaving the block closes the nursery: unfinished work is cancelled, cleanups run
```

- Tasks run in parallel. The first non-abort failure cancels the siblings (fail-fast) with an
  `AbortError` whose `cause` is the original error.
- `close()` (or `await using`) aborts what is still running, waits for it, then runs `defer`
  callbacks in reverse order. `close({ grace })` stops waiting for tasks that ignore their signal
  and reports them.
- `child()` inherits context, cancellation and deadline. `Nursery.run(body)` is the same without
  `await using`.
- Typed context: `contextKey`, `key.with(value)`, `nursery.get(key)`. A stand-in for AsyncContext.
- Observability: `nursery.tasks`, `nursery.children`, `nursery.dump()`, `Nursery.onUnhandled(cb)` for
  failures nobody awaited, `Nursery.profiling = true` for `performance.measure` entries.

## Modules

| Module | Exports |
|---|---|
| `signal` | `isAbort`, `abortError`, `timeoutError`, `throwIfAborted`, `anySignal`, `linkSignals`, `timeoutSignal`, `sleep` |
| `combine` | `withTimeout`, `retry` (backoff, jitter, `attemptTimeout`, `retryOn`, `onRetry`), `race` (losers cancelled), `settle` |
| `limit` | `Semaphore`, `Mutex`, `map`, `mapSettled`, `Queue` (priority, pause/resume) |
| `latest` | `latest`, `latestBy`, `singleFlight` |
| `nursery` | `Nursery`, `contextKey`, `NurseryClosedError`, `NurseryStuckError` |
| `events` | `on` (typed by event map), `Channel` (Go-style, backpressure, `select`, `trySend`/`tryReceive`) |
| `iter` | `pipe`, `map`, `filter`, `take`, `buffer`, `debounce`, `throttle`, `distinctUntilChanged`, `scan`, `tap`, `merge`, `zip`, `combineLatest`, `share`, `flatMap`, `timeout`, `fromReadableStream`, `toArray` |
| `schedule` | `yieldToMain`, `postTask` (priorities), `idle`, `frame`, `frameInterval`, `chunked` (auto budget from the display refresh rate) |
| `http` | `createHttp`: required owner (`signal` or `nursery`), per-attempt timeout, deadline, retry with `Retry-After`, GET dedupe, hooks, schema `parse`, progress, `stream` (NDJSON), `sse` with reconnect |
| `worker` | `expose`, `wrap`, `transfer`, `callback`, `createPool`; `AbortSignal` reaches the worker |
| `diagnostics` | `onWarning` for backlog warnings |
| `testing` | `fakeFetch`, `jsonResponse`, `streamResponse`, `tick`, `settle`, `expectAborted`, `fakeClock`, `mockWorker`, `portPair` |

## Highlights

```ts
// no stale results: a newer call aborts the previous one
const search = latest((q: string, sig) => http.get<Item[]>('/search', { signal: sig, query: { q } }));

// events as a stream, cancelled by the nursery
for await (const e of pipe(on(input, 'input', { signal: nursery.signal }), debounce(300))) search(e.target.value);

// bounded concurrency, order preserved, fail-fast
const thumbs = await map(files, (f, _i, sig) => makeThumb(f, sig), { concurrency: 4, signal: nursery.signal });

// heavy loop that keeps the UI responsive
for await (const row of chunked(rows, { signal })) table.append(renderRow(row));

// worker calls that can be cancelled and report progress
const ast = await parser.parse(src, { signal, onProgress: callback(setProgress) });
```

## Frameworks

```ts
import { useAsync, useLatest, useEventStream } from '@nursery/react';
const orders = useAsync(nursery => http.get<Order[]>('/orders', { nursery }), [userId]);
```

The same primitives exist for Vue (`useAsync`, `useNurseryWatch`), Solid (`createAsync`,
`nurseryEffect`), Svelte 5 (`asyncStore`, `nurseryEffect` for `$effect`) and Angular
(`injectAsync`, `nurseryEffect`). Each adapter is a separate package with the framework as a
peer dependency; all of them are tested in a real browser, including React StrictMode.

## Compatibility

- ESM only. Node 22+ for tooling; the library targets evergreen browsers.
- Core entries (`nursery`, `signal`, `combine`, `limit`, `latest`, `iter`) compile with
  `@types/node` alone. DOM-dependent entries reference the DOM lib themselves.
- `await using` needs TypeScript 5.2+ and a transpiler that lowers it; `Nursery.run` is the
  equivalent without syntax support.
- Compiled with TypeScript 7 (the native Go compiler).

## Development

```bash
npm run check   # oxfmt --check, oxlint, typecheck, tests (node + chromium), build, package checks
npm run format
```

## License

MIT
