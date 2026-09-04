/* oxlint-disable typescript/no-explicit-any */
/* Ambient stubs for cookbook code blocks: anything a recipe references but does not define.
   Script file (no imports/exports): every declaration is global. Recipes shadow these freely. */
type Scope = import('@scopekit/core/scope').Scope;
type Http = import('@scopekit/core/http').Http;
type Channel<T> = import('@scopekit/core/events').Channel<T>;
type User = { id: string; name: string; roles?: string[] };
type Item = { id: string; active: boolean; label?: string };
type Order = { id: string };
type Post = { id: string };
type Profile = { id: string };
type Row = Record<string, unknown>;
type Job = { id: string; status?: string };
type Config = Record<string, unknown>;
type Coords = { lat: number; lng: number };
type Point = { x: number; y: number };
type Detail = Record<string, unknown>;
type Control = { kind: string };
type AnalyticsEvent = { name: string };
type ParserApi = {
  parse(src: string, o: { signal: AbortSignal }): Promise<unknown>;
  compute(data: unknown, o: { signal: AbortSignal }): Promise<unknown>;
};
type Api = ParserApi;
type Parser = ParserApi;
type EchoApi = { double(n: number): Promise<number> };
type LoaderFunctionArgs = { params: Record<string, string>; request: Request };
type PropsWithChildren<P = unknown> = P & { children?: unknown };
interface ImportMeta {
  env: Record<string, string | undefined>;
}

declare const Scope: typeof import('@scopekit/core/scope').Scope;
declare const api: any;
declare const http: Http;
declare const scope: Scope;
declare const signal: AbortSignal;
declare const s1: AbortSignal, s2: AbortSignal, ctrl: AbortController;
declare const baseUrl: string,
  token: string,
  id: string,
  userId: string,
  url: string,
  q: string,
  key: string,
  src: string,
  source: string,
  path: string;
declare const ids: string[],
  urls: string[],
  emails: string[],
  files: File[],
  rows: Row[],
  items: Item[],
  queue: any[],
  chunks: Uint8Array[];
declare const jobs: Channel<Job>, events: Channel<unknown>, controls: Channel<Control>;
declare const file: File,
  doc: string,
  form: { value: unknown },
  payload: unknown,
  patch: unknown,
  body: unknown,
  data: unknown,
  value: unknown,
  job: Job;
declare const el: HTMLElement,
  node: HTMLElement,
  input: HTMLInputElement,
  button: HTMLButtonElement,
  clearButton: HTMLButtonElement,
  saveButton: HTMLButtonElement,
  spinner: HTMLElement,
  canvas: HTMLCanvasElement,
  table: HTMLElement,
  target: EventTarget;
declare const editor: { on(event: string, cb: (doc: string) => void): void };
declare const ws: WebSocket, wsA: WebSocket, wsB: WebSocket, router: { onLeave(cb: () => void): void };
declare const store: { subscribe(cb: () => void): () => void };
declare const ticker: { onPrice(cb: (p: number) => void): () => void };
declare const legacyGeocoder: {
  lookup(
    address: string,
    o: { onSuccess: (c: Coords) => void; onError: (e: unknown) => void },
  ): { cancel(): void };
};
declare const workers: any[], w: number, h: number, pixels: Uint8ClampedArray, out: ArrayBuffer, result: any;
declare const sizes: AsyncIterable<number>,
  themes: AsyncIterable<string>,
  ticks: AsyncIterable<number>,
  prices: AsyncIterable<number>,
  clicks: AsyncIterable<MouseEvent>;
declare const seen: string[],
  log: { warn(...a: unknown[]): void },
  metrics: { retry(o: unknown): void; http(status: number, attempt: number): void },
  bar: { value: number };
declare const Sentry: { captureException(e: unknown, o?: unknown): void };
declare const z: {
  object(shape: Record<string, unknown>): { parse(v: unknown): any };
  number(): unknown;
  string(): unknown;
};
declare const TraceId: import('@scopekit/core/scope').ContextKey<string | undefined>;
declare const parser: import('@scopekit/core/worker').Remote<ParserApi>,
  remote: import('@scopekit/core/worker').Remote<any>,
  worker: Worker;
declare const uploadSlots: import('@scopekit/core/limit').Semaphore, loadMe: (arg?: void) => Promise<User>;
declare const search: import('@scopekit/core/latest').LatestFn<string, Item[]>;
declare let dropped: number;
declare const e: Event, onProgress: (loaded: number, total?: number) => void;
declare const addAuth: import('@scopekit/core/http').RequestHook,
  addTrace: import('@scopekit/core/http').RequestHook,
  logRequest: import('@scopekit/core/http').RequestHook;
declare const currentUser: User;
declare const Card: (p: any) => any,
  ErrorBox: (p: any) => any,
  OrderList: (p: any) => any,
  List: (p: any) => any,
  Table: (p: any) => any,
  Dashboard: (p?: any) => any,
  UserCard: (p: any) => any,
  Spinner: (p?: any) => any,
  Skeleton: (p?: any) => any;
declare function defineProps<T>(): T;
declare const useQuery: any,
  defineStore: any,
  useAsyncData: any,
  effect: any,
  Injectable: any,
  Component: any,
  DestroyRef: any,
  inject: any;
declare const close: () => void,
  setOpen: (v: boolean) => void,
  setUser: (u: User | null) => void,
  setResults: (r: Item[]) => void,
  setV: (v: string) => void,
  setRendered: (r: Row[]) => void;
declare const vi: any, beforeEach: any, afterEach: any, describe: any;
declare function toast(msg: unknown): void;
declare function render(...a: unknown[]): void;
declare function renderRow(r: Row): HTMLElement;
declare function reportError(e: unknown): void;
declare function ignoreAbort(e: unknown): undefined;
declare function showErrorToast(e: unknown): void;
declare function isReady(signal: AbortSignal): Promise<boolean>;
declare function loadData(signal: AbortSignal): Promise<unknown>;
declare function uploadFile(file: File, signal: AbortSignal): Promise<void>;
declare function fetchJson(u: string, signal?: AbortSignal): Promise<unknown>;
declare function fetchImage(u: string, signal: AbortSignal): Promise<Blob>;
declare function fetchA(signal: AbortSignal): Promise<number>;
declare function fetchB(signal: AbortSignal): Promise<number>;
declare function fromCache(signal: AbortSignal): Promise<Config>;
declare function fromNetwork(signal: AbortSignal): Promise<Config>;
declare function loadFromIndexedDb(signal: AbortSignal): Promise<Config>;
declare function makeThumbnail(f: File, signal: AbortSignal): Promise<Blob>;
declare function makeThumb(f: File, signal: AbortSignal): Promise<Blob>;
declare function enrich(item: any, signal?: AbortSignal): any;
declare function send(e: string, signal: AbortSignal): Promise<void>;
declare function process(...a: unknown[]): any;
declare function upload(file: File, signal: AbortSignal): Promise<void>;
declare function doUpload(file: File, signal: AbortSignal): Promise<void>;
declare function step1(): Promise<void>;
declare function step2(): Promise<void>;
declare function saveDraft(...a: unknown[]): Promise<void>;
declare function flushAnalytics(signal: AbortSignal): Promise<void>;
declare function handle(...a: unknown[]): Promise<void>;
declare function applyControl(c: Control): void;
declare function draw(...a: unknown[]): void;
declare function heavyRedraw(e: Event): Promise<void>;
declare function heavy(e: Event): Promise<void>;
declare function plot(...a: unknown[]): void;
declare function relayout(...a: unknown[]): void;
declare function analytics(e: unknown): void;
declare function save(): void;
declare function updatePrice(p: number): void;
declare function appendMessage(m: unknown): void;
declare function isChatMessage(m: unknown): boolean;
declare function parseRow(r: unknown): unknown;
declare function prewarm(x: unknown): void;
declare function parsePhase(): Promise<void>;
declare function layoutPhase(): Promise<void>;
declare function paintPhase(): Promise<void>;
declare function renderVisibleRows(): void;
declare function warmCache(): void;
declare function refreshToken(): Promise<string>;
declare function redirectToLogin(): void;
declare function isRateLimited(e: unknown): boolean;
declare function isFatal(e: unknown): boolean;
declare function getToken(): string;
declare function headersOf(init?: RequestInit): Record<string, string>;
declare function append(...a: unknown[]): void;
declare function markDone(...a: unknown[]): void;
declare function setProgress(p: number): void;
declare function confirm(msg: string): boolean;
declare function showSyntaxError(m: string): void;
declare function heavyParse(src: string, signal: AbortSignal): unknown;
declare function openSocket(): WebSocket;
declare function messages(ws: WebSocket, signal: AbortSignal): AsyncIterable<any>;
declare function pollJobs(signal: AbortSignal): AsyncIterable<Job>;
declare function pollStatus(signal: AbortSignal): Promise<void>;
declare function stream(signal: AbortSignal): Promise<void>;
declare function something(): Promise<void>;
declare function renderWidget(el: HTMLElement, signal: AbortSignal): Promise<void>;
declare function optionalPrefetch(signal: AbortSignal): Promise<void>;
declare function onChange(): void;
declare function onClick(e: Event): void;
declare function onResize(): void;
declare function newTraceId(): string;
declare function load(...a: unknown[]): Promise<any>;
declare function loadDetail(id: string, signal: AbortSignal): Promise<Detail>;
declare function it(...a: unknown[]): void;
declare function test(...a: unknown[]): void;
declare function expect(v: unknown): any;
declare function unmount(): void;
declare namespace screen {
  function findByText(t: string): Promise<HTMLElement>;
}
declare const query: import('vue').Ref<string>, results: import('vue').ShallowRef<Item[]>;
declare const pageScope: Scope;
declare function prefetch(signal: AbortSignal): Promise<void>;
declare const Widget: (p: any) => any;
