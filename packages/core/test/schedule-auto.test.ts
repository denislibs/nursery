import { chunked, frameInterval, resetFrameInterval } from '../src/schedule.js';

/** requestAnimationFrame stub whose timestamps advance by `step` ms per frame. */
function stubRaf(step: number) {
  let t = 1000;
  const raf = vi.fn((cb: (ts: number) => void) => {
    t += step;
    const ts = t;
    setTimeout(() => cb(ts), 0);
    return 1;
  });
  vi.stubGlobal('requestAnimationFrame', raf);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  return raf;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetFrameInterval();
});

describe('frameInterval', () => {
  test('measures the interval between animation frames', async () => {
    stubRaf(8.33);
    expect(await frameInterval()).toBeCloseTo(8.33, 1);
  });
  test('falls back to 60 Hz when requestAnimationFrame is unavailable', async () => {
    vi.stubGlobal('requestAnimationFrame', undefined);
    expect(await frameInterval()).toBeCloseTo(1000 / 60, 1);
  });
  test('caches the measurement instead of sampling on every call', async () => {
    const raf = stubRaf(16.67);
    await frameInterval();
    const calls = raf.mock.calls.length;
    await frameInterval();
    expect(raf.mock.calls.length).toBe(calls);
  });
  test('ignores outliers such as a throttled first frame', async () => {
    let t = 0;
    const deltas = [200, 8.3, 8.4, 8.3, 8.3, 8.4];
    let i = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: (ts: number) => void) => {
      t += deltas[Math.min(i++, deltas.length - 1)]!;
      const ts = t;
      setTimeout(() => cb(ts), 0);
      return 1;
    });
    expect(await frameInterval()).toBeCloseTo(8.3, 0);
  });
});

describe('chunked with budget: auto', () => {
  test('uses half the measured frame interval as the budget', async () => {
    stubRaf(8.33); // 120 Hz → budget ≈ 4.17 ms
    const y = vi.fn(() => Promise.resolve());
    vi.stubGlobal('scheduler', { yield: y });
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    for await (const _ of chunked([1, 2, 3, 4, 5, 6, 7, 8], { budget: 'auto' })) now += 3; // 3 ms per item
    // elapsed hits ≥ 4.17 after every second item: yields before items 3, 5, 7
    expect(y).toHaveBeenCalledTimes(3);
  });
  test('auto is the default', async () => {
    stubRaf(33.3); // 30 Hz → budget ≈ 16.7 ms
    const y = vi.fn(() => Promise.resolve());
    vi.stubGlobal('scheduler', { yield: y });
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    for await (const _ of chunked([1, 2, 3, 4, 5, 6])) now += 5;
    // 5 ms per item, 16.7 budget: yield before item 5 only
    expect(y).toHaveBeenCalledTimes(1);
  });
  test('yields at once when input is pending, regardless of the budget', async () => {
    stubRaf(16.67);
    const y = vi.fn(() => Promise.resolve());
    vi.stubGlobal('scheduler', { yield: y });
    let pending = false;
    vi.stubGlobal('navigator', { scheduling: { isInputPending: () => pending } });
    vi.spyOn(performance, 'now').mockImplementation(() => 0); // budget never exceeded
    const seen: number[] = [];
    for await (const n of chunked([1, 2, 3, 4], { budget: 100 })) {
      seen.push(n);
      pending = n === 2; // a click arrives after item 2
    }
    expect(seen).toEqual([1, 2, 3, 4]);
    expect(y).toHaveBeenCalledTimes(1);
  });
  test('a numeric budget bypasses frame measurement', async () => {
    const raf = stubRaf(16.67);
    vi.stubGlobal('scheduler', { yield: () => Promise.resolve() });
    for await (const _ of chunked([1, 2], { budget: 8 })) {
      /* empty */
    }
    expect(raf).not.toHaveBeenCalled();
  });
});
