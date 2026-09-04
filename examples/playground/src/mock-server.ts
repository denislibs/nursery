// An in-page fake backend so the playground works offline: search, a slow report, an SSE feed.
import { fakeFetch, jsonResponse } from '@nursery/core/testing';
import { sleep } from '@nursery/core/signal';

const words = ['nursery', 'signal', 'retry', 'queue', 'channel', 'worker', 'stream', 'latest', 'share', 'deadline'];

export const server = fakeFetch({
  'GET /search': async ({ url }) => {
    const q = url.searchParams.get('q') ?? '';
    await sleep(300 + Math.random() * 700);          // slow enough for races to show
    return words.filter(w => w.includes(q.toLowerCase())).map(w => ({ id: w, label: w }));
  },
  'GET /report': async () => {
    await sleep(1500);
    if (Math.random() < 0.5) return jsonResponse({ error: 'flaky' }, { status: 503 });
    return { generatedAt: new Date().toISOString() };
  },
  'GET /events': () => {
    let n = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        await sleep(800);
        c.enqueue(new TextEncoder().encode(`id: ${++n}\nevent: tick\ndata: {"n":${n}}\n\n`));
        if (n === 5) c.close();                          // ends: the client will reconnect
      },
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  },
});
