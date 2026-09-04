import { createHttp, HttpError } from '@nursery/core/http';
import { Queue } from '@nursery/core/limit';
import { Nursery } from '@nursery/core/nursery';
import { isAbort } from '@nursery/core/signal';
import { server } from '../lib/server';
import { $, h, logger, mountHeader, rand } from '../lib/page';

mountHeader('uploads', 'очередь', 'Менеджер загрузок, каким его хотят пользователи: лимит параллельности, приоритеты, пауза, отмена одного файла, ретраи с backoff и настоящий прогресс отправки. Всё это один Queue и один http-клиент.');

const http = createHttp({ fetch: server.fetch });
const page = new Nursery({ name: 'uploads' });
const log = logger($('#log'));
const list = $('#files');
let concurrency = 3;
let queue = makeQueue();
let seq = 0;
let done = 0;
let retries = 0;

function makeQueue() {
  const q = new Queue({ concurrency, signal: page.signal });
  const stats = () => {
    $('#queued').textContent = String(q.size);
    $('#pending').textContent = String(q.pending);
  };
  setInterval(stats, 100);
  return q;
}

$('#conc').addEventListener('input', e => {
  concurrency = Number((e.target as HTMLInputElement).value);
  $('#conc-v').textContent = String(concurrency);
  log(`concurrency = ${concurrency} (применится к новым файлам: очередь пересоздана)`, 'dim');
  queue = makeQueue();
});
$('#pause').addEventListener('click', () => {
  queue.pause();
  $<HTMLButtonElement>('#pause').disabled = true;
  $<HTMLButtonElement>('#resume').disabled = false;
  log('пауза: идущие докачаются, новые не стартуют', 'warn');
});
$('#resume').addEventListener('click', () => {
  queue.resume();
  $<HTMLButtonElement>('#pause').disabled = false;
  $<HTMLButtonElement>('#resume').disabled = true;
  log('продолжаем', 'ok');
});
$('#clear').addEventListener('click', () => {
  queue.clear();
  log('ожидающие отменены', 'warn');
});

function addFile() {
  const id = ++seq;
  const size = Math.round(rand(200, 2000)) * 1024;
  const name = `photo-${String(id).padStart(3, '0')}.jpg`;
  const blob = new Blob([new Uint8Array(size)]);
  const ctrl = new AbortController();
  let priority = 0;
  const el = h(`<div class="file"><span class="name">${name} <span class="stat">${Math.round(size / 1024)} KB</span></span><div class="bar"><i></i></div><span class="st">в очереди</span><span><button class="star" title="приоритет">★</button> <button class="x" title="отменить">×</button></span></div>`);
  list.prepend(el);
  const bar = el.querySelector('i') as HTMLElement;
  const st = el.querySelector('.st') as HTMLElement;
  el.querySelector('.x')!.addEventListener('click', () => ctrl.abort());
  const enqueue = () => {
    queue
      .add(
        async sig => {
          st.textContent = 'отправка';
          await http.post('/upload', {
            signal: sig,
            body: blob,
            retry: {
              retries: 3,
              delay: 300,
              factor: 2,
              onRetry: (err, attempt, wait) => {
                retries++;
                $('#retries').textContent = String(retries);
                st.textContent = `ретрай ${attempt + 1} через ${wait}ms`;
                log(`${name}: ${err instanceof HttpError ? `HTTP ${err.status}` : String(err)} → ретрай через ${wait}ms`, 'warn');
              },
            },
            onUploadProgress: (sent, total) => (bar.style.width = `${(sent / total) * 100}%`),
          });
        },
        { priority, signal: ctrl.signal },
      )
      .then(() => {
        el.classList.add('done');
        st.textContent = 'готово';
        bar.parentElement!.classList.add('ok');
        $('#done').textContent = String(++done);
      })
      .catch(err => {
        if (isAbort(err)) {
          el.classList.add('cancelled');
          st.textContent = 'отменено';
        } else {
          el.classList.add('failed');
          st.textContent = err instanceof HttpError ? `ошибка ${err.status}` : 'ошибка';
          bar.parentElement!.classList.add('bad');
          log(`${name}: не удалось после ретраев`, 'bad');
        }
      });
  };
  el.querySelector('.star')!.addEventListener('click', () => {
    // re-queue with a higher priority: cancel the waiting entry and add it again
    priority = 10;
    el.classList.add('priority');
    ctrl.abort();
    const fresh = new AbortController();
    (ctrl as { signal: AbortSignal }).signal = fresh.signal;
    st.textContent = 'приоритет';
    log(`${name}: приоритет ↑`, 'acc');
    queueMicrotask(enqueue);
  });
  enqueue();
}

$('#add').addEventListener('click', () => {
  for (let i = 0; i < 12; i++) addFile();
  log('добавлено 12 файлов', 'dim');
});
