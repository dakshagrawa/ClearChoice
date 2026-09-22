import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const releaseOrigin = 'http://127.0.0.1/*';
const tailnetHostname = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+ts\.net$/;

function parseDemoOrigin(contents) {
  const origin = contents.trim();

  if (!origin || /[\r\n,]/.test(origin) || origin.includes('*')) {
    throw new Error('demo origin must be one exact HTTP Tailnet origin');
  }

  let url;
  try {
    url = new URL(origin);
  } catch {
    throw new Error('demo origin must be one exact HTTP Tailnet origin');
  }

  if (url.protocol !== 'http:' || !tailnetHostname.test(url.hostname) || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('demo origin must be one exact HTTP Tailnet origin');
  }

  return url.origin;
}

export function generateManifest({ mode = 'release', originFile, baseManifest } = {}) {
  if (mode !== 'release' && mode !== 'demo') throw new Error(`unsupported manifest mode: ${mode}`);

  const manifest = structuredClone(baseManifest ?? JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'manifest.json'), 'utf8')));
  const matches = [releaseOrigin];

  if (mode === 'demo') {
    if (!originFile) throw new Error('demo origin file is required for demo builds');
    matches.push(`${parseDemoOrigin(readFileSync(originFile, 'utf8'))}/*`);
  }

  manifest.content_scripts[0].matches = matches;
  return manifest;
}

function parseArguments(argv) {
  const [modeFlag, outputFlag, output] = argv;
  if (!['--release', '--demo'].includes(modeFlag) || outputFlag !== '--output' || !output || argv.length !== 3) {
    throw new Error('usage: node scripts/build-manifest.mjs --release|--demo --output PATH');
  }
  return { mode: modeFlag.slice(2), output: resolve(output) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { mode, output } = parseArguments(process.argv.slice(2));
  const repositoryRoot = resolve(import.meta.dirname, '..');
  const originFile = mode === 'demo' ? resolve(repositoryRoot, '.demo-origin.local') : undefined;
  const manifest = generateManifest({ mode, originFile });
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
}
