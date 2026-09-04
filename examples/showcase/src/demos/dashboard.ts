import { createHttp, HttpError } from '@nursery/core/http';
import { Nursery, NurseryStuckError, type NurseryTree } from '@nursery/core/nursery';
import { isAbort, sleep } from '@nursery/core/signal';
import { server } from '../lib/server';
import { $, h, logger, mountHeader } from '../lib/page';

mountHeader('dashboard', 'дерево жизни', 'Страница владеет виджетами, виджеты владеют задачами. Закрыл виджет: его запросы, SSE и таймеры умерли. Закрыл страницу: умерло всё дерево, а зависшая задача попала в отчёт. Дерево справа обновляется вживую.');

const http = createHttp({ fetch: server.fetch });
const log = logger($('#log'));
let page = new Nursery({ name: 'page', grace: 2000 });
let n = 0;

Nursery.onUnhandled((err, { nursery, task }) => {
  if (err instanceof NurseryStuckError) log(`stuck: ${err.message}`, 'bad');
  else log(`unhandled in ${nursery.name}${task ? '/' + task.name : ''}: ${String(err)}`, 'warn');
});
$('#profiling').addEventListener('change', e => (Nursery.profiling = (e.target as HTMLInputElement).checked));

function renderTree(t: NurseryTree): HTMLElement {
  const state = t.closed ? 'closed' : t.aborted ? 'aborting' : 'open';
  const el = h(`<div class="n"><span class="name">${t.name}</span> <span class="state-${state}">[${state}]</span></div>`);
  for (const task of t.tasks) el.append(h(`<div class="n task">- ${task.name} <span class="age">${Math.round(task.elapsed)}ms</span></div>`));
  for (const c of t.children) el.append(renderTree(c));
  return el;
}
setInterval(() => $('#tree').replaceChildren(renderTree(page.inspect())), 200);

function widget(title: string, tag: string, body: (nursery: Nursery, out: HTMLElement) => void, opts: { timeout?: number } = {}) {
  const id = ++n;
  const nursery = page.child({ name: `${title}-${id}`, ...opts });
  const el = h(`<div class="card"><h2>${title} #${id} <span class="tag">${tag}</span></h2><div class="out stat" style="min-height:44px"></div><div class="row"><button class="close danger">закрыть виджет</button></div></div>`);
  $('#widgets').prepend(el);
  const out = el.querySelector('.out') as HTMLElement;
  el.querySelector('.close')!.addEventListener('click', async () => {
    await nursery.close();
    el.remove();
    log(`${nursery.name}: закрыт, задачи отменены`, 'dim');
  });
  body(nursery, out);
  // when the nursery dies for any reason, grey the card out
  nursery.signal.addEventListener('abort', () => el.style.opacity = '0.55', { once: true });
}

$('#add-status').addEventListener('click', () =>
  widget('status', 'timeout: 1500', (nursery, out) => {
    nursery.spawn(async sig => {
      for (;;) {
        try {
          const s = await http.get<{ load: string; at: string }>('/status', { signal: sig, nursery });
          out.textContent = `load ${s.load} · ${s.at} · осталось до дедлайна ${Math.round(nursery.remaining())}ms`;
        } catch (err) {
          if (isAbort(err)) { out.textContent = `отменено: ${(err as Error).message}`; throw err; }
          out.textContent = `ошибка: ${String(err)}`;
        }
        await sleep(700, sig);
      }
    }, { name: 'poll-status' });
    nursery.spawn(async sig => {
      for await (const e of http.sse('/ticker', { signal: sig, reconnect: { delay: 500, onRetry: (_e, a, d) => log(`${nursery.name}: sse reconnect #${a} через ${d}ms`, 'dim') } })) {
        out.textContent = `tick #${e.id} price ${JSON.parse(e.data).price} · осталось ${Math.round(nursery.remaining())}ms`;
      }
    }, { name: 'ticker-sse' });
  }, { timeout: 1500 + Math.round(Math.random() * 6000) }),
);

$('#add-flaky').addEventListener('click', () =>
  widget('fail-fast', 'ошибка одного отменяет остальных', (nursery, out) => {
    const a = nursery.spawn(async sig => {
      const r = await http.get('/flaky', { signal: sig });
      return `flaky ok ${JSON.stringify(r)}`;
    }, { name: 'flaky-request' });
    const b = nursery.spawn(async sig => {
      await sleep(5000, sig);
      return 'slow done';
    }, { name: 'slow-sibling-5s' });
    Promise.all([a, b]).then(
      r => (out.textContent = r.join(' · ')),
      err => (out.textContent = isAbort(err) ? `sibling aborted: ${(err as Error).message} (cause: ${String((err as Error).cause)})` : err instanceof HttpError ? `HTTP ${err.status}: остальные задачи отменены` : String(err)),
    );
  }),
);

$('#add-stuck').addEventListener('click', () =>
  widget('stuck', 'задача игнорирует signal', (nursery, out) => {
    nursery.spawn(() => new Promise(() => {}), { name: 'ignores-signal-forever' });
    nursery.spawn(async sig => { await sleep(600, sig); return 1; }, { name: 'polite' });
    out.textContent = 'закройте виджет или страницу: close() подождёт grace 2 с и отчитается о зависшей задаче';
  }),
);

$('#close-page').addEventListener('click', async () => {
  const t0 = performance.now();
  log('page.close(): отмена, ожидание, grace…', 'acc');
  await page.close();
  log(`page закрыта за ${Math.round(performance.now() - t0)}ms`, 'ok');
  $('#widgets').replaceChildren();
  page = new Nursery({ name: 'page', grace: 2000 });
  log('новая page создана', 'dim');
});
