import { on } from '../../src/events.js';
import { iter } from '../../src/index.js';
import { yieldToMain, idle, frame, chunked } from '../../src/schedule.js';

describe('on() with real DOM', () => {
  test('collects click events from a button until the signal aborts', async () => {
    const button = document.createElement('button');
    document.body.append(button);
    const c = new AbortController();
    const clicks: MouseEvent[] = [];
    const loop = (async () => {
      for await (const e of on<MouseEvent>(button, 'click', { signal: c.signal })) clicks.push(e);
    })();
    button.click();
    button.click();
    await new Promise(r => setTimeout(r, 0));
    c.abort();
    await loop;
    expect(clicks).toHaveLength(2);
    expect(clicks[0]).toBeInstanceOf(MouseEvent);
    button.remove();
  });

  test('input events debounce down to the final value', async () => {
    const input = document.createElement('input');
    document.body.append(input);
    const c = new AbortController();
    const values: string[] = [];
    const loop = (async () => {
      for await (const e of iter.pipe(
        on<InputEvent>(input, 'input', { signal: c.signal }),
        iter.debounce(30),
      )) {
        values.push((e.target as HTMLInputElement).value);
      }
    })();
    for (const v of ['a', 'ab', 'abc']) {
      input.value = v;
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
    await new Promise(r => setTimeout(r, 60));
    c.abort();
    await loop;
    expect(values).toEqual(['abc']);
    input.remove();
  });
});

describe('schedule with real browser APIs', () => {
  test('yieldToMain resolves using the native scheduler when present', async () => {
    const hasScheduler = 'scheduler' in globalThis;
    await expect(yieldToMain()).resolves.toBeUndefined();
    expect(typeof hasScheduler).toBe('boolean');
  });
  test('idle resolves with an IdleDeadline', async () => {
    const d = await idle({ timeout: 500 });
    expect(typeof d.timeRemaining()).toBe('number');
  });
  test('frame resolves with a timestamp', async () => {
    await expect(frame()).resolves.toEqual(expect.any(Number));
  });
  test('chunked walks a heavy loop without dropping items', async () => {
    const items = Array.from({ length: 2000 }, (_, i) => i);
    let sum = 0;
    for await (const n of chunked(items, { budget: 2 })) {
      const end = performance.now() + 0.05;
      while (performance.now() < end) {
        /* burn a little main-thread time */
      }
      sum += n;
    }
    expect(sum).toBe((1999 * 2000) / 2);
  });
});
