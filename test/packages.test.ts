import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const packages = readdirSync(join(repo, 'packages')).filter(d =>
  existsSync(join(repo, 'packages', d, 'package.json')),
);

describe('workspace packages', () => {
  test.each(packages)('%s has consistent metadata and export targets', dir => {
    const pkg = JSON.parse(readFileSync(join(repo, 'packages', dir, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
      exports: Record<string, string | { types: string; import: string }>;
      peerDependencies?: Record<string, string>;
    };
    expect(pkg.name).toBe(dir === 'core' ? '@nursery/core' : `@nursery/${dir}`);
    for (const [key, entry] of Object.entries(pkg.exports)) {
      if (typeof entry === 'string' || key === './bundle') continue;
      const src = entry.import.replace(/^\.\/dist\//, 'src/').replace(/\.js$/, '.ts');
      expect(existsSync(join(repo, 'packages', dir, src)), `${dir}: ${key} -> ${src}`).toBe(true);
      expect(entry.types).toBe(entry.import.replace(/\.js$/, '.d.ts'));
    }
    if (dir !== 'core') expect(pkg.peerDependencies?.['@nursery/core']).toBeDefined();
  });
  test('all packages share one version', () => {
    const versions = new Set(
      packages.map(
        d =>
          (JSON.parse(readFileSync(join(repo, 'packages', d, 'package.json'), 'utf8')) as { version: string })
            .version,
      ),
    );
    expect(versions.size).toBe(1);
  });
});
