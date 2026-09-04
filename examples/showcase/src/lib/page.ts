/** Shared chrome for every demo page: header, nav, log panel helpers. */
export const pages = [
  ['index', 'Обзор'],
  ['search', 'Гонки'],
  ['table', 'Главный поток'],
  ['uploads', 'Очередь'],
  ['workers', 'Воркеры'],
  ['dashboard', 'Nursery'],
  ['gestures', 'Жесты'],
] as const;

export function mountHeader(current: string, title: string, lead: string) {
  const el = document.createElement('div');
  el.innerHTML = `
    <header class="top">
      <h1>nursery <span>/ ${title}</span></h1>
      <nav>${pages.map(([p, t]) => `<a href="./${p}.html" class="${p === current ? 'current' : ''}">${t}</a>`).join('')}</nav>
    </header>
    <p class="lead">${lead}</p>`;
  document.querySelector('.wrap')!.prepend(el);
}

export type LogLevel = 'ok' | 'bad' | 'warn' | 'dim' | 'acc' | '';

export function logger(el: HTMLElement, max = 200) {
  const t0 = performance.now();
  return (msg: string, level: LogLevel = '') => {
    const line = document.createElement('div');
    line.className = level;
    line.textContent = `${((performance.now() - t0) / 1000).toFixed(2).padStart(6)}s  ${msg}`;
    el.append(line);
    while (el.childElementCount > max) el.firstElementChild!.remove();
    el.scrollTop = el.scrollHeight;
  };
}

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
export const h = (html: string) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
};
export const fmtMs = (ms: number) => `${Math.round(ms)}ms`;
export const rand = (min: number, max: number) => min + Math.random() * (max - min);
