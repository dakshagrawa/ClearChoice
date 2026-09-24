import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCandidateVersionMapping } from './release-artifact.mjs';

export function generateManifest({ baseManifest } = {}) {
  return structuredClone(baseManifest ?? JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'manifest.json'), 'utf8')));
}

function parseArguments(argv) {
  const [releaseFlag, outputFlag, output] = argv;
  if (releaseFlag !== '--release' || outputFlag !== '--output' || !output || argv.length !== 3) {
    throw new Error('usage: node scripts/build-manifest.mjs --release --output PATH');
  }
  return { output: resolve(output) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { output } = parseArguments(process.argv.slice(2));
  readCandidateVersionMapping(resolve(import.meta.dirname, '..'));
  writeFileSync(output, `${JSON.stringify(generateManifest(), null, 2)}\n`);
}
