import { chunked, frameInterval } from '@nursery/core/schedule';
import { Nursery } from '@nursery/core/nursery';
import { isAbort } from '@nursery/core/signal';
import { mountFps } from '../lib/fps';
import { $, logger, mountHeader } from '../lib/page';

mountHeader('table', 'главный поток', 'Одна и та же работа: 50 000 строк в таблицу. Разница только в том, уступает ли цикл главный поток. Смотрите на fps, спиннер и счётчик кликов.');

const ROWS = 50_000;
const tbody = $('#tbody');
const log = logger($('#log'));
mountFps($('#fps'));

let clicks = 0;
$('#click').addEventListener('click', () => ($('#clicks').textContent = String(++clicks)));

const rows = Array.from({ length: ROWS }, (_, i) => ({ id: i + 1, sku: `SKU-${(i * 7919) % 100000}`, qty: (i * 31) % 97, price: ((i * 13) % 1000) / 10 }));
const renderRow = (r: (typeof rows)[number]) => {
  const tr = document.createElement('tr');
  tr.innerHTML = `<td>${r.id}</td><td>${r.sku}</td><td>${r.qty}</td><td>${r.price.toFixed(2)}</td>`;
  return tr;
};

void frameInterval().then(ms => {
  $('#frame').textContent = `${ms.toFixed(1)}ms`;
  $('#budget').textContent = `${(ms / 2).toFixed(1)}ms`;
});

let current: Nursery | undefined;
const setBusy = (busy: boolean) => {
  $<HTMLButtonElement>('#sync').disabled = busy;
  $<HTMLButtonElement>('#chunked').disabled = busy;
  $<HTMLButtonElement>('#cancel').disabled = !busy;
};

$('#sync').addEventListener('click', () => {
  tbody.replaceChildren();
  log('sync: старт, вкладка сейчас замрёт', 'warn');
  const t0 = performance.now();
  // give the log line a chance to paint before the freeze
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      for (const r of rows) tbody.append(renderRow(r));
      $('#count').textContent = String(ROWS);
      $('#progress').style.width = '100%';
      $('#took').textContent = `${Math.round(performance.now() - t0)}ms одним куском`;
      log(`sync: готово за ${Math.round(performance.now() - t0)}ms, всё это время ввод не обрабатывался`, 'bad');
    }),
  );
});

$('#chunked').addEventListener('click', async () => {
  tbody.replaceChildren();
  current = new Nursery({ name: 'render' });
  setBusy(true);
  const t0 = performance.now();
  let yields = 0;
  log('chunked: старт, бюджет auto', 'acc');
  try {
    await current.spawn(async signal => {
      let n = 0;
      let lastYield = performance.now();
      for await (const r of chunked(rows, { signal })) {
        const now = performance.now();
        if (now - lastYield > 5) yields++; // a gap means the loop yielded
        lastYield = now;
        tbody.append(renderRow(r));
        if (++n % 500 === 0) {
          $('#count').textContent = String(n);
          $('#progress').style.width = `${(n / ROWS) * 100}%`;
        }
      }
      $('#count').textContent = String(n);
    }, { name: 'chunked-render' });
    $('#took').textContent = `${Math.round(performance.now() - t0)}ms, ~${yields} уступок`;
    log(`chunked: готово за ${Math.round(performance.now() - t0)}ms, fps не проседал, клики срабатывали сразу`, 'ok');
  } catch (err) {
    if (isAbort(err)) log('chunked: отменено, DOM остался в том состоянии, где остановились', 'warn');
    else throw err;
  } finally {
    setBusy(false);
    await current.close();
    current = undefined;
  }
});

$('#cancel').addEventListener('click', () => current?.abort());
