# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow SemVer.
All packages in the monorepo share one version.

## [1.0.0-rc.1] - 2026-09-05

First release candidate. Packages: `@nursery/core`, `@nursery/react`, `@nursery/vue`,
`@nursery/solid`, `@nursery/svelte`, `@nursery/angular`.

### Core
- `Nursery`: structured concurrency with fail-fast, `defer`, child nurseries, typed context,
  deadlines, `close({ grace })`, `Nursery.onUnhandled`, `Nursery.current()`, profiling, `dump()`.
- `signal`, `combine` (`withTimeout`, `retry`, `race`, `settle`), `limit` (`Semaphore`, `Mutex`,
  `map`, `mapSettled`, `Queue`), `latest` (`latest`, `latestBy`, `singleFlight`).
- `events` (`on`, `Channel`, `select`), `iter` operators, `schedule` (`yieldToMain`, `postTask`,
  `idle`, `frame`, `chunked`).
- `http`: owner-required fetch client with timeouts, deadlines, retry, dedupe, hooks, schema
  parsing, progress, NDJSON streams and SSE with reconnect.
- `worker`: `expose`/`wrap` with cancellation, callbacks and transferables at any depth,
  `createPool`.
- `diagnostics` warnings and a `testing` module.

### Adapters
- React, Vue, Solid, Svelte 5 and Angular bindings tested in a real browser.
