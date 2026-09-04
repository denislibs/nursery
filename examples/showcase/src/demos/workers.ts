import { createPool, callback, transfer } from '@nursery/core/worker';
import { map } from '@nursery/core/limit';
import { Nursery } from '@nursery/core/nursery';
import { isAbort } from '@nursery/core/signal';
import { mountFps } from '../lib/fps';
import { $, h, logger, mountHeader } from '../lib/page';
import type { api as BlurApi } from '../blur.worker';
import { blur as blurOnMain } from '../blur.worker';

mountHeader('workers', 'воркеры', 'Тяжёлое размытие картинки 1600×1600. На главном потоке страница замирает на секунды; в пуле воркеров она остаётся живой, показывает прогресс по тайлам и отменяется мгновенно.');

const SIZE = 1600;
const GRID = 4;
const TILE = SIZE / GRID;
const canvas = $<HTMLCanvasElement>('#img');
const ctx = canvas.getContext('2d')!;
const log = logger($('#log'));
mountFps($('#fps'));

function paintSource() {
  const g = ctx.createLinearGradient(0, 0, SIZE, SIZE);
  g.addColorStop(0, '#7c9cff'); g.addColorStop(0.5, '#b48cff'); g.addColorStop(1, '#4ade80');
  ctx.fillStyle = g; ctx.fillRect(0, 0, SIZE, SIZE);
  for (let i = 0; i < 400; i++) {
    ctx.fillStyle = `hsl(${(i * 47) % 360} 80% ${30 + (i % 5) * 10}%)`;
    const s = 10 + (i * 37) % 80;
    ctx.fillRect((i * 991) % SIZE, (i * 577) % SIZE, s, s);
  }
  ctx.fillStyle = '#0b0e14';
  ctx.font = 'bold 160px system-ui';
  ctx.fillText('nursery', 120, 900);
}
paintSource();

const tilesEl = $('#tiles');
const tileBars: HTMLElement[] = [];
for (let i = 0; i < GRID * GRID; i++) {
  const t = h('<div class="t"><i></i></div>');
  tilesEl.append(t);
  tileBars.push(t);
}
const resetTiles = () => tileBars.forEach(t => { t.classList.remove('done'); (t.querySelector('i') as HTMLElement).style.height = '0'; });
const tileProgress = (i: number, p: number) => ((tileBars[i]!.querySelector('i') as HTMLElement).style.height = `${p * 100}%`);
const tileDone = (i: number) => { tileBars[i]!.classList.add('done'); tileProgress(i, 1); };

const pool = createPool<typeof BlurApi>(() => new Worker(new URL('../blur.worker.ts', import.meta.url), { type: 'module' }));
const radius = () => Number($<HTMLInputElement>('#radius').value);
$('#radius').addEventListener('input', () => ($('#radius-v').textContent = String(radius())));

let current: Nursery | undefined;
const setBusy = (busy: boolean) => {
  $<HTMLButtonElement>('#main').disabled = busy;
  $<HTMLButtonElement>('#pool').disabled = busy;
  $<HTMLButtonElement>('#cancel').disabled = !busy;
};

function tiles() {
  return Array.from({ length: GRID * GRID }, (_, i) => ({ i, x: (i % GRID) * TILE, y: Math.floor(i / GRID) * TILE }));
}

$('#main').addEventListener('click', () => {
  paintSource(); resetTiles();
  log('главный поток: старт, спиннер и fps сейчас встанут', 'warn');
  const t0 = performance.now();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const ctrl = new AbortController();
    for (const t of tiles()) {
      const img = ctx.getImageData(t.x, t.y, TILE, TILE);
      const out = blurOnMain(img.data, TILE, TILE, radius(), ctrl.signal, () => {});
      ctx.putImageData(new ImageData(out, TILE, TILE), t.x, t.y);
      tileDone(t.i);
    }
    $('#took').textContent = `${Math.round(performance.now() - t0)}ms одним куском`;
    log(`главный поток: готово за ${Math.round(performance.now() - t0)}ms`, 'bad');
  }));
});

$('#pool').addEventListener('click', async () => {
  paintSource(); resetTiles();
  current = new Nursery({ name: 'blur' });
  setBusy(true);
  let done = 0;
  $('#tiles-done').textContent = '0';
  const t0 = performance.now();
  log(`пул: старт, до ${navigator.hardwareConcurrency ?? 4} воркеров`, 'acc');
  try {
    await current.spawn(signal =>
      map(tiles(), async (t, _i, sig) => {
        const img = ctx.getImageData(t.x, t.y, TILE, TILE);
        const pixels = img.data;
        const result = await pool.api.blur(transfer({ pixels, w: TILE, h: TILE, radius: radius() }, [pixels.buffer]), {
          signal: sig,
          onProgress: callback((p: number) => tileProgress(t.i, p)),
        });
        ctx.putImageData(new ImageData(result.pixels, TILE, TILE), t.x, t.y);
        tileDone(t.i);
        $('#tiles-done').textContent = String(++done);
        $('#size').textContent = String(pool.size);
      }, { concurrency: navigator.hardwareConcurrency ?? 4, signal }),
    { name: 'blur-tiles' });
    $('#took').textContent = `${Math.round(performance.now() - t0)}ms, страница жива`;
    log(`пул: готово за ${Math.round(performance.now() - t0)}ms на ${pool.size} воркерах`, 'ok');
  } catch (err) {
    if (isAbort(err)) log('пул: отменено, воркеры прервали свои циклы', 'warn');
    else { log(String(err), 'bad'); throw err; }
  } finally {
    setBusy(false);
    await current.close();
    current = undefined;
  }
});
$('#cancel').addEventListener('click', () => current?.abort());
