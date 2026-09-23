// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

const verifier = resolve(process.cwd(), 'scripts/verify-package.mjs');
const repositoryRoot = process.cwd();

const safeManifest = {
  manifest_version: 3,
  name: 'ClearChoice',
  version: '0.2.0',
  description: 'A local extension popup.',
  action: { default_popup: 'popup/index.html' },
  commands: { _execute_action: { suggested_key: { default: 'Ctrl+Shift+Y' } } },
  permissions: ['activeTab', 'scripting', 'storage'],
  host_permissions: [],
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
  expect(runtimeAssetContents(dist)).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket)\b/);
}, 15_000);

test('unpacked ZIP manifest and runtime assets satisfy package validation', () => {
  const packageResult = spawnSync('npm', ['run', 'package:unpacked'], { cwd: repositoryRoot, encoding: 'utf8' });
  expect(packageResult.status, packageResult.stderr).toBe(0);

  const result = spawnSync(process.execPath, [verifier, '--zip', resolve(repositoryRoot, 'ClearChoice-v0.2.0-unpacked.zip')], {
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('artifact policy check passed (ZIP');
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
    ['optional host grant', { ...safeManifest, optional_host_permissions: ['https://example.test/*'] }],
    ['non-local content script', { ...safeManifest, content_scripts: [{ matches: ['https://example.test/*'], js: ['content.js'] }] }],
    ['nonempty host permissions', { ...safeManifest, host_permissions: ['https://example.test/*'] }],
    ['externally connectable', { ...safeManifest, externally_connectable: { matches: ['https://example.test/*'] } }],
  ]) {
    const result = verify(manifest);
    expect(result.status, `${label} manifest unexpectedly passed`).not.toBe(0);
  }
});

test('package verifier rejects background service workers', () => {
  const result = verify({ ...safeManifest, background: { service_worker: 'worker.js' } });

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('background is not allowed');
});

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
