import { cpSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));
const generatedManifest = resolve(projectRoot, '.release-manifest.json');
const manifestSource = existsSync(generatedManifest)
  ? generatedManifest
  : resolve(projectRoot, 'manifest.json');

export default defineConfig(() => {
  const contentBuild = process.env.CLEARCHOICE_CONTENT_BUILD === '1';
  const workerBuild = process.env.CLEARCHOICE_WORKER_BUILD === '1';
  const standaloneBuild = contentBuild || workerBuild;

  return {
    root: 'src',
    build: {
      outDir: '../dist',
      emptyOutDir: !standaloneBuild,
      modulePreload: false,
      rollupOptions: {
        input: standaloneBuild
          ? resolve(projectRoot, workerBuild ? 'src/worker/index.ts' : 'src/content/index.ts')
          : resolve(projectRoot, 'src/popup/index.html'),
        output: standaloneBuild
          ? {
              format: 'iife',
              entryFileNames: workerBuild ? 'worker.js' : 'content.js',
            }
          : {
              entryFileNames: 'assets/[name]-[hash].js',
            },
      },
    },
    plugins: [
      {
        name: 'copy-extension-manifest',
        closeBundle() {
          if (!standaloneBuild) cpSync(manifestSource, resolve(projectRoot, 'dist/manifest.json'));
        },
      },
    ],
  };
});
