// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { readCandidateVersionMapping } from '../scripts/release-artifact.mjs';

const verifier = resolve(process.cwd(), 'scripts/verify-package.mjs');
const repositoryRoot = process.cwd();
const candidatePackageVersion = '1.0.0-rc.1';
const candidateChromeVersion = '1.0.0';
const candidateArchive = `ClearChoice-v${candidatePackageVersion}-unpacked.zip`;

const safeManifest = {
  manifest_version: 3,
  name: 'ClearChoice',
  version: candidateChromeVersion,
  version_name: candidatePackageVersion,
  description: 'A local extension popup.',
  action: { default_popup: 'popup/index.html' },
  commands: { _execute_action: { suggested_key: { default: 'Ctrl+Shift+Y' } } },
  permissions: ['activeTab', 'scripting', 'storage'],
  host_permissions: [],
  optional_host_permissions: ['https://*/*'],
  background: { service_worker: 'worker.js' },
};

function verify(manifest) {
  const directory = mkdtempSync(join(tmpdir(), 'clearchoice-manifest-'));
  const manifestPath = join(directory, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));

  try {
    const result = spawnSync(process.execPath, [verifier, '--manifest', manifestPath], {
      encoding: 'utf8',
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function verifyDist(directory) {
  return spawnSync(process.execPath, [verifier, '--dist', directory], {
    encoding: 'utf8',
  });
}

function runtimeAssetContents(directory) {
  const files = [];
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const entryPath = join(path, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (/\.(?:css|html|js|mjs|cjs|json)$/i.test(entry.name)) files.push(readFileSync(entryPath, 'utf8'));
    }
  };

  visit(directory);
  return files.join('\n');
}

test('package verifier accepts an MV3 manifest with exactly temporary active-tab beta permissions', () => {
  const safe = verify(safeManifest);
  expect(safe.status, safe.stderr).toBe(0);
  expect(safe.stdout).toBe('manifest contract passed\n');
});

test('package verifier rejects Chrome-invalid prerelease manifest versions', () => {
  const result = verify({ ...safeManifest, version: candidatePackageVersion });

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('version must be one to four dot-separated integers');
});

test.each([
  ['missing action command', { ...safeManifest, commands: {} }],
  ['wrong action shortcut', { ...safeManifest, commands: { _execute_action: { suggested_key: { default: 'Ctrl+Shift+X' } } } }],
  ['additional command', { ...safeManifest, commands: { ...safeManifest.commands, analyze: { suggested_key: { default: 'Ctrl+Shift+U' } } } }],
])('package verifier rejects %s', (_label, manifest) => {
  const result = verify(manifest);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('commands must be exactly');
});

test('package verifier rejects every static content script', () => {
  const result = verify({
    ...safeManifest,
    content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['content.js'] }],
  });

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('content_scripts is not allowed');
});

test('package verifier rejects optional permissions', () => {
  const result = verify({ ...safeManifest, optional_permissions: ['tabs'] });

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('optional_permissions is not allowed');
});

test('repository manifest satisfies package validation', () => {
  const result = verify(JSON.parse(readFileSync(resolve(repositoryRoot, 'manifest.json'), 'utf8')));

  expect(result.status, result.stderr).toBe(0);
});

test('source package and manifest map the untagged RC identity to a Chrome-valid manifest version and derived archive name', () => {
  const sourceManifest = JSON.parse(readFileSync(resolve(repositoryRoot, 'manifest.json'), 'utf8'));
  const sourcePackage = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'));

  const mapping = readCandidateVersionMapping(repositoryRoot);
  expect(mapping).toEqual({
    packageVersion: candidatePackageVersion,
    manifestVersion: candidateChromeVersion,
    manifestVersionName: candidatePackageVersion,
  });
  expect(sourcePackage.version).toBe(candidatePackageVersion);
  expect(sourceManifest.version).toBe(candidateChromeVersion);
  expect(sourceManifest.version_name).toBe(candidatePackageVersion);
  expect(sourcePackage.scripts['verify:archive']).toBe('node scripts/verify-archive.mjs');
});

test('package verifier rejects forbidden runtime artifact APIs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'clearchoice-dist-'));
  mkdirSync(join(directory, 'popup'));
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(safeManifest));
  writeFileSync(join(directory, 'popup', 'main.js'), 'fetch("https://example.test");');

  try {
    const result = verifyDist(directory);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('artifact policy check');
    expect(result.stderr).toContain('forbidden runtime pattern');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each([
  ['navigator.sendBeacon', 'popup/main.js', 'navigator.sendBeacon("https://example.test/collect", "payload");'],
  ['EventSource construction', 'popup/main.js', 'new EventSource("https://example.test/events");'],
  ['Worker construction', 'popup/main.js', 'new Worker("./worker.js");'],
  ['dynamic import', 'popup/main.js', 'import("./module.js");'],
  ['absolute HTML URL', 'popup/index.html', '<img src="https://example.test/image.png">'],
  ['protocol-relative HTML URL', 'popup/index.html', '<link href="//example.test/style.css" rel="stylesheet">'],
  ['unquoted absolute HTML src', 'popup/index.html', '<img src=https://example.test/image.png>'],
  ['unquoted protocol-relative HTML href', 'popup/index.html', '<link href=//example.test/style.css rel=stylesheet>'],
  ['absolute HTML srcset URL', 'popup/index.html', '<img srcset="https://example.test/image.png 1x, ./image@2x.png 2x">'],
  ['protocol-relative HTML srcset URL', 'popup/index.html', '<source srcset="//example.test/image.png 1x">'],
  ['absolute CSS URL', 'popup/style.css', '.logo { background-image: url("https://example.test/image.png"); }'],
  ['protocol-relative CSS URL', 'popup/style.css', '.logo { background-image: url(//example.test/image.png); }'],
  ['DOM URL sink', 'popup/main.js', 'document.querySelector("a").href = "https://example.test/next";'],
  ['template-literal DOM URL sink', 'popup/main.js', 'element.href = `https://example.test/next`;'],
  ['protocol-relative template-literal DOM URL sink', 'popup/main.js', 'element.src = `//example.test/image.png`;'],
  ['bracket DOM URL sink', 'popup/main.js', "element['href'] = 'https://example.test/next';"],
  ['protocol-relative bracket DOM URL sink', 'popup/main.js', 'element["src"] = "//example.test/image.png";'],
  ['DOM URL sink setter', 'popup/main.js', 'document.querySelector("img").setAttribute("src", "//example.test/image.png");'],
])('package verifier rejects emitted artifact network policy bypass: %s', (_label, relativePath, source) => {
  const directory = mkdtempSync(join(tmpdir(), 'clearchoice-dist-'));
  const assetPath = join(directory, relativePath);
  mkdirSync(join(directory, 'popup'));
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(safeManifest));
  writeFileSync(assetPath, source);

  try {
    const result = verifyDist(directory);
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain('artifact policy check');
    expect(result.stderr).toContain('forbidden runtime pattern');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('package verifier accepts ordinary local asset references', () => {
  const directory = mkdtempSync(join(tmpdir(), 'clearchoice-dist-'));
  mkdirSync(join(directory, 'popup'));
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(safeManifest));
  writeFileSync(join(directory, 'popup', 'index.html'), '<script type="module" src="./main.js"></script><img src="./image.png">');
  writeFileSync(join(directory, 'popup', 'style.css'), '.logo { background-image: url("./image.png"); }');
  writeFileSync(join(directory, 'popup', 'main.js'), 'document.querySelector("a").href = "./details.html";');
  writeFileSync(join(directory, 'content.js'), '(()=>{})();');
  writeFileSync(join(directory, 'worker.js'), '(()=>{})();');

  try {
    const result = verifyDist(directory);
    expect(result.status, result.stderr).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('package verifier rejects unsafe popup-referenced module artifacts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'clearchoice-dist-'));
  mkdirSync(join(directory, 'popup'));
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(safeManifest));
  writeFileSync(join(directory, 'popup', 'index.html'), '<script type="module" src="./main.mjs"></script>');
  writeFileSync(join(directory, 'popup', 'main.mjs'), 'fetch("https://example.test");');

  try {
    const result = verifyDist(directory);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('artifact policy check');
    expect(result.stderr).toContain('forbidden runtime pattern');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('package verifier rejects unsafe popup-referenced CJS module artifacts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'clearchoice-dist-'));
  mkdirSync(join(directory, 'popup'));
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(safeManifest));
  writeFileSync(join(directory, 'popup', 'index.html'), '<script src="./module.cjs"></script>');
  writeFileSync(join(directory, 'popup', 'module.cjs'), 'fetch("https://example.test");');

  try {
    const result = verifyDist(directory);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('artifact policy check');
    expect(result.stderr).toContain('forbidden runtime pattern');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('built dist manifest and runtime assets satisfy package validation', () => {
  const build = spawnSync('npm', ['run', 'build'], { cwd: repositoryRoot, encoding: 'utf8' });
  expect(build.status, build.stderr).toBe(0);

  const dist = resolve(repositoryRoot, 'dist');
  const result = verifyDist(dist);
  expect(result.status, result.stderr).toBe(0);
  const distManifest = JSON.parse(readFileSync(resolve(dist, 'manifest.json'), 'utf8'));
  expect(distManifest.version).toBe(candidateChromeVersion);
  expect(distManifest.version_name).toBe(candidatePackageVersion);
  expect(distManifest.background).toEqual({ service_worker: 'worker.js' });
  for (const asset of ['popup/index.html', 'content.js', 'worker.js']) {
    expect(readFileSync(resolve(dist, asset), 'utf8'), `${asset} missing or empty in dist`).toBeTruthy();
  }
  expect(runtimeAssetContents(dist)).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket)\b/);
}, 15_000);

test('unpacked ZIP manifest and runtime assets satisfy package validation', () => {
  const packageResult = spawnSync('npm', ['run', 'package:unpacked'], { cwd: repositoryRoot, encoding: 'utf8' });
  expect(packageResult.status, packageResult.stderr).toBe(0);

  const archive = resolve(repositoryRoot, candidateArchive);
  const result = spawnSync(process.execPath, [verifier, '--zip', archive], {
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('artifact policy check passed (ZIP');
  const archiveManifest = JSON.parse(spawnSync('unzip', ['-p', archive, 'manifest.json'], { encoding: 'utf8' }).stdout);
  expect(archiveManifest.version).toBe(candidateChromeVersion);
  expect(archiveManifest.version_name).toBe(candidatePackageVersion);
  expect(archiveManifest.background).toEqual({ service_worker: 'worker.js' });
  const archiveEntries = spawnSync('unzip', ['-Z1', archive], { encoding: 'utf8' });
  expect(archiveEntries.status, archiveEntries.stderr).toBe(0);
  const names = archiveEntries.stdout.split(/\r?\n/);
  for (const asset of ['popup/index.html', 'content.js', 'worker.js']) {
    expect(names, `${asset} missing from ZIP`).toContain(asset);
    const extracted = spawnSync('unzip', ['-p', archive, asset], { encoding: 'utf8' });
    expect(extracted.status, extracted.stderr).toBe(0);
    expect(extracted.stdout, `${asset} empty in ZIP`).toBeTruthy();
  }
}, 15_000);

test('package verifier rejects unsafe MV3 manifest capabilities', () => {
  for (const [label, manifest] of [
    ['all URLs', { ...safeManifest, host_permissions: ['<all_urls>'] }],
    ['missing activeTab', { ...safeManifest, permissions: ['scripting', 'storage'] }],
    ['missing scripting', { ...safeManifest, permissions: ['activeTab', 'storage'] }],
    ['duplicate permission', { ...safeManifest, permissions: [...safeManifest.permissions, 'storage'] }],
    ['tabs', { ...safeManifest, permissions: [...safeManifest.permissions, 'tabs'] }],
    ['webRequest', { ...safeManifest, permissions: [...safeManifest.permissions, 'webRequest'] }],
    ['cookies', { ...safeManifest, permissions: [...safeManifest.permissions, 'cookies'] }],
    ['declarativeNetRequest', { ...safeManifest, permissions: [...safeManifest.permissions, 'declarativeNetRequest'] }],
    ['unrelated optional host grant', { ...safeManifest, optional_host_permissions: ['https://example.test/*'] }],
    ['all URLs optional host grant', { ...safeManifest, optional_host_permissions: ['<all_urls>'] }],
    ['HTTP optional host grant', { ...safeManifest, optional_host_permissions: ['http://*/*'] }],
    ['additional optional host grant', { ...safeManifest, optional_host_permissions: ['https://*/*', 'https://example.test/*'] }],
    ['missing optional host grant', { ...safeManifest, optional_host_permissions: undefined }],
    ['non-local content script', { ...safeManifest, content_scripts: [{ matches: ['https://example.test/*'], js: ['content.js'] }] }],
    ['nonempty host permissions', { ...safeManifest, host_permissions: ['https://example.test/*'] }],
    ['externally connectable', { ...safeManifest, externally_connectable: { matches: ['https://example.test/*'] } }],
  ]) {
    const result = verify(manifest);
    expect(result.status, `${label} manifest unexpectedly passed`).not.toBe(0);
  }
});

test.each([
  ['wrong worker', { service_worker: 'other.js' }],
  ['remote worker', { service_worker: 'https://example.test/worker.js' }],
  ['extra background key', { service_worker: 'worker.js', type: 'module' }],
])('package verifier rejects %s', (_label, background) => {
  const result = verify({ ...safeManifest, background });

  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/background|remote executable URL/);
});

test('package verifier requires the local popup path declared in its manifest', () => {
  const result = verify({ ...safeManifest, action: { default_popup: '../popup/index.html' } });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('action.default_popup must be popup/index.html');
});

test('package verifier rejects absent packaged worker', () => {
  const directory = mkdtempSync(join(tmpdir(), 'clearchoice-dist-'));
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(safeManifest));
  mkdirSync(join(directory, 'popup'));
  writeFileSync(join(directory, 'popup', 'index.html'), '<main>Local popup</main>');
  writeFileSync(join(directory, 'content.js'), '(()=>{})();');
  try {
    const result = verifyDist(directory);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('worker.js');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('package verifier rejects a ZIP missing its declared worker', () => {
  const directory = mkdtempSync(join(tmpdir(), 'clearchoice-zip-'));
  const archive = join(directory, 'missing-worker.zip');
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(safeManifest));
  mkdirSync(join(directory, 'popup'));
  writeFileSync(join(directory, 'popup', 'index.html'), '<main>Local popup</main>');
  writeFileSync(join(directory, 'content.js'), '(()=>{})();');

  try {
    const packed = spawnSync('zip', ['-q', '-r', archive, 'manifest.json', 'popup', 'content.js'], {
      cwd: directory, encoding: 'utf8',
    });
    expect(packed.status, packed.stderr).toBe(0);
    const result = spawnSync(process.execPath, [verifier, '--zip', archive], { encoding: 'utf8' });
    expect(result.status, result.stdout).not.toBe(0);
    expect(result.stderr).toContain('worker.js is missing or empty');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each(['popup/index.html', 'content.js'])(
  'package verifier rejects a dist missing %s', (missingAsset) => {
    const directory = mkdtempSync(join(tmpdir(), 'clearchoice-dist-'));
    mkdirSync(join(directory, 'popup'));
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify(safeManifest));
    for (const asset of ['popup/index.html', 'content.js', 'worker.js']) {
      if (asset !== missingAsset) writeFileSync(join(directory, asset), 'local asset');
    }

    try {
      const result = verifyDist(directory);
      expect(result.status, result.stdout).not.toBe(0);
      expect(result.stderr).toContain(`${missingAsset} is missing or empty`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test.each(['popup/index.html', 'content.js'])(
  'package verifier rejects a ZIP missing %s', (missingAsset) => {
    const directory = mkdtempSync(join(tmpdir(), 'clearchoice-zip-'));
    const archive = join(directory, 'missing-asset.zip');
    mkdirSync(join(directory, 'popup'));
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify(safeManifest));
    for (const asset of ['popup/index.html', 'content.js', 'worker.js']) {
      if (asset !== missingAsset) writeFileSync(join(directory, asset), 'local asset');
    }

    try {
      const packed = spawnSync('zip', ['-q', '-r', archive, 'manifest.json', 'popup', 'worker.js',
        ...(missingAsset === 'content.js' ? [] : ['content.js'])], { cwd: directory, encoding: 'utf8' });
      expect(packed.status, packed.stderr).toBe(0);
      const result = spawnSync(process.execPath, [verifier, '--zip', archive], { encoding: 'utf8' });
      expect(result.status, result.stdout).not.toBe(0);
      expect(result.stderr).toContain(`${missingAsset} is missing or empty`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test.each(['popup/index.html', 'content.js'])(
  'package verifier rejects an empty %s in dist and ZIP', (emptyAsset) => {
    const directory = mkdtempSync(join(tmpdir(), 'clearchoice-empty-'));
    const archive = join(directory, 'empty-asset.zip');
    mkdirSync(join(directory, 'popup'));
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify(safeManifest));
    for (const asset of ['popup/index.html', 'content.js', 'worker.js']) {
      writeFileSync(join(directory, asset), asset === emptyAsset ? '  ' : 'local asset');
    }

    try {
      const packed = spawnSync('zip', ['-q', '-r', archive, 'manifest.json', 'popup', 'content.js', 'worker.js'], {
        cwd: directory, encoding: 'utf8',
      });
      expect(packed.status, packed.stderr).toBe(0);
      for (const result of [verifyDist(directory), spawnSync(process.execPath, [verifier, '--zip', archive], { encoding: 'utf8' })]) {
        expect(result.status, result.stdout).not.toBe(0);
        expect(result.stderr).toContain(`${emptyAsset} is missing or empty`);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test('package verifier rejects remote executable URLs', () => {
  const result = verify({
    ...safeManifest,
    content_scripts: [{ matches: ['https://example.test/*'], js: ['https://example.test/worker.js'] }],
  });

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('remote executable URL');
});

test.each(['api_key', 'apiKey', 'token', 'secret', 'password'])('package verifier rejects %s manifest keys', (key) => {
  const result = verify({ ...safeManifest, [key]: 'not-a-secret' });

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(`manifest key ${key} is not allowed`);
});
