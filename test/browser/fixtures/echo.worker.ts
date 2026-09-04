import { expose } from '../../../src/worker.js';
import { sleep, isAbort } from '../../../src/signal.js';

let lastAbort: string | undefined;

export const api = {
  double: async (n: number) => n * 2,
  slow: async (ms: number, opts: { signal: AbortSignal }) => {
    try {
      await sleep(ms, opts.signal);
      return 'finished';
    } catch (e) {
      if (isAbort(e)) lastAbort = (e as Error).message;
      throw e;
    }
  },
  lastAbort: async () => lastAbort,
  boom: async () => { throw new TypeError('bad input'); },
};

expose(api);
