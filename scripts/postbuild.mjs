// TypeScript 7 does not carry `/// <reference lib>` directives into declaration output, so add
// them here: consumers of DOM-dependent entries get the DOM lib without configuring it, while the
// core entries stay usable with @types/node alone. Usage: node scripts/postbuild.mjs <package>
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const pkg = process.argv[2];
if (!pkg) throw new Error('usage: postbuild.mjs <package dir name>');
const dist = resolve(import.meta.dirname, '..', 'packages', pkg, 'dist');
const refs =
  pkg === 'core'
    ? {
        dom: ['events', 'schedule', 'worker', 'testing', 'http', 'index'],
        'esnext.disposable': ['nursery', 'index'],
      }
    : { dom: ['index'], 'esnext.disposable': ['index'] };
for (const [lib, files] of Object.entries(refs)) {
  for (const f of files) {
    const p = join(dist, `${f}.d.ts`);
    if (!existsSync(p)) continue;
    const src = readFileSync(p, 'utf8');
    const line = `/// <reference lib="${lib}" />\n`;
    if (!src.includes(line)) writeFileSync(p, line + src);
  }
}
console.log(`postbuild(${pkg}): lib references added`);
