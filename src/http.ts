import { retry, type RetryOptions } from './combine.js';
import { abortError } from './signal.js';

export type Query = Record<string, string | number | boolean | null | undefined>;

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
}

export interface RequestOptions extends Omit<RequestInit, 'signal' | 'body' | 'method'> {
  /** Required: every request must be cancellable. */
  signal: AbortSignal;
  method?: string;
  /** Plain objects and arrays are JSON-encoded; everything fetch accepts is passed through. */
  body?: unknown;
  query?: Query;
  timeout?: number;
  /** Retry policy for this request. Setting it enables retry even for non-idempotent methods. */
  retry?: Omit<RetryOptions, 'signal' | 'attemptTimeout'>;
  dedupe?: boolean;
}

export type BodyOptions = Omit<RequestOptions, 'method'>;

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
  get<T = unknown>(url: string, opts: BodyOptions): Promise<T>;
  head(url: string, opts: BodyOptions): Promise<Response>;
  post<T = unknown>(url: string, opts: BodyOptions): Promise<T>;
  put<T = unknown>(url: string, opts: BodyOptions): Promise<T>;
  patch<T = unknown>(url: string, opts: BodyOptions): Promise<T>;
  delete<T = unknown>(url: string, opts: BodyOptions): Promise<T>;
}

const DEFAULT_RETRY_STATUSES = [408, 425, 429, 500, 502, 503, 504];
const DEFAULT_IDEMPOTENT = ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'];

/** Thrown internally to route a retryable status through retry(). */
class RetryableStatus extends Error {
  constructor(readonly response: Response) {
    super(`Retryable status ${response.status}`);
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
  } = options;
  const flights = new Map<string, Flight>();

  function buildUrl(url: string, query?: Query): string {
    const absolute = /^[a-z][a-z0-9+.-]*:/i.test(url);
    const u =
      absolute || !baseUrl
        ? new URL(url)
        : new URL(url.replace(/^\//, ''), baseUrl.endsWith('/') ? baseUrl : baseUrl + '/');
    if (query) {
      for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) u.searchParams.append(k, String(v));
    }
    return u.href;
  }

  async function performOnce(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    const res = await fetchFn(url, { ...init, signal });
    if (retryStatuses.includes(res.status)) throw new RetryableStatus(res);
    return res;
  }

  function withRetry(url: string, init: RequestInit, policy: RequestOptions['retry'] | undefined, attemptTimeout: number | undefined, signal: AbortSignal): Promise<Response> {
    const run = (sig: AbortSignal) => performOnce(url, init, sig);
    const task = policy
      ? retry(run, {
          ...policy,
          attemptTimeout,
          signal,
          retryOn: (err, attempt) => {
            if (err instanceof RetryableStatus) {
              const after = retryAfterMs(err.response);
              const custom = policy.retryOn?.(err, attempt) ?? true;
              if (custom === false) return false;
              return after ?? custom;
            }
            if (err instanceof TypeError) return policy.retryOn?.(err, attempt) ?? true; // network failure
            if (err instanceof DOMException && err.name === 'TimeoutError') return policy.retryOn?.(err, attempt) ?? true;
            return false;
          },
        })
      : retry(run, { retries: 0, attemptTimeout, signal });
    return task.catch(err => {
      if (err instanceof RetryableStatus) return err.response; // out of retries: hand back the response
      throw err;
    });
  }

  function subscribe(key: string, signal: AbortSignal, start: (sig: AbortSignal) => Promise<Response>): Promise<Response> {
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

  function request(url: string, opts: RequestOptions): Promise<Response> {
    if (!(opts?.signal instanceof AbortSignal)) {
      return Promise.reject(new TypeError('http: `signal` is required on every request'));
    }
    const { signal, method = 'GET', body, query, timeout: reqTimeout, retry: reqRetry, dedupe, headers: reqHeaders, ...rest } = opts;
    const m = method.toUpperCase();
    const headers = new Headers(defaultHeaders);
    new Headers(reqHeaders).forEach((v, k) => headers.set(k, v));
    const encoded = encodeBody(body, headers);
    const fullUrl = buildUrl(url, query);
    const init: RequestInit = { ...rest, method: m, headers, body: encoded };
    const policy = reqRetry ?? (idempotentMethods.includes(m) ? defaultRetry : undefined);
    const attemptTimeout = reqTimeout ?? timeout;
    const start = (sig: AbortSignal) => withRetry(fullUrl, init, policy, attemptTimeout, sig);

    const canDedupe = (dedupe ?? defaultDedupe) && (m === 'GET' || m === 'HEAD');
    if (!canDedupe) return start(signal);
    return subscribe(`${m} ${fullUrl}`, signal, start);
  }

  async function parsed<T>(url: string, opts: RequestOptions): Promise<T> {
    const res = await request(url, opts);
    const body = await parseBody(res);
    if (!res.ok) throw new HttpError(res, body);
    return body as T;
  }

  return {
    request,
    get: (url, opts) => parsed(url, { ...opts, method: 'GET' }),
    head: (url, opts) => request(url, { ...opts, method: 'HEAD' }),
    post: (url, opts) => parsed(url, { ...opts, method: 'POST' }),
    put: (url, opts) => parsed(url, { ...opts, method: 'PUT' }),
    patch: (url, opts) => parsed(url, { ...opts, method: 'PATCH' }),
    delete: (url, opts) => parsed(url, { ...opts, method: 'DELETE' }),
  };
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
