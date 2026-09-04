// Type-checks every ```ts / ```tsx block in the cookbook against the real packages, so a recipe
// that drifts from the API fails here rather than on a reader's machine.
// Conventions: imports shown in earlier blocks of the same file apply to later blocks; a block
// starting with `// skip-check` is skipped; undefined helpers (api, render, ...) come from
// scripts/cookbook-prelude.d.ts.
import {
  readFileSync,
  readdirSync,
  mkdtempSync,
  writeFileSync,
  symlinkSync,
  mkdirSync,
  rmSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = resolve(import.meta.dirname, '..');
const dir = mkdtempSync(join(tmpdir(), 'scopekit-cookbook-'));
mkdirSync(join(dir, 'node_modules', '@scopekit'), { recursive: true });
symlinkSync(join(repo, 'node_modules', '@types'), join(dir, 'node_modules', '@types'), 'dir');
for (const p of ['core', 'react', 'vue', 'solid', 'svelte', 'angular']) {
  symlinkSync(join(repo, 'packages', p), join(dir, 'node_modules', '@scopekit', p), 'dir');
}
for (const dep of ['react', 'react-dom', 'vue', 'solid-js', 'svelte', '@angular', 'rxjs']) {
  try {
    symlinkSync(join(repo, 'node_modules', dep), join(dir, 'node_modules', dep), 'dir');
  } catch {
    /* optional */
  }
}
writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
copyFileSync(join(repo, 'scripts', 'cookbook-prelude.d.ts'), join(dir, 'prelude.d.ts'));
// worker modules the recipes import relatively
const workerStub = `import type { Remote } from '@scopekit/core/worker';\nexport const api = { parse: async (_src: string, _o: { signal: AbortSignal }): Promise<unknown> => null, compute: async (_d: unknown, _o: { signal: AbortSignal }): Promise<unknown> => null, blur: async (_i: unknown) => ({ pixels: new Uint8ClampedArray(0) }), index: async (..._a: unknown[]) => 0, process: async (_b: ArrayBuffer, _o?: unknown) => 0, produce: async (..._a: unknown[]) => 0, run: async (..._a: unknown[]) => 0 };\nexport type Api = typeof api;\nexport type _R = Remote<Api>;\n`;
for (const f of ['parser.worker.ts', 'w.ts', 'worker.ts', 'shared.ts', 'echo.worker.ts', 'heavy.worker.ts'])
  writeFileSync(join(dir, f), workerStub);

/** Consolidates import lines per module and drops duplicate names (later sections re-import freely). */
function mergeImports(lines) {
  const named = new Map(); // module -> Set of "name" | "type name"
  const other = [];
  const seenNames = new Set();
  for (const line of lines) {
    const m = /^import\s+(type\s+)?\{([^}]*)\}\s+from\s+'([^']+)';?$/.exec(line);
    if (!m) {
      if (!other.includes(line)) other.push(line);
      continue;
    }
    const typeOnly = Boolean(m[1]);
    const mod = m[3];
    for (const raw of m[2].split(',')) {
      const spec = raw.trim();
      if (!spec) continue;
      const local = spec
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)
        .pop();
      if (seenNames.has(local)) continue;
      seenNames.add(local);
      if (!named.has(mod)) named.set(mod, new Set());
      named.get(mod).add(typeOnly && !spec.startsWith('type ') ? `type ${spec}` : spec);
    }
  }
  const out = [...other];
  for (const [mod, names] of named) out.push(`import { ${[...names].join(', ')} } from '${mod}';`);
  return out;
}

const files = ['prelude.d.ts'];
let blocks = 0;
for (const md of readdirSync(join(repo, 'cookbook')).filter(f => f.endsWith('.md'))) {
  const text = readFileSync(join(repo, 'cookbook', md), 'utf8');
  // imports from blocks before the first H2 apply to the whole file; imports inside a section
  // apply to later blocks of that section only, so sections about different frameworks can
  // import clashing names
  const re = /(^## .*$)|```(ts|tsx)\n([\s\S]*?)```/gm;
  const fileImports = new Set();
  let sectionImports = new Set();
  let inSection = false;
  let m;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m[1] !== undefined) {
      inSection = true;
      sectionImports = new Set();
      continue;
    }
    const [, , lang, code] = m;
    i++;
    if (/^\s*\/\/\s*skip-check/.test(code)) continue;
    const own = [];
    const body = [];
    for (const line of code.split('\n')) {
      if (/^import\s.*\sfrom\s+'[^']+';?\s*(\/\/.*)?$/.test(line))
        own.push(line.replace(/\s*\/\/.*$/, '').trim());
      else body.push(line);
    }
    const bucket = inSection ? sectionImports : fileImports;
    const imports = mergeImports([...fileImports, ...sectionImports, ...own]);
    for (const l of own) bucket.add(l);
    const name = `${md.replace(/\.md$/, '')}-${String(i).padStart(2, '0')}.${lang}`;
    // blocks are usually fragments of some handler: wrap them so `return` and `await` are legal;
    // blocks with top-level exports are checked as modules
    const fragment = !body.some(l => /^\s*export\b/.test(l));
    const text2 = fragment
      ? `async function __fragment() {\n${body.join('\n')}\n}\nvoid __fragment;`
      : body.join('\n');
    writeFileSync(join(dir, name), `${imports.join('\n')}\nexport {};\n// ---- block ----\n${text2}\n`);
    files.push(name);
    blocks++;
  }
}
writeFileSync(
  join(dir, 'tsconfig.json'),
  JSON.stringify({
    compilerOptions: {
      module: 'ESNext',
      moduleResolution: 'Bundler',
      target: 'ES2022',
      lib: ['ES2023', 'DOM', 'ESNext.Disposable'],
      jsx: 'react-jsx',
      strict: true,
      noImplicitAny: false,
      noEmit: true,
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      paths: {
        '@scopekit/core': ['./node_modules/@scopekit/core/src/index.ts'],
        '@scopekit/core/*': ['./node_modules/@scopekit/core/src/*.ts'],
        '@scopekit/react': ['./node_modules/@scopekit/react/src/index.ts'],
        '@scopekit/vue': ['./node_modules/@scopekit/vue/src/index.ts'],
        '@scopekit/solid': ['./node_modules/@scopekit/solid/src/index.ts'],
        '@scopekit/svelte': ['./node_modules/@scopekit/svelte/src/index.ts'],
        '@scopekit/angular': ['./node_modules/@scopekit/angular/src/index.ts'],
      },
    },
    files,
  }),
);
const r = spawnSync(join(repo, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json'], {
  cwd: dir,
  encoding: 'utf8',
});
const errors = (r.stdout + r.stderr).split('\n').filter(l => /error TS/.test(l));
if (r.status === 0) console.log(`cookbook compile OK: ${blocks} blocks`);
else console.log(`cookbook compile FAILED: ${errors.length} errors\n${errors.slice(0, 400).join('\n')}`);
if (process.env.KEEP) console.log('kept:', dir);
else rmSync(dir, { recursive: true, force: true });
process.exit(r.status === 0 ? 0 : 1);
