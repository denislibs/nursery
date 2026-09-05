// A consumer bundled from the *published* layout (dist via package exports), not from src.
// Bundlers drop side-effect-only imports of packages marked `sideEffects: false`; this entry
// exists so a bundle without the Symbol.dispose polyfill can be detected.
import { Nursery } from '@nursery/core';
import { wrap } from '@nursery/core/worker';

export const hasDisposeSymbols =
  typeof Symbol.dispose === 'symbol' && typeof Symbol.asyncDispose === 'symbol';

export async function probe() {
  const n = new Nursery({ name: 'consumer' });
  const value = await n.spawn(async () => 'ok');
  await n[Symbol.asyncDispose]();
  return { value, wrapIsFunction: typeof wrap === 'function' };
}
