// Builds a single minified ESM bundle of @scopekit/core for <script type="module"> usage from a CDN.
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

const repo = resolve(import.meta.dirname, '..');
const outfile = resolve(repo, 'packages/core/dist/scopekit.min.js');
await build({
  entryPoints: [resolve(repo, 'packages/core/src/index.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  minify: true,
  sourcemap: true,
  target: ['es2022'],
  banner: { js: '/* @scopekit/core — https://github.com/denislibs/scopekit — MIT */' },
});
const raw = statSync(outfile).size;
const gz = gzipSync(readFileSync(outfile)).length;
console.log(`cdn bundle: ${outfile.replace(repo + '/', '')} ${raw} B raw, ${gz} B gzip`);
