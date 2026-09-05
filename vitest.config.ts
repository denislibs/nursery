import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const coreSrc = fileURLToPath(new URL('./packages/core/src/', import.meta.url));
const alias = [
  { find: /^@nursery\/core$/, replacement: `${coreSrc}index.ts` },
  { find: /^@nursery\/core\/(.+)$/, replacement: `${coreSrc}$1.ts` },
];

const nodeTests = ['packages/core/test/*.test.ts', 'test/*.test.ts'];
const browserTests = [
  'packages/core/test/*.test.ts',
  'packages/core/test/browser/**/*.test.ts',
  'packages/!(core)/test/**/*.test.ts',
  'packages/!(core)/test/**/*.test.svelte.ts',
];

export default defineConfig({
  resolve: { alias },
  test: {
    globals: true,
    projects: [
      {
        extends: true,
        test: { name: 'node', environment: 'node', include: nodeTests },
      },
      {
        extends: true,
        plugins: [svelte({ configFile: false, compilerOptions: { runes: true } })],
        test: {
          name: 'browser',
          include: browserTests,
          exclude: ['**/exports.test.ts', '**/node_modules/**'],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }, { browser: 'firefox' }, { browser: 'webkit' }],
          },
        },
      },
    ],
  },
});
