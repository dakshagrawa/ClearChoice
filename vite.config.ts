import { cpSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: 'src',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    modulePreload: false,
    rollupOptions: {
      input: {
        popup: resolve(projectRoot, 'src/popup/index.html'),
        content: resolve(projectRoot, 'src/content/index.ts'),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'content' ? 'content.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
  plugins: [
    {
      name: 'copy-extension-manifest',
      closeBundle() {
        cpSync(resolve(projectRoot, 'manifest.json'), resolve(projectRoot, 'dist/manifest.json'));
      },
    },
  ],
});
