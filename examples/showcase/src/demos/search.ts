import { createHttp } from '@nursery/core/http';
import { latest } from '@nursery/core/latest';
import { on } from '@nursery/core/events';
import { pipe, debounce } from '@nursery/core/iter';
import { isAbort } from '@nursery/core/signal';
import { Nursery } from '@nursery/core/nursery';
import { server } from '../lib/server';
import { $, h, mountHeader } from '../lib/page';

mountHeader('search', 'гонки', 'Одна и та же строка поиска, две стратегии. Печатайте быстро или нажмите «Шторм»: слева ответы приходят в случайном порядке и перетирают друг друга, справа выживает только последний.');

type Item = { id: string; label: string; latency: number };
const http = createHttp({ fetch: server.fetch });
const page = new Nursery({ name: 'search-page' });

const input = $<HTMLInputElement>('#q');
const debounceBox = $<HTMLInputElement>('#debounce');

function timeline(el: HTMLElement) {
  let seq = 0;
  const rows = new Map<number, { el: HTMLElement; start: number; timer: number }>();
  return {
    start(q: string) {
      const id = ++seq;
      const row = h(`<div class="req"><span>#${id} “${q}”</span><div class="track"><i></i></div><span class="st">…</span></div>`);
      el.prepend(row);
      while (el.childElementCount > 8) el.lastElementChild!.remove();
      const start = performance.now();
      const bar = row.querySelector('i') as HTMLElement;
      const timer = window.setInterval(() => (bar.style.width = `${Math.min(100, (performance.now() - start) / 15)}%`), 50);
      rows.set(id, { el: row, start, timer });
      return id;
    },
    end(id: number, state: 'done' | 'cancelled' | 'stale', note?: string) {
      const r = rows.get(id);
      if (!r) return;
      clearInterval(r.timer);
      r.el.classList.add(state);
      r.el.querySelector('.st')!.textContent = note ?? `${state} ${Math.round(performance.now() - r.start)}ms`;
    },
  };
}

// ---- naive: whatever arrives gets rendered
{
  const tl = timeline($('#naive-timeline'));
  const results = $('#naive-results');
  let inflight = 0;
  let stale = 0;
  let newest = 0;
  const render = (items: Item[], reqId: number) => {
    results.replaceChildren(...items.map(i => h(`<li>${i.label}</li>`)));
    const isStale = reqId !== newest;
    results.classList.toggle('stale', isStale);
    if (isStale) {
      stale++;
      results.classList.remove('flash');
      void results.offsetWidth;
      results.classList.add('flash');
      $('#naive-stale').textContent = String(stale);
    }
  };
  input.addEventListener('input', () => {
    const q = input.value;
    const id = tl.start(q);
    newest = id;
    $('#naive-inflight').textContent = String(++inflight);
    http
      .get<Item[]>('/search', { nursery: page, query: { q } })
      .then(items => {
        tl.end(id, id === newest ? 'done' : 'stale', id === newest ? undefined : 'stale: перетёр');
        render(items, id);
      })
      .catch(err => tl.end(id, 'cancelled', String(err)))
      .finally(() => ($('#naive-inflight').textContent = String(--inflight)));
  });
}

// ---- latest(): the newest call aborts the previous one
{
  const tl = timeline($('#latest-timeline'));
  const results = $('#latest-results');
  let inflight = 0;
  let cancelled = 0;
  const ids = new WeakMap<AbortSignal, number>();
  const search = latest(async (q: string, signal: AbortSignal) => {
    const id = tl.start(q);
    ids.set(signal, id);
    $('#latest-inflight').textContent = String(++inflight);
    try {
      const items = await http.get<Item[]>('/search', { signal, query: { q } });
      tl.end(id, 'done');
      return items;
    } catch (err) {
      if (isAbort(err)) {
        cancelled++;
        $('#latest-cancelled').textContent = String(cancelled);
        tl.end(id, 'cancelled');
      }
      throw err;
    } finally {
      $('#latest-inflight').textContent = String(--inflight);
    }
  });
  page.spawn(async signal => {
    let stream = on<InputEvent>(input, 'input', { signal });
    for (;;) {
      const src = debounceBox.checked ? pipe(stream, debounce(150)) : stream;
      for await (const e of src) {
        if (debounceBox.checked !== (src !== stream)) break; // toggle changed: rebuild the pipeline
        search((e.target as HTMLInputElement).value, signal)
          .then(items => results.replaceChildren(...items.map(i => h(`<li>${i.label}</li>`))))
          .catch(err => {
            if (!isAbort(err)) throw err;
          });
      }
      if (signal.aborted) return;
      stream = on<InputEvent>(input, 'input', { signal });
    }
  }, { name: 'input-loop' });
}

// ---- storm: types a word quickly, one letter per 50 ms
$('#storm').addEventListener('click', async () => {
  const word = 'nursery!';
  input.value = '';
  for (const ch of word) {
    input.value += ch;
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 50));
  }
});
