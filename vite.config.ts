import { cpSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));
const demoBuild = process.env.CLEARCHOICE_MANIFEST_MODE === 'demo';
const generatedManifest = resolve(projectRoot, demoBuild ? '.demo-manifest.json' : '.release-manifest.json');
const manifestSource = demoBuild || existsSync(generatedManifest)
  ? generatedManifest
  : resolve(projectRoot, 'manifest.json');

export default defineConfig({
  root: 'src',
  build: {
    outDir: demoBuild ? '../demo-dist' : '../dist',
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
        cpSync(manifestSource, resolve(projectRoot, demoBuild ? 'demo-dist/manifest.json' : 'dist/manifest.json'));
      },
    },
  ],
});
