// TypeScript 7 does not carry `/// <reference lib>` directives into declaration output, so add
// them here: consumers of the DOM-dependent entries then get the DOM lib without configuring it,
// while the core entries stay usable with @types/node alone.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dist = resolve(import.meta.dirname, '..', 'dist');
const refs = {
  dom: [
    'events',
    'schedule',
    'worker',
    'testing',
    'http',
    'index',
    'react',
    'vue',
    'solid',
    'svelte',
    'angular',
  ],
  'esnext.disposable': ['scope', 'index'],
};
for (const [lib, files] of Object.entries(refs)) {
  for (const f of files) {
    const p = join(dist, `${f}.d.ts`);
    if (!existsSync(p)) continue;
    const src = readFileSync(p, 'utf8');
    const line = `/// <reference lib="${lib}" />\n`;
    if (!src.startsWith(line) && !src.includes(line)) writeFileSync(p, line + src);
  }
}
console.log('postbuild: lib references added');
