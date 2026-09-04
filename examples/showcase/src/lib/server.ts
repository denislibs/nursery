/** In-page fake backend shared by the demos. Latency and failures are deliberately nasty. */
import { fakeFetch, jsonResponse, textStream } from '@nursery/core/testing';
import { sleep } from '@nursery/core/signal';
import { rand } from './page';

const words = ['nursery', 'signal', 'retry', 'queue', 'channel', 'worker', 'stream', 'latest', 'share', 'deadline', 'select', 'chunked', 'transfer', 'callback', 'semaphore', 'mutex', 'debounce', 'throttle', 'timeout', 'race'];

export const server = fakeFetch({
  // search: latency varies wildly, which is exactly what produces races
  'GET /search': async ({ url, init }) => {
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    const latency = rand(150, 1400);
    await sleep(latency, init.signal ?? undefined);
    return words.filter(w => w.includes(q)).map(w => ({ id: w, label: w, latency: Math.round(latency) }));
  },
  // upload: reads the body slowly so progress is visible; fails now and then
  'POST /upload': async ({ init }) => {
    const body = init.body;
    const failAt = Math.random() < 0.15 ? Math.random() : 2; // 15 % of uploads die somewhere along the way
    if (body instanceof ReadableStream) {
      const reader = body.getReader();
      let chunks = 0;
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
        await sleep(rand(40, 120), init.signal ?? undefined);
        if (++chunks / 40 > failAt) return jsonResponse({ error: 'flaky' }, { status: 503 });
      }
    } else {
      await sleep(rand(400, 900), init.signal ?? undefined);
    }
    return { ok: true };
  },
  'GET /ticker': () => {
    let n = 0;
    let price = 100;
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        await sleep(rand(300, 700));
        price = Math.max(1, price + rand(-2, 2));
        c.enqueue(new TextEncoder().encode(`id: ${++n}\nevent: price\ndata: {"n":${n},"price":${price.toFixed(2)}}\n\n`));
        if (n % 8 === 0) c.close(); // drop the connection now and then
      },
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  },
  'GET /status': async ({ init }) => {
    await sleep(rand(200, 2500), init.signal ?? undefined);
    return { load: rand(0, 1).toFixed(2), at: new Date().toLocaleTimeString() };
  },
  'GET /flaky': async ({ init }) => {
    await sleep(rand(100, 600), init.signal ?? undefined);
    if (Math.random() < 0.5) return jsonResponse({ error: 'boom' }, { status: 500 });
    return { fine: true };
  },
  'GET /lines': () => new Response(textStream(Array.from({ length: 30 }, (_, i) => `{"row":${i}}\n`)), { headers: { 'content-type': 'application/x-ndjson' } }),
});
