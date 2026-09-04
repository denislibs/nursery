import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

const shared = ['test/**/*.test.ts'];

export default defineConfig({
  test: {
    globals: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: shared,
          exclude: ['test/browser/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'browser',
          include: [...shared, 'test/browser/**/*.test.ts'],
          exclude: ['test/exports.test.ts'],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});
