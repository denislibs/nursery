// Every `import { x } from '@scopekit/...'` in the cookbook must name a real export.
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const coreModules = [
  'diagnostics',
  'signal',
  'combine',
  'limit',
  'latest',
  'scope',
  'events',
  'iter',
  'schedule',
  'http',
  'worker',
  'testing',
];
const adapters = new Set(['react', 'vue', 'solid', 'svelte', 'angular']);
const exportsOfFile = file => {
  const names = new Set();
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(
    /export (?:async )?(?:function\*?|class|const|let|type|interface) ([A-Za-z_]+)/g,
  ))
    names.add(m[1]);
  return names;
};
const cache = new Map();
const exportsOf = spec => {
  if (cache.has(spec)) return cache.get(spec);
  let names;
  if (spec === '@scopekit/core') {
    names = new Set(['iter']);
    for (const m of coreModules)
      for (const n of exportsOfFile(join(repo, 'packages/core/src', m + '.ts'))) names.add(n);
  } else if (spec.startsWith('@scopekit/core/')) {
    const m = spec.slice('@scopekit/core/'.length);
    names = coreModules.includes(m) ? exportsOfFile(join(repo, 'packages/core/src', m + '.ts')) : new Set();
  } else {
    const a = spec.slice('@scopekit/'.length);
    names = adapters.has(a) ? exportsOfFile(join(repo, 'packages', a, 'src/index.ts')) : new Set();
  }
  cache.set(spec, names);
  return names;
};
let bad = 0;
for (const f of readdirSync(join(repo, 'cookbook'))) {
  const text = readFileSync(join(repo, 'cookbook', f), 'utf8');
  for (const m of text.matchAll(/import \{([^}]+)\} from '(@scopekit\/[a-z/]+)'/g)) {
    const names = exportsOf(m[2]);
    for (const raw of m[1].split(',')) {
      const n = raw
        .trim()
        .replace(/^type /, '')
        .split(/\s+as\s+/)[0];
      if (n && !names.has(n)) {
        bad++;
        console.log(`${f}: ${n} is not exported from ${m[2]}`);
      }
    }
  }
  for (const m of text.matchAll(/from 'scopekit(\/[a-z]+)?'/g)) {
    bad++;
    console.log(`${f}: legacy import ${m[0]}, use @scopekit/...`);
  }
}
console.log(bad ? `${bad} problems` : 'cookbook imports OK');
process.exit(bad ? 1 : 0);
