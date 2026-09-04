import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const page = (name: string) => fileURLToPath(new URL(`./${name}.html`, import.meta.url));

const coreSrc = fileURLToPath(new URL('../../packages/core/src/', import.meta.url));

export default defineConfig({
  // resolve @nursery/core from source so edits in packages/core show up without a rebuild
  resolve: {
    alias: [
      { find: /^@nursery\/core$/, replacement: `${coreSrc}index.ts` },
      { find: /^@nursery\/core\/(.+)$/, replacement: `${coreSrc}$1.ts` },
    ],
  },
  server: { port: 5181, fs: { allow: [fileURLToPath(new URL('../../', import.meta.url))] } },
  build: {
    rollupOptions: {
      input: {
        index: page('index'),
        search: page('search'),
        table: page('table'),
        uploads: page('uploads'),
        workers: page('workers'),
        dashboard: page('dashboard'),
        gestures: page('gestures'),
      },
    },
  },
});
