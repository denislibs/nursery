import { expose } from '@scopekit/core/worker';
import { throwIfAborted } from '@scopekit/core/signal';

export const api = {
  async primes(limit: number, o: { signal: AbortSignal; onProgress: (p: number) => void }) {
    const found: number[] = [];
    for (let n = 2; n < limit; n++) {
      if (n % 1000 === 0) {
        throwIfAborted(o.signal);
        o.onProgress(n / limit);
      }
      let prime = true;
      for (let d = 2; d * d <= n; d++) if (n % d === 0) { prime = false; break; }
      if (prime) found.push(n);
    }
    return found.length;
  },
};
expose(api);
