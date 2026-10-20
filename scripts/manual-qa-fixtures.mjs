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
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Mock checkout</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;background:#f5f7f9;color:#172d38;font:16px/1.6 system-ui,sans-serif}main{max-width:850px;margin:48px 32px;padding:32px;background:white;border:1px solid #dce3e8;border-radius:16px}h1{font-size:25px;letter-spacing:-.6px;line-height:1.3;margin:12px 0 24px}h2{font-size:17px;margin:0 0 14px}main:before{content:'DEMO STORE / CHECKOUT';font-size:11px;font-weight:700;letter-spacing:2px;color:#59717c}aside{border-top:1px solid #e3e9ed;border-bottom:1px solid #e3e9ed;padding:22px 0;margin-bottom:24px}aside p{font-size:18px;max-width:540px}button{font:inherit;font-size:12px;border:1px solid #cad5db;background:#f8fafb;color:#3e5661;border-radius:7px;padding:9px 12px;margin:4px 6px 4px 0;min-height:44px;cursor:pointer}button:hover{background:#edf3f5}button:focus-visible{outline:3px solid #086e7d;outline-offset:3px}main:after{content:'Research fixture · No payment information or real purchases';display:block;margin-top:26px;color:#637983;font-size:12px}@media(max-width:640px){main{margin:16px;padding:22px}h1{font-size:23px}aside p{font-size:16px}}</style><main><section id="checkout-view"><h1>Fake checkout; no purchases</h1><aside id="fake-order-summary"><h2>Order summary</h2><p>${dynamic ? 'Fake membership renews automatically for $12 per month until cancelled.' : 'One-time fake subtotal: $24. No recurring charge.'}</p>${dynamic === 'identical' ? '<p>Fake membership renews automatically for $12 per month until cancelled.</p>' : ''}</aside><button id="replace-order-summary" type="button">Replace fake order summary</button></section><section id="information-view" hidden><h1>Mock information</h1><p>This is a static information view. No transaction is available.</p></section><button id="spa-exit" type="button">Exit checkout route</button><button id="spa-return" type="button">Return to checkout route</button></main><script>document.querySelector('#replace-order-summary').addEventListener('click',()=>{const h=document.querySelector('#fake-order-summary h2');h.textContent=h.textContent==='Order summary updated'?'Order summary updated again':'Order summary updated';});for(const [id,route] of [['spa-exit','/information'],['spa-return','/checkout/identical']])document.querySelector('#'+id).addEventListener('click',()=>{const exit=id==='spa-exit';document.querySelector('#checkout-view').hidden=exit;document.querySelector('#information-view').hidden=!exit;history.pushState({},'',route);window.dispatchEvent(new PopStateEvent('popstate'));});</script></html>`;
}
