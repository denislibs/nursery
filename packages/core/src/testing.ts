/// <reference lib="dom" />
/**
 * Test helpers for code built on nursery. Framework-agnostic; fakeClock() takes the test
 * runner's fake-timer object (vitest's `vi` works as is).
 */
import { expose, type PoolEndpoint } from './worker.js';
import { isAbort } from './signal.js';

// oxlint-disable-next-line typescript/no-explicit-any
type AnyFn = (...args: any[]) => any;

/** JSON Response with content-type set. */
export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(body), { status: 200, ...init, headers });
}

export function textResponse(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type')) headers.set('content-type', 'text/plain');
  return new Response(body, { status: 200, ...init, headers });
}

/** A byte stream that yields the given chunks (strings are UTF-8 encoded) then closes. */
export function textStream(chunks: readonly (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(typeof ch === 'string' ? enc.encode(ch) : ch);
      c.close();
    },
  });
}

/** Response whose body arrives in the given chunks; handy for NDJSON, SSE and progress tests. */
export function streamResponse(chunks: readonly (string | Uint8Array)[], init: ResponseInit = {}): Response {
  return new Response(textStream(chunks), { status: 200, ...init });
}

export interface FakeCall {
  url: string;
  method: string;
  init: RequestInit;
  headers: Headers;
  /** Request body, if it was a string / JSON. */
  body?: unknown;
}

export interface RouteContext {
  url: URL;
  params: Record<string, string>;
  init: RequestInit;
  call: FakeCall;
}

/** Handler result: a Response, or any value which is wrapped as a JSON 200. */
export type FakeHandler = (ctx: RouteContext) => unknown;
/** Keys look like "GET /users/:id"; a bare path matches any method. */
export type FakeRoutes = Record<string, FakeHandler>;

export interface FakeFetch {
  fetch: typeof fetch;
  calls: FakeCall[];
  reset(): void;
}

/**
 * A fetch double. Pass a single handler `(url, init) => Response | value` or a routes table.
 * Non-Response return values become JSON 200 responses. Unmatched routes get 404.
 */
export function fakeFetch(handler: ((url: string, init: RequestInit) => unknown) | FakeRoutes): FakeFetch {
  const calls: FakeCall[] = [];
  const routes = typeof handler === 'function' ? undefined : compileRoutes(handler);
  const toResponse = (v: unknown) => (v instanceof Response ? v : jsonResponse(v));
  const fetchFn: typeof fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init.method ?? 'GET').toUpperCase();
    const call: FakeCall = {
      url,
      method,
      init,
      headers: new Headers(init.headers),
      body: decodeBody(init.body),
    };
    calls.push(call);
    if (typeof handler === 'function') return toResponse(await handler(url, init));
    const parsed = new URL(url);
    for (const r of routes!) {
      if (r.method && r.method !== method) continue;
      const m = r.pattern.exec(parsed.pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1] ?? '')));
      return toResponse(await r.handler({ url: parsed, params, init, call }));
    }
    return jsonResponse({ error: 'no route' }, { status: 404 });
  };
  return { fetch: fetchFn, calls, reset: () => void calls.splice(0) };
}

function compileRoutes(routes: FakeRoutes) {
  return Object.entries(routes).map(([key, handler]) => {
    const [a, b] = key.split(' ');
    const method = b === undefined ? undefined : a!.toUpperCase();
    const path = b ?? a!;
    const keys: string[] = [];
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const source = escaped.replace(/:(\w+)/g, (_m, k: string) => {
      keys.push(k);
      return '([^/]+)';
    });
    return { method, pattern: new RegExp('^' + source + '$'), keys, handler };
  });
}

function decodeBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== 'string') return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

/** A macrotask hop. */
export const tick = (ms = 0): Promise<void> => new Promise(r => setTimeout(r, ms));

export type Settled<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown };

/** Attaches handlers right away (no unhandled rejection) and reports how the promise settled. */
export function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  return p.then(
    value => ({ status: 'fulfilled', value }),
    reason => ({ status: 'rejected', reason }),
  );
}

/** Resolves with the abort reason; throws if the promise fulfilled or failed with a non-abort error. */
export async function expectAborted(p: Promise<unknown>): Promise<unknown> {
  const s = await settle(p);
  if (s.status === 'fulfilled')
    throw new Error(`Expected an abort but the promise fulfilled with ${String(s.value)}`);
  if (!isAbort(s.reason)) throw s.reason;
  return s.reason;
}

/** The subset of vitest's `vi` (or a compatible object) that fakeClock() needs. */
export interface FakeTimerDriver {
  useFakeTimers(): unknown;
  useRealTimers(): unknown;
  advanceTimersByTimeAsync(ms: number): Promise<unknown>;
  runAllTimersAsync(): Promise<unknown>;
}

export interface FakeClock {
  install(): void;
  uninstall(): void;
  /** Advances fake time, flushing microtasks between timers. */
  tick(ms: number): Promise<void>;
  runAll(): Promise<void>;
  /** Captures a rejection before time advances, so it never counts as unhandled. */
  rejection<E = Error>(p: Promise<unknown>): Promise<E>;
}

/** Thin wrapper over fake timers that encodes the handler-before-advance rule. */
export function fakeClock(driver: FakeTimerDriver): FakeClock {
  return {
    install: () => void driver.useFakeTimers(),
    uninstall: () => void driver.useRealTimers(),
    tick: async ms => void (await driver.advanceTimersByTimeAsync(ms)),
    runAll: async () => void (await driver.runAllTimersAsync()),
    rejection: <E>(p: Promise<unknown>) =>
      p.then(
        v => {
          throw new Error(`Expected a rejection but the promise fulfilled with ${String(v)}`);
        },
        (e: E) => e,
      ),
  };
}

export interface PortPair {
  a: MessagePort;
  b: MessagePort;
  close(): void;
}

/** Two connected MessagePorts, for exercising expose()/wrap() without a Worker. */
export function portPair(): PortPair {
  const ch = new MessageChannel();
  return {
    a: ch.port1,
    b: ch.port2,
    close: () => {
      ch.port1.close();
      ch.port2.close();
    },
  };
}

export interface MockWorker extends PoolEndpoint {
  terminate(): void;
}

/**
 * An in-process stand-in for `new Worker(...)`: `api` runs on the other end of a MessageChannel,
 * so wrap(), createPool() and AbortSignal forwarding behave exactly as with a real worker.
 */
export function mockWorker(api: Record<string, AnyFn>): MockWorker {
  const ch = new MessageChannel();
  const stop = expose(api, ch.port1);
  const port = ch.port2 as unknown as MockWorker;
  port.terminate = () => {
    stop();
    ch.port1.close();
    ch.port2.close();
  };
  return port;
}
