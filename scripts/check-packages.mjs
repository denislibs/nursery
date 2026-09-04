// publint + arethetypeswrong for every workspace package (run after build).
import { readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = resolve(import.meta.dirname, '..');
const bin = name => join(repo, 'node_modules', '.bin', name);
let failed = false;
for (const dir of readdirSync(join(repo, 'packages'))) {
  const cwd = join(repo, 'packages', dir);
  if (!existsSync(join(cwd, 'package.json'))) continue;
  for (const [label, cmd, args] of [
    ['publint', bin('publint'), ['--strict']],
    ['attw', bin('attw'), ['--pack', '.', '--profile', 'esm-only']],
  ]) {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
    const ok = r.status === 0;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${label} ${dir}`);
    if (!ok) {
      failed = true;
      console.log(r.stdout + r.stderr);
    }
  }
}
process.exit(failed ? 1 : 0);
