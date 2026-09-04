/** Frame meter: counts requestAnimationFrame ticks; drops to red when the main thread is blocked. */
export function mountFps(el: HTMLElement) {
  let frames = 0;
  let last = performance.now();
  let worst = 0;
  let prev = last;
  const tick = (t: number) => {
    frames++;
    worst = Math.max(worst, t - prev);
    prev = t;
    if (t - last >= 500) {
      const fps = Math.round((frames * 1000) / (t - last));
      el.textContent = `${fps} fps · worst frame ${Math.round(worst)}ms`;
      el.classList.toggle('bad', fps < 30 || worst > 100);
      frames = 0;
      worst = 0;
      last = t;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
