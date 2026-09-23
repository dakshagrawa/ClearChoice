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

  return {
    root: 'src',
    build: {
      outDir: '../dist',
      emptyOutDir: !contentBuild,
      modulePreload: false,
      rollupOptions: {
        input: contentBuild
          ? resolve(projectRoot, 'src/content/index.ts')
          : resolve(projectRoot, 'src/popup/index.html'),
        output: contentBuild
          ? {
              format: 'iife',
              entryFileNames: 'content.js',
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
          if (!contentBuild) cpSync(manifestSource, resolve(projectRoot, 'dist/manifest.json'));
        },
      },
    ],
  };
});
