import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  exports: Record<string, string | { types: string; import: string }>;
};
const entries = Object.entries(pkg.exports).filter(
  (e): e is [string, { types: string; import: string }] => typeof e[1] === 'object',
);
const modules = [
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
  'react',
  'vue',
  'solid',
  'svelte',
  'angular',
  'testing',
];

describe('package exports map', () => {
  test('exposes a subpath for every module plus the root', () => {
    expect(entries.map(([k]) => k).toSorted()).toEqual(['.', ...modules.map(m => `./${m}`)].toSorted());
  });

  test('exposes package.json for tooling', () => {
    expect(pkg.exports['./package.json']).toBe('./package.json');
  });

  test.each(entries)('%s points at a built file with a matching source', (key, entry) => {
    expect(entry.import).toMatch(/^\.\/dist\/[a-z]+\.js$/);
    expect(entry.types).toBe(entry.import.replace(/\.js$/, '.d.ts'));
    const src = entry.import.replace(/^\.\/dist\//, 'src/').replace(/\.js$/, '.ts');
    expect(existsSync(resolve(root, src)), `${src} missing for ${key}`).toBe(true);
  });
});
