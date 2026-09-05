// Bundles a consumer of the *built* packages with esbuild, Vite (rollup) and webpack, then
//  1. asserts statically that the Symbol.dispose polyfill survived tree-shaking in every bundle
//     (and in the CDN bundle), and
//  2. runs the bundles in Chromium, Firefox and WebKit.
// `sideEffects: false` plus a bare `import './polyfill.js'` is exactly the combination bundlers
// silently strip, which crashes class definitions using [Symbol.asyncDispose] in Firefox/WebKit.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import webpack from 'webpack';

const repo = resolve(import.meta.dirname, '..');
const dir = resolve(repo, 'test/consumer-bundle');
const entry = resolve(dir, 'entry.js');
const out = resolve(dir, '.out');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await esbuild({
  entryPoints: [entry],
  outfile: resolve(out, 'esbuild.js'),
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  logLevel: 'error',
});

await viteBuild({
  root: dir,
  logLevel: 'error',
  configFile: false,
  build: {
    outDir: out,
    emptyOutDir: false,
    minify: false,
    target: 'es2022',
    lib: { entry, formats: ['es'], fileName: () => 'vite.js' },
  },
});

await new Promise((done, fail) => {
  webpack(
    {
      mode: 'production',
      entry,
      output: { path: out, filename: 'webpack.js', module: true, library: { type: 'module' } },
      experiments: { outputModule: true },
      optimization: { minimize: false },
      target: ['web', 'es2022'],
      // webpack 5.1xx maps tsconfig `paths` by default; the root tsconfig points @nursery/core at src.
      resolve: { tsconfig: false },
    },
    (err, stats) => {
      if (err) return fail(err);
      if (stats.hasErrors()) return fail(new Error(stats.toString({ colors: false })));
      done();
    },
  );
});

// dist files carry sourceMappingURL comments that no longer point anywhere once bundled.
for (const name of ['esbuild.js', 'vite.js', 'webpack.js']) {
  const file = resolve(out, name);
  writeFileSync(file, readFileSync(file, 'utf8').replace(/^\/\/# sourceMappingURL=.*$/gm, ''));
}

const polyfillFingerprint = /Symbol\.for\(\s*["']Symbol\.asyncDispose["']\s*\)/;
const bundles = {
  esbuild: resolve(out, 'esbuild.js'),
  vite: resolve(out, 'vite.js'),
  webpack: resolve(out, 'webpack.js'),
  cdn: resolve(repo, 'packages/core/dist/nursery.min.js'),
};
let failed = false;
for (const [name, file] of Object.entries(bundles)) {
  const ok = polyfillFingerprint.test(readFileSync(file, 'utf8'));
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: Symbol.dispose polyfill ${ok ? 'present' : 'MISSING'}`);
  failed ||= !ok;
}
if (failed) {
  console.error(
    '\nA bundler dropped packages/core/src/polyfill.ts. Check "sideEffects" in packages/core/package.json.',
  );
  process.exit(1);
}

if (process.argv.includes('--static-only')) process.exit(0);
writeFileSync(resolve(out, '.gitkeep'), '');
const vitest = spawnSync('npx', ['vitest', 'run', '--config', resolve(dir, 'vitest.config.ts')], {
  cwd: repo,
  stdio: 'inherit',
});
process.exit(vitest.status ?? 1);
