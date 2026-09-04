import { expose, transfer } from '@nursery/core/worker';
import { throwIfAborted } from '@nursery/core/signal';

/** Separable box blur, deliberately unoptimised so a 400×400 tile takes real time. */
function blur(pixels: Uint8ClampedArray, w: number, h: number, radius: number, signal: AbortSignal, onProgress: (p: number) => void) {
  const out = new Uint8ClampedArray(pixels.length);
  const tmp = new Uint8ClampedArray(pixels.length);
  for (let pass = 0; pass < 2; pass++) {
    const src = pass === 0 ? pixels : tmp;
    const dst = pass === 0 ? tmp : out;
    for (let y = 0; y < h; y++) {
      if (y % 16 === 0) {
        throwIfAborted(signal);
        onProgress((pass * h + y) / (2 * h));
      }
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0, n = 0;
        for (let k = -radius; k <= radius; k++) {
          const xx = pass === 0 ? Math.min(w - 1, Math.max(0, x + k)) : x;
          const yy = pass === 0 ? y : Math.min(h - 1, Math.max(0, y + k));
          const i = (yy * w + xx) * 4;
          r += src[i]!; g += src[i + 1]!; b += src[i + 2]!; n++;
        }
        const o = (y * w + x) * 4;
        dst[o] = r / n; dst[o + 1] = g / n; dst[o + 2] = b / n; dst[o + 3] = 255;
      }
    }
  }
  return out;
}

export const api = {
  async blur(tile: { pixels: Uint8ClampedArray; w: number; h: number; radius: number }, o: { signal: AbortSignal; onProgress: (p: number) => void }) {
    const out = blur(tile.pixels, tile.w, tile.h, tile.radius, o.signal, o.onProgress);
    return transfer({ pixels: out }, [out.buffer]);
  },
};
export { blur };
expose(api);
