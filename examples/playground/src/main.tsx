import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createHttp } from '@nursery/core/http';
import { Nursery } from '@nursery/core/nursery';
import { callback } from '@nursery/core/worker';
import { isAbort } from '@nursery/core/signal';
import { useAsync, useLatest, useNursery, useNurseryEffect, useWorker } from '@nursery/react';
import { server } from './mock-server';
import type { api as HeavyApi } from './heavy.worker';

const http = createHttp({ fetch: server.fetch, retry: { retries: 2, delay: 300 }, timeout: 5000 });
Nursery.profiling = true;
Nursery.onUnhandled((err, { nursery, task }) => console.error('[unhandled]', nursery.name, task?.name, err));

function Search() {
  const [items, setItems] = useState<Array<{ id: string; label: string }>>([]);
  const { run, pending } = useLatest((q: string, signal: AbortSignal) =>
    http.get<Array<{ id: string; label: string }>>('/search', { signal, query: { q } }),
  );
  return (
    <section>
      <h3>latest(): type fast, only the last response lands</h3>
      <input placeholder="search…" onChange={e => run(e.target.value).then(setItems).catch(e => { if (!isAbort(e)) throw e; })} />
      {pending && ' loading…'}
      <pre>{items.map(i => i.label).join('\n') || '(nothing)'}</pre>
    </section>
  );
}

function Report() {
  const [n, setN] = useState(0);
  const report = useAsync(nursery => http.get<{ generatedAt: string }>('/report', { nursery }), [n]);
  return (
    <section>
      <h3>useAsync + retry: the mock returns 503 half of the time</h3>
      <button onClick={() => setN(n + 1)}>reload</button>
      <pre>{JSON.stringify(report, null, 2)}</pre>
    </section>
  );
}

function Events() {
  const [lines, setLines] = useState<string[]>([]);
  useNurseryEffect(async nursery => {
    for await (const e of http.sse('/events', { nursery, reconnect: { delay: 1000 } })) {
      setLines(l => [...l.slice(-9), `${e.event} #${e.id}: ${e.data}`]);
    }
  }, []);
  return (
    <section>
      <h3>sse(): stream ends every 5 events, reconnects with Last-Event-ID</h3>
      <pre>{lines.join('\n')}</pre>
    </section>
  );
}

function Worker() {
  const heavy = useWorker<typeof HeavyApi>(() => new globalThis.Worker(new URL('./heavy.worker.ts', import.meta.url), { type: 'module' }));
  const nursery = useNursery();
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<string>('');
  const [ctrl, setCtrl] = useState<AbortController | null>(null);
  const start = () => {
    const c = new AbortController();
    setCtrl(c);
    setResult('');
    heavy
      .primes(3_000_000, { signal: c.signal, onProgress: callback((p: number) => setProgress(p)) })
      .then(count => setResult(`${count} primes`))
      .catch(e => setResult(isAbort(e) ? 'cancelled' : String(e)))
      .finally(() => setCtrl(null));
  };
  return (
    <section>
      <h3>worker: cancellable, progress via callback()</h3>
      <button onClick={start} disabled={!!ctrl}>count primes below 3M</button>
      <button onClick={() => ctrl?.abort()} disabled={!ctrl}>cancel</button>
      <progress value={progress} max={1} /> {result}
      <pre>{nursery.dump()}</pre>
    </section>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <h1>nursery playground</h1>
    <Search />
    <Report />
    <Events />
    <Worker />
  </StrictMode>,
);
