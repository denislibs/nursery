// Verifies the published types compile for consumers that do not enable the DOM lib:
//  1. core subpaths with @types/node only;
//  2. DOM-dependent entries with @types/node only (they must pull in the DOM lib themselves).
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = resolve(import.meta.dirname, '..');
const root = join(repo, 'packages', 'core');
const pkg = JSON.parse(readFile('package.json'));
const name = pkg.name;
const dir = mkdtempSync(join(tmpdir(), 'scopekit-types-'));
mkdirSync(join(dir, 'node_modules', '@types'), { recursive: true });
rmSync(join(dir, 'node_modules', '@types'), { recursive: true });
symlinkSync(join(repo, 'node_modules', '@types'), join(dir, 'node_modules', '@types'), 'dir');
const target = name.startsWith('@')
  ? join(dir, 'node_modules', name.split('/')[0])
  : join(dir, 'node_modules');
mkdirSync(target, { recursive: true });
symlinkSync(root, join(dir, 'node_modules', name), 'dir');
writeFileSync(join(dir, 'package.json'), '{"type":"module"}');

const cases = {
  'core.ts': `
    import { Scope, contextKey } from '${name}/scope';
    import { sleep, anySignal } from '${name}/signal';
    import { retry, withTimeout } from '${name}/combine';
    import { Semaphore, Queue, map } from '${name}/limit';
    import { latest, latestBy } from '${name}/latest';
    import { pipe, debounce, toArray } from '${name}/iter';
    import { onWarning } from '${name}/diagnostics';
    export const all = { Scope, contextKey, sleep, anySignal, retry, withTimeout, Semaphore, Queue, map, latest, latestBy, pipe, debounce, toArray, onWarning };`,
  'dom.ts': `
    import { on, Channel } from '${name}/events';
    import { createHttp } from '${name}/http';
    import { wrap } from '${name}/worker';
    import { chunked } from '${name}/schedule';
    import { fakeFetch } from '${name}/testing';
    import { Scope } from '${name}';
    export const all = { on, Channel, createHttp, wrap, chunked, fakeFetch, Scope };`,
};
let failed = false;
for (const [file, code] of Object.entries(cases)) {
  writeFileSync(join(dir, file), code);
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        lib: ['ES2023'],
        types: ['node'],
        skipLibCheck: false,
      },
      files: [file],
    }),
  );
  const r = spawnSync(join(repo, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json'], {
    cwd: dir,
    encoding: 'utf8',
  });
  if (r.status === 0) console.log(`consumer types OK: ${file} (lib ES2023 + @types/node)`);
  else {
    failed = true;
    console.log(`consumer types FAILED: ${file}\n${r.stdout}${r.stderr}`);
  }
}
rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);

function readFile(p) {
  return readFileSync(join(root, p), 'utf8');
}
