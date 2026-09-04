import { on } from '@nursery/core/events';
import { pipe, throttle } from '@nursery/core/iter';
import { race } from '@nursery/core/combine';
import { sleep, isAbort, anySignal } from '@nursery/core/signal';
import { Nursery } from '@nursery/core/nursery';
import { $, h, logger, mountHeader } from '../lib/page';

mountHeader('gestures', 'жесты', 'Жесты читаются сверху вниз, как обычный код: pointerdown открывает цикл по pointermove, pointerup его закрывает. Отмена, буферизация и throttle встроены в поток событий.');

const page = new Nursery({ name: 'gestures' });
const log = logger($('#log'));

async function once<E extends Event>(target: EventTarget, type: string, signal: AbortSignal): Promise<E> {
  for await (const e of on<E>(target, type, { signal })) return e;
  throw signal.reason;
}

// ---- drawing
{
  const canvas = $<HTMLCanvasElement>('#board');
  const ctx = canvas.getContext('2d')!;
  const fit = () => { canvas.width = canvas.clientWidth * devicePixelRatio; canvas.height = canvas.clientHeight * devicePixelRatio; ctx.scale(devicePixelRatio, devicePixelRatio); };
  fit();
  let strokes = 0;
  let points = 0;
  $('#clear').addEventListener('click', () => ctx.clearRect(0, 0, canvas.width, canvas.height));
  page.spawn(async signal => {
    for await (const down of on(canvas, 'pointerdown', { signal })) {
      canvas.setPointerCapture(down.pointerId);
      const stroke = new AbortController();
      const stop = anySignal([signal, stroke.signal]);
      once(canvas, 'pointerup', stop).then(() => stroke.abort(), () => {});
      let prev = { x: down.offsetX, y: down.offsetY };
      ctx.strokeStyle = `hsl(${(strokes * 47) % 360} 85% 65%)`;
      ctx.lineWidth = 3; ctx.lineCap = 'round';
      strokes++;
      $('#strokes').textContent = String(strokes);
      for await (const move of pipe(on(canvas, 'pointermove', { signal: stop, buffer: 1 }), throttle(8))) {
        ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(move.offsetX, move.offsetY); ctx.stroke();
        prev = { x: move.offsetX, y: move.offsetY };
        $('#points').textContent = String(++points);
      }
    }
  }, { name: 'draw-loop' });
}

// ---- hold to confirm
{
  const button = $<HTMLButtonElement>('#hold');
  const fill = button.querySelector('i') as HTMLElement;
  const st = $('#hold-st');
  page.spawn(async signal => {
    for await (const _down of on(button, 'pointerdown', { signal })) {
      st.textContent = 'держим…';
      const t0 = performance.now();
      const anim = setInterval(() => (fill.style.width = `${Math.min(100, ((performance.now() - t0) / 1200) * 100)}%`), 16);
      try {
        const outcome = await race([
          sig => once(button, 'pointerup', sig).then(() => 'released' as const),
          sig => sleep(1200, sig).then(() => 'confirmed' as const),
        ], signal);
        st.textContent = outcome === 'confirmed' ? 'подтверждено ✓' : `отпущено через ${Math.round(performance.now() - t0)}ms, таймер отменён`;
        log(outcome === 'confirmed' ? 'hold: confirmed' : 'hold: released early, sleep() aborted', outcome === 'confirmed' ? 'ok' : 'dim');
      } catch (err) {
        if (!isAbort(err)) throw err;
      } finally {
        clearInterval(anim);
        fill.style.width = '0';
      }
    }
  }, { name: 'hold-loop' });
}

// ---- sortable list
{
  const list = $('#sortable');
  for (const t of ['Nursery', 'signal', 'combine', 'limit', 'latest', 'events']) list.append(h(`<li>${t}</li>`));
  page.spawn(async signal => {
    for await (const down of on(list, 'pointerdown', { signal })) {
      const item = (down.target as HTMLElement).closest('li');
      if (!item) continue;
      item.setPointerCapture(down.pointerId);
      item.classList.add('dragging');
      const drag = new AbortController();
      const stop = anySignal([signal, drag.signal]);
      once(item, 'pointerup', stop).then(() => drag.abort(), () => {});
      for await (const move of pipe(on(item, 'pointermove', { signal: stop, buffer: 1 }), throttle(16))) {
        const over = document.elementFromPoint(move.clientX, move.clientY)?.closest('li');
        if (!over || over === item || over.parentElement !== list) continue;
        const rect = over.getBoundingClientRect();
        list.insertBefore(item, move.clientY < rect.top + rect.height / 2 ? over : over.nextSibling);
      }
      item.classList.remove('dragging');
      log(`sortable: ${[...list.children].map(li => li.textContent).join(' → ')}`, 'dim');
    }
  }, { name: 'sortable-loop' });
}
