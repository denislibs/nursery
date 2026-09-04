import { wrap } from '../../src/worker.js';
import { isAbort } from '../../src/signal.js';
import type { api } from './fixtures/echo.worker.js';

let worker: Worker;
let remote: ReturnType<typeof wrap<typeof api>>;

beforeEach(() => {
  worker = new Worker(new URL('./fixtures/echo.worker.ts', import.meta.url), { type: 'module' });
  remote = wrap<typeof api>(worker);
});
afterEach(() => {
  remote[Symbol.dispose]();
  worker.terminate();
});

describe('real Worker', () => {
  test('round-trips a call through a module worker', async () => {
    await expect(remote.double(21)).resolves.toBe(42);
  });

  test('errors thrown in the worker arrive with name and message', async () => {
    const err = await remote.boom().catch((e: Error) => e);
    expect(err.name).toBe('TypeError');
    expect(err.message).toBe('bad input');
  });

  test('abort on the main thread cancels the task inside the worker', async () => {
    const c = new AbortController();
    const p = remote.slow(30_000, { signal: c.signal });
    await new Promise(r => setTimeout(r, 20));
    c.abort(new DOMException('navigated away', 'AbortError'));
    await expect(p).rejects.toSatisfy(isAbort);
    await vi.waitFor(async () => expect(await remote.lastAbort()).toBe('navigated away'));
  });
});
