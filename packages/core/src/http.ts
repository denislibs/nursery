/// <reference lib="dom" />
import { retry, type RetryOptions } from './combine.js';
import { abortError, anySignal, isAbort, sleep, timeoutError, timeoutSignal } from './signal.js';
import { fromReadableStream } from './iter.js';
import type { Nursery } from './nursery.js';

export type QueryValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | QueryValue[]
  | { [key: string]: QueryValue };
export type Query = Record<string, QueryValue>;

export type RequestHook = (
  url: string,
  init: RequestInit,
) =>
  | void
  | Partial<{ url: string; init: RequestInit }>
  | Promise<void | Partial<{ url: string; init: RequestInit }>>;

/** A function or a zod-like object that validates/transforms the parsed body. */
export type Parser<T> = ((raw: unknown) => T) | { parse: (raw: unknown) => T };

export interface RequestHookContext {
  url: string;
  init: RequestInit;
  /** 0 for the first attempt. */
  attempt: number;
}

export interface HttpOptions {
  baseUrl?: string;
  /** Per-attempt timeout in ms. */
  timeout?: number;
  /** Default retry policy for idempotent methods. Off by default. */
  retry?: Omit<RetryOptions, 'signal' | 'attemptTimeout'>;
  /** Statuses that trigger a retry. Default: 408, 425, 429, 500, 502, 503, 504. */
  retryStatuses?: readonly number[];
  /** Methods retried by default. Default: GET, HEAD, OPTIONS, PUT, DELETE. */
  idempotentMethods?: readonly string[];
  /** Share one fetch between identical concurrent GET/HEAD requests. Default true. */
  dedupe?: boolean;
  headers?: HeadersInit;
  fetch?: typeof fetch;
  /** Runs before every attempt (a single hook or a chain). May return a replacement url and/or init. */
  onRequest?: RequestHook | RequestHook[];
  /** Turns `query` into a query string. Default: bracket notation for objects, repeated keys for arrays. */
  querySerializer?: (query: Query) => string | URLSearchParams;
  /** Runs after every attempt's response, before retry decisions. May return a replacement Response. */
  onResponse?: (res: Response, ctx: RequestHookContext) => void | Response | Promise<void | Response>;
}

/** Every request needs an owner: an explicit signal, a Nursery, or both. */
export type RequestOwner =
  | { signal: AbortSignal; nursery?: Nursery }
  | { nursery: Nursery; signal?: AbortSignal };

export interface RequestCommon<T = unknown> extends Omit<RequestInit, 'signal' | 'body' | 'method'> {
  method?: string;
  /** Overrides the client baseUrl for this request. */
  baseUrl?: string;
  /** Plain objects and arrays are JSON-encoded; everything fetch accepts is passed through. */
  body?: unknown;
  query?: Query;
  /** Called as response bytes arrive. `total` comes from Content-Length when present. */
  onDownloadProgress?: (loaded: number, total: number | undefined) => void;
  /** Streams the request body (duplex: 'half') and reports bytes sent. Chromium and Node; elsewhere reports once at the end. */
  onUploadProgress?: (sent: number, total: number) => void;
  timeout?: number;
  /** Absolute performance.now() deadline; shortens the timeout and stops retries. Defaults to nursery.deadline. */
  deadline?: number;
  /** Retry policy for this request. Setting it enables retry even for non-idempotent methods. */
  retry?: Omit<RetryOptions, 'signal' | 'attemptTimeout'>;
  dedupe?: boolean;
  /** Validates/transforms the parsed body. Errors thrown here reject the request. */
  parse?: Parser<T>;
}

export type RequestOptions<T = unknown> = RequestOwner & RequestCommon<T>;
export type BodyOptions<T = unknown> = RequestOwner & Omit<RequestCommon<T>, 'method'>;

export interface StreamOptions extends Omit<RequestCommon, 'parse' | 'dedupe'> {}
export interface SseReconnect {
  /** Initial wait before reconnecting; a server `retry:` field overrides it. Default 1000. */
  delay?: number;
  /** Upper bound for the wait. Default 30000. */
  maxDelay?: number;
  /** Backoff multiplier applied after each failed reconnect attempt. Default 2. */
  factor?: number;
  /** Decide whether an error is worth reconnecting on. Default: network errors, timeouts, 408/425/429/5xx. */
  retryOn?: (err: unknown) => boolean;
  /** Observes each wait: the error that caused it (undefined for a clean stream end), the attempt, the delay. */
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

export interface SseOptions extends StreamOptions {
  /**
   * Reconnect when the stream ends or fails (network error, timeout, retryable status),
   * sending Last-Event-ID and backing off between failed attempts. Off by default.
   */
  reconnect?: SseReconnect;
}

export interface SseEvent {
  id?: string;
  event: string;
  data: string;
  /** Server-suggested reconnection delay in ms, when the event carried a retry: field. */
  retry?: number;
}

export class HttpError extends Error {
  readonly status: number;
  readonly response: Response;
  readonly body: unknown;
  constructor(response: Response, body: unknown) {
    super(`HTTP ${response.status} ${response.statusText || ''}`.trim());
    this.name = 'HttpError';
    this.status = response.status;
    this.response = response;
    this.body = body;
  }
}

export interface Http {
  /** Raw Response, after retry and timeout; does not throw on non-2xx. */
  request(url: string, opts: RequestOptions): Promise<Response>;
  get<T = unknown>(url: string, opts: BodyOptions<T>): Promise<T>;
  head(url: string, opts: BodyOptions): Promise<Response>;
  post<T = unknown>(url: string, opts: BodyOptions<T>): Promise<T>;
  put<T = unknown>(url: string, opts: BodyOptions<T>): Promise<T>;
  patch<T = unknown>(url: string, opts: BodyOptions<T>): Promise<T>;
  delete<T = unknown>(url: string, opts: BodyOptions<T>): Promise<T>;
  /** Newline-delimited JSON as an AsyncIterable. Breaking out cancels the body. */
  stream<T = unknown>(url: string, opts: RequestOwner & StreamOptions): AsyncIterable<T>;
  /** Server-Sent Events over fetch (so auth headers work). Optional reconnect with Last-Event-ID. */
  sse(url: string, opts: RequestOwner & SseOptions): AsyncIterable<SseEvent>;
}

const DEFAULT_RETRY_STATUSES = [408, 425, 429, 500, 502, 503, 504];
const DEFAULT_IDEMPOTENT = ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'];

/** Thrown internally to route a retryable status through retry(). */
class RetryableStatus extends Error {
  /** What retry hooks see: status and a cloned response; the body is not parsed on the retry path. */
  readonly httpError: HttpError;
  constructor(readonly response: Response) {
    super(`Retryable status ${response.status}`);
    this.httpError = new HttpError(response.clone(), undefined);
  }
}

interface Flight {
  promise: Promise<Response>;
  ctrl: AbortController;
  subscribers: number;
}

export function createHttp(options: HttpOptions = {}): Http {
  const {
    baseUrl,
    timeout,
    retry: defaultRetry,
    retryStatuses = DEFAULT_RETRY_STATUSES,
    idempotentMethods = DEFAULT_IDEMPOTENT,
    dedupe: defaultDedupe = true,
    headers: defaultHeaders,
    fetch: fetchFn = globalThis.fetch,
    onRequest,
    onResponse,
    querySerializer = defaultQuerySerializer,
  } = options;
  const requestHooks: RequestHook[] =
    onRequest === undefined ? [] : Array.isArray(onRequest) ? onRequest : [onRequest];
  const flights = new Map<string, Flight>();

  function buildUrl(url: string, query: Query | undefined, base: string | undefined): string {
    const absolute = /^[a-z][a-z0-9+.-]*:/i.test(url);
    // relative paths resolve against baseUrl, else against the page (browsers), else it is an error
    const origin = base ?? (globalThis as { location?: { href?: string } }).location?.href;
    if (!absolute && !origin)
      throw new TypeError(`http: relative url "${url}" needs a baseUrl (no location to resolve against)`);
    const u = absolute
      ? new URL(url)
      : base
        ? new URL(url.replace(/^\//, ''), base.endsWith('/') ? base : base + '/')
        : new URL(url, origin);
    if (query) {
      const extra = new URLSearchParams(querySerializer(query));
      extra.forEach((v, k) => u.searchParams.append(k, v));
    }
    return u.href;
  }

  async function performOnce(
    url: string,
    init: RequestInit & { bodyFactory?: () => BodyInit },
    signal: AbortSignal,
    attempt: number,
  ): Promise<Response> {
    let finalUrl = url;
    const { bodyFactory, ...plain } = init;
    // a streamed body can be read once: build a fresh one for every attempt
    let finalInit: RequestInit = bodyFactory
      ? { ...plain, body: bodyFactory(), signal }
      : { ...plain, signal };
    for (const hook of requestHooks) {
      const patch = await hook(finalUrl, finalInit);
      if (patch?.url) finalUrl = patch.url;
      if (patch?.init) finalInit = { ...patch.init, signal };
    }
    let res = await fetchFn(finalUrl, finalInit);
    if (onResponse) res = (await onResponse(res, { url: finalUrl, init: finalInit, attempt })) ?? res;
    if (retryStatuses.includes(res.status)) throw new RetryableStatus(res);
    return res;
  }

  // hooks see an HttpError, not the internal marker
  const publicError = (err: unknown) => (err instanceof RetryableStatus ? err.httpError : err);

  function withRetry(
    url: string,
    init: RequestInit,
    policy: RequestCommon['retry'] | undefined,
    attemptTimeout: number | undefined,
    signal: AbortSignal,
  ): Promise<Response> {
    let attempt = 0;
    const run = (sig: AbortSignal) => performOnce(url, init, sig, attempt++);
    const task = policy
      ? retry(run, {
          ...policy,
          attemptTimeout,
          signal,
          onRetry: policy.onRetry ? (err, n, d) => policy.onRetry!(publicError(err), n, d) : undefined,
          retryOn: (err, n) => {
            if (err instanceof RetryableStatus) {
              const after = retryAfterMs(err.response);
              const custom = policy.retryOn?.(err.httpError, n) ?? true;
              if (custom === false) return false;
              return after ?? custom;
            }
            if (err instanceof TypeError) return policy.retryOn?.(err, n) ?? true; // network failure
            if (err instanceof DOMException && err.name === 'TimeoutError')
              return policy.retryOn?.(err, n) ?? true;
            return false;
          },
        })
      : retry(run, { retries: 0, attemptTimeout, signal });
    return task.catch(err => {
      if (err instanceof RetryableStatus) return err.response; // out of retries: hand back the response
      throw err;
    });
  }

  function subscribe(
    key: string,
    signal: AbortSignal,
    start: (sig: AbortSignal) => Promise<Response>,
  ): Promise<Response> {
    let flight = flights.get(key);
    if (!flight) {
      const ctrl = new AbortController();
      const promise = start(ctrl.signal);
      flight = { promise, ctrl, subscribers: 0 };
      flights.set(key, flight);
      const done = () => {
        if (flights.get(key) === flight) flights.delete(key);
      };
      promise.then(done, done);
    }
    const f = flight;
    f.subscribers++;
    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => {
        f.subscribers--;
        if (f.subscribers === 0) f.ctrl.abort(signal.reason ?? abortError());
        reject(signal.reason ?? abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      f.promise.then(
        res => {
          signal.removeEventListener('abort', onAbort);
          resolve(res.clone());
        },
        err => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      );
    });
  }

  /** Resolves the owner (signal/nursery/deadline) into one signal plus the effective attempt timeout. */
  function owner(
    opts: RequestOptions | (RequestOwner & StreamOptions),
  ): { signal: AbortSignal; attemptTimeout: number | undefined } | Error {
    const { signal: explicit, nursery } = opts as { signal?: AbortSignal; nursery?: Nursery };
    if (!(explicit instanceof AbortSignal) && !nursery) {
      return new TypeError('http: every request needs a `signal` or a `nursery`');
    }
    const deadline = opts.deadline ?? nursery?.deadline;
    const signals = [explicit, nursery?.signal];
    let attemptTimeout = opts.timeout ?? timeout;
    if (deadline !== undefined) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) return timeoutError('Deadline already passed');
      signals.push(timeoutSignal(remaining));
      attemptTimeout = attemptTimeout === undefined ? remaining : Math.min(attemptTimeout, remaining);
    }
    return { signal: anySignal(signals), attemptTimeout };
  }

  function request(url: string, opts: RequestOptions): Promise<Response> {
    const own = owner(opts);
    if (own instanceof Error) return Promise.reject(own);
    const {
      method = 'GET',
      body,
      query,
      retry: reqRetry,
      dedupe,
      headers: reqHeaders,
      baseUrl: reqBase,
      onDownloadProgress,
      onUploadProgress,
    } = opts;
    const {
      signal: _s,
      nursery: _sc,
      timeout: _t,
      deadline: _d,
      parse: _p,
      ...restInit
    } = opts as RequestOptions & { nursery?: Nursery };
    const rest = omit(restInit, [
      'method',
      'body',
      'query',
      'retry',
      'dedupe',
      'headers',
      'baseUrl',
      'onDownloadProgress',
      'onUploadProgress',
    ]);
    const m = method.toUpperCase();
    const headers = new Headers(defaultHeaders);
    new Headers(reqHeaders).forEach((v, k) => headers.set(k, v));
    const encoded = encodeBody(body, headers);
    const fullUrl = buildUrl(url, query, reqBase ?? baseUrl);
    const init: RequestInit & { duplex?: 'half'; bodyFactory?: () => BodyInit } = {
      ...rest,
      method: m,
      headers,
      body: encoded,
    };
    if (onUploadProgress && encoded !== undefined) {
      const source = encoded;
      const probe = uploadStream(source, () => {});
      if (probe) {
        void probe.cancel();
        init.body = undefined;
        init.bodyFactory = () => uploadStream(source, onUploadProgress)!;
        init.duplex = 'half';
      }
    }
    const policy = reqRetry ?? (idempotentMethods.includes(m) ? defaultRetry : undefined);
    const start = (sig: AbortSignal) => withRetry(fullUrl, init, policy, own.attemptTimeout, sig);

    const canDedupe = (dedupe ?? defaultDedupe) && (m === 'GET' || m === 'HEAD') && !onDownloadProgress;
    const result = canDedupe ? subscribe(`${m} ${fullUrl}`, own.signal, start) : start(own.signal);
    return onDownloadProgress ? result.then(res => withDownloadProgress(res, onDownloadProgress)) : result;
  }

  async function parsed<T>(url: string, opts: RequestOptions<T>): Promise<T> {
    const res = await request(url, opts);
    const body = await parseBody(res);
    if (!res.ok) throw new HttpError(res, body);
    if (!opts.parse) return body as T;
    try {
      return typeof opts.parse === 'function' ? opts.parse(body) : opts.parse.parse(body);
    } catch (err) {
      if (err instanceof Error)
        Object.defineProperty(err, 'response', { value: res, configurable: true, writable: true });
      throw err;
    }
  }

  async function openStream(url: string, opts: RequestOwner & StreamOptions): Promise<Response> {
    const res = await request(url, { ...opts, dedupe: false });
    if (!res.ok) throw new HttpError(res, await parseBody(res));
    if (!res.body) throw new TypeError('http: response has no body to stream');
    return res;
  }

  async function* stream<T>(
    url: string,
    opts: RequestOwner & StreamOptions,
  ): AsyncGenerator<T, void, undefined> {
    const signal = ownerSignal(opts);
    let res: Response;
    try {
      res = await openStream(url, opts);
    } catch (err) {
      if (signal?.aborted) return; // like on(): the owner's abort ends the iteration
      throw err;
    }
    try {
      for await (const line of lines(res.body!, signal)) {
        if (line.trim() === '') continue;
        yield JSON.parse(line) as T;
      }
    } catch (err) {
      if (signal?.aborted) return;
      throw err;
    }
  }

  async function* sse(
    url: string,
    opts: RequestOwner & SseOptions,
  ): AsyncGenerator<SseEvent, void, undefined> {
    const { reconnect, ...rest } = opts;
    const baseDelay = reconnect?.delay ?? 1000;
    const maxDelay = reconnect?.maxDelay ?? 30_000;
    const factor = reconnect?.factor ?? 2;
    const shouldReconnect = reconnect?.retryOn ?? defaultSseRetryOn;
    const signal = ownerSignal(opts);
    let lastEventId: string | undefined;
    let serverRetry: number | undefined;
    let wait = baseDelay;
    let attempt = 0;

    const backoff = async (err: unknown) => {
      const d = Math.min(wait, maxDelay);
      reconnect!.onRetry?.(err, attempt, d);
      await sleep(d, signal);
      wait = Math.min(wait * factor, maxDelay);
      attempt++;
    };

    for (;;) {
      const headers = new Headers(rest.headers);
      headers.set('accept', 'text/event-stream');
      if (lastEventId !== undefined) headers.set('last-event-id', lastEventId);
      let res: Response;
      try {
        res = await openStream(url, { ...rest, headers, cache: 'no-store' });
      } catch (err) {
        if (signal?.aborted) return; // like on(): the owner's abort ends the iteration
        if (!reconnect || isAbort(err) || !shouldReconnect(err)) throw err;
        await backoff(err);
        continue;
      }
      // connected: reset the backoff
      wait = serverRetry ?? baseDelay;
      attempt = 0;
      let failure: unknown;
      let id: string | undefined;
      let event = 'message';
      let data: string[] = [];
      let retryField: number | undefined;
      try {
        for await (const line of lines(res.body!, signal)) {
          if (line === '') {
            if (data.length > 0) {
              if (id !== undefined) lastEventId = id;
              yield { id: lastEventId, event, data: data.join('\n'), retry: retryField };
            }
            event = 'message';
            data = [];
            retryField = undefined;
            continue;
          }
          if (line.startsWith(':')) continue;
          const colon = line.indexOf(':');
          const field = colon === -1 ? line : line.slice(0, colon);
          let value = colon === -1 ? '' : line.slice(colon + 1);
          if (value.startsWith(' ')) value = value.slice(1);
          if (field === 'data') data.push(value);
          else if (field === 'event') event = value;
          else if (field === 'id') id = value.includes('\0') ? id : value;
          else if (field === 'retry' && /^\d+$/.test(value)) {
            retryField = Number(value);
            serverRetry = retryField;
            wait = retryField;
          }
        }
      } catch (err) {
        if (signal?.aborted) return;
        if (isAbort(err) || !reconnect || !shouldReconnect(err)) throw err;
        failure = err;
      }
      if (!reconnect || signal?.aborted) return;
      try {
        await backoff(failure);
      } catch (err) {
        if (signal?.aborted) return;
        throw err;
      }
    }
  }

  return {
    request,
    get: (url, opts) => parsed(url, { ...opts, method: 'GET' }),
    head: (url, opts) => request(url, { ...opts, method: 'HEAD' }),
    post: (url, opts) => parsed(url, { ...opts, method: 'POST' }),
    put: (url, opts) => parsed(url, { ...opts, method: 'PUT' }),
    patch: (url, opts) => parsed(url, { ...opts, method: 'PATCH' }),
    delete: (url, opts) => parsed(url, { ...opts, method: 'DELETE' }),
    stream,
    sse,
  };
}

function ownerSignal(opts: RequestOwner): AbortSignal | undefined {
  const explicit = (opts as { signal?: AbortSignal }).signal;
  const nursery = (opts as { nursery?: Nursery }).nursery;
  return explicit && nursery ? anySignal([explicit, nursery.signal]) : (explicit ?? nursery?.signal);
}

function defaultSseRetryOn(err: unknown): boolean {
  if (err instanceof HttpError) return DEFAULT_RETRY_STATUSES.includes(err.status);
  if (err instanceof TypeError) return true; // network failure
  return err instanceof DOMException && err.name === 'TimeoutError';
}

function defaultQuerySerializer(query: Query): URLSearchParams {
  const params = new URLSearchParams();
  const walk = (key: string, value: QueryValue) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      for (const v of value) walk(key, v);
    } else if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(`${key}[${k}]`, v);
    } else {
      params.append(key, String(value));
    }
  };
  for (const [k, v] of Object.entries(query)) walk(k, v);
  return params;
}

/** Wraps a body into a ReadableStream that reports bytes sent. Returns undefined for unsupported bodies. */
function uploadStream(
  body: BodyInit,
  onProgress: (sent: number, total: number) => void,
): ReadableStream<Uint8Array> | undefined {
  let bytes: Uint8Array | Blob;
  if (typeof body === 'string') bytes = new TextEncoder().encode(body);
  else if (body instanceof Blob) bytes = body;
  else if (body instanceof ArrayBuffer) bytes = new Uint8Array(body);
  else if (ArrayBuffer.isView(body)) bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  else if (body instanceof URLSearchParams) bytes = new TextEncoder().encode(body.toString());
  else return undefined; // FormData and streams: no reliable size, leave as is
  const total = bytes instanceof Blob ? bytes.size : bytes.byteLength;
  const CHUNK = 64 * 1024;
  let offset = 0;
  let sent = 0;
  // Re-chunk so progress is reported in 64 KiB steps regardless of how the engine slices the source.
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset >= total) {
        if (total === 0) onProgress(0, 0);
        controller.close();
        return;
      }
      const end = Math.min(offset + CHUNK, total);
      const piece =
        bytes instanceof Blob
          ? new Uint8Array(await bytes.slice(offset, end).arrayBuffer())
          : bytes.subarray(offset, end);
      offset = end;
      sent += piece.byteLength;
      onProgress(sent, total);
      controller.enqueue(piece);
    },
  });
}

function withDownloadProgress(
  res: Response,
  onProgress: (loaded: number, total: number | undefined) => void,
): Response {
  if (!res.body) return res;
  const header = res.headers.get('content-length');
  const total = header === null ? undefined : Number(header);
  let loaded = 0;
  const body = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        loaded += chunk.byteLength;
        onProgress(loaded, total);
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

function omit<T extends object, K extends string>(obj: T, keys: K[]): Omit<T, K> {
  const out = { ...obj } as Record<string, unknown>;
  for (const k of keys) delete out[k];
  return out as Omit<T, K>;
}

function encodeBody(body: unknown, headers: Headers): BodyInit | undefined {
  if (body === undefined || body === null) return undefined;
  const passthrough =
    typeof body === 'string' ||
    body instanceof FormData ||
    body instanceof URLSearchParams ||
    body instanceof Blob ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream);
  if (passthrough) return body as BodyInit;
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  return JSON.stringify(body);
}

/** Splits a byte stream into text lines (\\n or \\r\\n), flushing a trailing partial line. */
async function* lines(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string, void, undefined> {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of fromReadableStream(body, signal)) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      let line = buf.slice(0, nl);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      buf = buf.slice(nl + 1);
      yield line;
    }
  }
  buf += decoder.decode();
  if (buf.length > 0) yield buf.endsWith('\r') ? buf.slice(0, -1) : buf;
}

async function parseBody(res: Response): Promise<unknown> {
  if (res.status === 204 || res.status === 205 || res.headers.get('content-length') === '0') return undefined;
  const type = res.headers.get('content-type') ?? '';
  try {
    if (type.includes('json')) return await res.json();
    const text = await res.text();
    return text === '' ? undefined : text;
  } catch {
    return undefined;
  }
}

function retryAfterMs(res: Response): number | undefined {
  const h = res.headers.get('retry-after');
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(h);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}
