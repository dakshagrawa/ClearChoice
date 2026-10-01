import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

// One-day throwaway certificate. Never trust it globally or put keys in the package.
export async function createFixtureTls() {
  const directory = await mkdtemp(resolve(tmpdir(), 'clearchoice-mock-tls-'));
  try {
    const key = resolve(directory, 'key.pem');
    const cert = resolve(directory, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', key, '-out', cert, '-subj', '/CN=checkout-a.test', '-addext', 'subjectAltName=DNS:checkout-a.test,DNS:checkout-b.test'], { stdio: 'pipe' });
    const certificate = await readFile(cert);
    const spki = new X509Certificate(certificate).publicKey.export({ type: 'spki', format: 'der' });
    return { key: await readFile(key), cert: certificate, pin: createHash('sha256').update(spki).digest('base64'), cleanup: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export function mockCheckoutHtml(dynamic = false) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Mock checkout</title><main><h1>Fake checkout; no purchases</h1><aside id="fake-order-summary"><h2>Order summary</h2><p>${dynamic ? 'Fake membership renews automatically for $12 per month until cancelled.' : 'One-time fake subtotal: $24. No recurring charge.'}</p></aside><button id="replace-order-summary" type="button">Replace fake order summary</button></main><script>document.querySelector('#replace-order-summary').addEventListener('click',()=>{document.querySelector('#fake-order-summary h2').textContent='Order summary updated';});</script></html>`;
}
