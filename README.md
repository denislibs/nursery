# scopekit

Structured concurrency, cancellation and async utilities for the browser, built on the
platform's own `AbortSignal`, `Promise` and `AsyncIterable`. Zero runtime dependencies,
tree-shakeable, typed with TypeScript 7.

Russian documentation: [README.ru.md](README.ru.md). Recipes (in Russian):
[cookbook/](cookbook/README.md).

> npm names: the core is `@scopekit/core`, framework adapters are `@scopekit/react`,
> `@scopekit/vue`, `@scopekit/solid`, `@scopekit/svelte`, `@scopekit/angular`.

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

scopekit is a thin layer that fills those gaps without inventing a new abstraction: every
function accepts and returns platform types.

## Install

```bash
npm i @scopekit/core
npm i @scopekit/react   # or vue / solid / svelte / angular
```

Every module is also a subpath, which guarantees tree-shaking in any bundler:

```ts
import { Scope } from '@scopekit/core';
import { debounce } from '@scopekit/core/iter';
import { createHttp } from '@scopekit/core/http';
```

## The one rule

Any async function that waits for the network, a timer or an event takes an `AbortSignal`.
Everything else follows from that.

## Scope

```ts
import { Scope, contextKey } from '@scopekit/core/scope';

const TraceId = contextKey<string>('traceId');

await using scope = new Scope({ name: 'dashboard', timeout: 10_000, ctx: [TraceId.with('t-1')] });
const user  = scope.spawn(sig => api.user(id, sig), { name: 'user' });
const posts = scope.spawn((sig, s) => api.posts(id, sig, s.get(TraceId)), { name: 'posts' });
render(await user, await posts);
// leaving the block closes the scope: unfinished work is cancelled, cleanups run
```

- Tasks run in parallel. The first non-abort failure cancels the siblings (fail-fast) with an
  `AbortError` whose `cause` is the original error.
- `close()` (or `await using`) aborts what is still running, waits for it, then runs `defer`
  callbacks in reverse order. `close({ grace })` stops waiting for tasks that ignore their signal
  and reports them.
- `child()` inherits context, cancellation and deadline. `Scope.run(body)` is the same without
  `await using`.
- Typed context: `contextKey`, `key.with(value)`, `scope.get(key)`. A stand-in for AsyncContext.
- Observability: `scope.tasks`, `scope.children`, `scope.dump()`, `Scope.onUnhandled(cb)` for
  failures nobody awaited, `Scope.profiling = true` for `performance.measure` entries.

## Modules

| Module | Exports |
|---|---|
| `signal` | `isAbort`, `abortError`, `timeoutError`, `throwIfAborted`, `anySignal`, `linkSignals`, `timeoutSignal`, `sleep` |
| `combine` | `withTimeout`, `retry` (backoff, jitter, `attemptTimeout`, `retryOn`, `onRetry`), `race` (losers cancelled), `settle` |
| `limit` | `Semaphore`, `Mutex`, `map`, `mapSettled`, `Queue` (priority, pause/resume) |
| `latest` | `latest`, `latestBy`, `singleFlight` |
| `scope` | `Scope`, `contextKey`, `ScopeClosedError`, `ScopeStuckError` |
| `events` | `on` (typed by event map), `Channel` (Go-style, backpressure, `select`, `trySend`/`tryReceive`) |
| `iter` | `pipe`, `map`, `filter`, `take`, `buffer`, `debounce`, `throttle`, `distinctUntilChanged`, `scan`, `tap`, `merge`, `zip`, `combineLatest`, `share`, `flatMap`, `timeout`, `fromReadableStream`, `toArray` |
| `schedule` | `yieldToMain`, `postTask` (priorities), `idle`, `frame`, `chunked` |
| `http` | `createHttp`: required owner (`signal` or `scope`), per-attempt timeout, deadline, retry with `Retry-After`, GET dedupe, hooks, schema `parse`, progress, `stream` (NDJSON), `sse` with reconnect |
| `worker` | `expose`, `wrap`, `transfer`, `callback`, `createPool`; `AbortSignal` reaches the worker |
| `diagnostics` | `onWarning` for backlog warnings |
| `testing` | `fakeFetch`, `jsonResponse`, `streamResponse`, `tick`, `settle`, `expectAborted`, `fakeClock`, `mockWorker`, `portPair` |

## Highlights

```ts
// no stale results: a newer call aborts the previous one
const search = latest((q: string, sig) => http.get<Item[]>('/search', { signal: sig, query: { q } }));

// events as a stream, cancelled by the scope
for await (const e of pipe(on(input, 'input', { signal: scope.signal }), debounce(300))) search(e.target.value);

// bounded concurrency, order preserved, fail-fast
const thumbs = await map(files, (f, _i, sig) => makeThumb(f, sig), { concurrency: 4, signal: scope.signal });

// heavy loop that keeps the UI responsive
for await (const row of chunked(rows, { budget: 8, signal })) table.append(renderRow(row));

// worker calls that can be cancelled and report progress
const ast = await parser.parse(src, { signal, onProgress: callback(setProgress) });
```

## Frameworks

```ts
import { useAsync, useLatest, useEventStream } from '@scopekit/react';
const orders = useAsync(scope => http.get<Order[]>('/orders', { scope }), [userId]);
```

The same primitives exist for Vue (`useAsync`, `useScopedWatch`), Solid (`createAsync`,
`scopedEffect`), Svelte 5 (`asyncStore`, `scopedEffect` for `$effect`) and Angular
(`injectAsync`, `scopedEffect`). Each adapter is a separate package with the framework as a
peer dependency; all of them are tested in a real browser, including React StrictMode.

## Compatibility

- ESM only. Node 22+ for tooling; the library targets evergreen browsers.
- Core entries (`scope`, `signal`, `combine`, `limit`, `latest`, `iter`) compile with
  `@types/node` alone. DOM-dependent entries reference the DOM lib themselves.
- `await using` needs TypeScript 5.2+ and a transpiler that lowers it; `Scope.run` is the
  equivalent without syntax support.
- Compiled with TypeScript 7 (the native Go compiler).

## Development

```bash
npm run check   # oxfmt --check, oxlint, typecheck, tests (node + chromium), build, package checks
npm run format
```

## License

MIT
