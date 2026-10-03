import { chromium, type BrowserContext, type Page, type Worker, type CDPSession } from 'playwright/test';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

export class PackagedRuntime {
  context!: BrowserContext;
  page!: Page;
  worker!: Worker;
  root = '';
  profile = '';
  a = '';
  b = '';
  spki = '';
  servers: Server[] = [];
  sessions: CDPSession[] = [];
  title = '';
  extension = resolve('dist');
  extensionId = '';
  // Tests may opt into the human runner's native (non-emulated) viewport.
  viewport: { width: number; height: number } | null | undefined;
  async wakeWorker() {
    const existing = this.context.serviceWorkers().find(worker => worker.url().startsWith(`chrome-extension://${this.extensionId}/`));
    if (existing) { this.worker = existing; return; }
    // An extension-owned page wakes a dormant worker through genuine runtime APIs.
    // It is not used as the trusted action-popup sender in integration assertions.
    const ready = this.context.waitForEvent('serviceworker', {
      predicate: worker => worker.url().startsWith(`chrome-extension://${this.extensionId}/`), timeout: 10_000,
    });
    const wake = await this.context.newPage();
    try {
      await wake.goto(`chrome-extension://${this.extensionId}/popup/index.html`);
      this.worker = await ready;
    } finally { await wake.close(); }
  }
  async launch(installExtension = false) {
    this.context = await chromium.launchPersistentContext(this.profile, {
      channel: 'chromium', headless: false,
      ...(this.viewport !== undefined ? { viewport: this.viewport } : {}),
      ignoreDefaultArgs: ['--disable-extensions'],
      // Either command-line loading flag reinstalls unpacked extensions and clears
      // Chrome's dynamic_scripts StateStore. Install once, then reopen only the profile.
      args: ['--ozone-platform=x11', '--enable-unsafe-extension-debugging',
        '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>;checkout-a.test;checkout-b.test',
        '--host-resolver-rules=MAP checkout-a.test 127.0.0.1, MAP checkout-b.test 127.0.0.1, MAP * ~NOTFOUND',
        '--disable-quic', '--disable-background-networking', `--ignore-certificate-errors-spki-list=${this.spki}`],
    });
    if (installExtension) {
      const cdp = await this.context.browser()!.newBrowserCDPSession();
      try {
        const installed = await cdp.send('Extensions.loadUnpacked', { path: this.extension });
        this.extensionId = installed.id;
      } finally { await cdp.detach(); }
    }
    if (!this.extensionId) throw Error('Installed extension ID missing');
    await this.wakeWorker();
    this.page = await this.context.newPage();
  }
  async start({ pregrant = true }: { pregrant?: boolean } = {}) {
    this.root = await mkdtemp(join(tmpdir(), 'clearchoice-packaged-'));
    this.profile = join(this.root, 'profile');
    this.title = `ClearChoice-${this.root.split('/').at(-1)}`;
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(this.root, 'key.pem'), '-out', join(this.root, 'cert.pem'), '-days', '1', '-subj', '/CN=checkout-a.test', '-addext', 'subjectAltName=DNS:checkout-a.test,DNS:checkout-b.test'], { stdio: 'ignore' });
    const cert = await readFile(join(this.root, 'cert.pem'));
    this.spki = createHash('sha256').update(new X509Certificate(cert).publicKey.export({type:'spki',format:'der'})).digest('base64');
    for (const hostname of ['checkout-a.test', 'checkout-b.test']) {
      const server = createServer({key: await readFile(join(this.root,'key.pem')), cert}, (req,res) => {
        const route = (req.url ?? '').split('?')[0];
        const supported = ['/checkout/clean','/checkout/recurring','/checkout/identical','/outside'].includes(route);
        res.writeHead(supported ? 200 : 404, {'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
        const recurring = '<p>Your subscription renews automatically at $12.00 per month until canceled.</p>';
        res.end(`<!doctype html><html lang="en"><head><title>${this.title}</title></head><body><main><h1>${route === '/outside' ? 'About' : 'Checkout'}</h1>${route === '/outside' ? '<p>Local mock article</p>' : '<aside>Order total: $15.00</aside>'+ (route.includes('recurring') ? recurring : route.includes('identical') ? recurring+recurring : '<p>One-time purchase. No recurring charges.</p>')}</main></body></html>`);
      });
      this.servers.push(server);
      await new Promise<void>((r,j) => {server.once('error',j);server.listen(0,'127.0.0.1',r);});
      const address = server.address();
      if (!address || typeof address === 'string') throw Error('No mock listener');
      const origin = `https://${hostname}:${address.port}`;
      if (hostname === 'checkout-b.test') this.b = origin; else this.a = origin;
    }
    await this.launch(true);
    await this.context.close();
    if (pregrant) {
      // ONLY isolated Chrome installation permission state. No application grant registry or records.
      const path = join(this.profile,'Default','Preferences');
      const preferences = JSON.parse(await readFile(path,'utf8'));
      const entry = Object.values(preferences.extensions.settings).find((value) => (value as {path?:string}).path === this.extension) as {active_permissions:{explicit_host:string[]};granted_permissions:{explicit_host:string[]}} | undefined;
      if (!entry) throw Error('Installed extension preferences missing');
      // Chrome contains() accepts a portless seed for a ported origin, but request()
      // remains pending in this setup. Use the exact API request pattern and port.
      for (const permissions of [entry.active_permissions,entry.granted_permissions]) permissions.explicit_host = [this.a+'/*'];
      await writeFile(path,JSON.stringify(preferences));
    }
    await this.launch();
    await this.page.goto(this.a+'/checkout/clean');
  }
  async focus() {
    await this.page.bringToFront();
    const windows = execFileSync('xdotool',['search','--sync','--onlyvisible','--name',this.title],{encoding:'utf8',timeout:10000}).trim().split('\n');
    if (windows.length !== 1) throw Error(`Expected unique task window, found ${windows.length}`);
    execFileSync('xdotool',['windowfocus','--sync',windows[0]],{timeout:5000});
    await this.page.waitForFunction(() => document.hasFocus());
  }
  async popup() {
    await this.focus();
    await this.worker.evaluate(async () => { const [tab] = await chrome.tabs.query({active:true,currentWindow:true}); await chrome.action.openPopup({windowId:tab.windowId}); });
    const cdp = await this.context.browser()!.newBrowserCDPSession();
    this.sessions.push(cdp);
    let target: {targetId:string} | undefined;
    for (let n=0;n<60;n++) {
      target = (await cdp.send('Target.getTargets')).targetInfos.find(t => t.url === `chrome-extension://${this.extensionId}/popup/index.html`);
      if (target) break;
      await new Promise(r=>setTimeout(r,50));
    }
    if (!target) throw Error('Native popup target not found');
    const {sessionId} = await cdp.send('Target.attachToTarget',{targetId:target.targetId,flatten:false});
    let counter=0;
    const pending = new Map<number,{resolve:(value:Record<string,unknown>)=>void;reject:(error:Error)=>void}>();
    cdp.on('Target.receivedMessageFromTarget',event => {
      if(event.sessionId!==sessionId) return;
      const message=JSON.parse(event.message);
      if(message.id) { const callback=pending.get(message.id); pending.delete(message.id); if(message.error) callback?.reject(Error(JSON.stringify(message.error))); else callback?.resolve(message.result); }
    });
    const send=async(method:string,params:Record<string,unknown>={}) => {
      const id=++counter;
      const result=new Promise<Record<string,unknown>>((r,j)=> {const timer=setTimeout(()=> {pending.delete(id);j(Error('CDP timeout '+method));},5000);pending.set(id,{resolve:v=>{clearTimeout(timer);r(v);},reject:e=>{clearTimeout(timer);j(e);}});});
      await cdp.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id,method,params})});
      return result;
    };
    const evaluate=async <T=unknown>(expression:string):Promise<T> => {
      const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
      if(result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
      return (result.result as {value:T}).value;
    };
    const wait=async(expression:string) => {
      for(let n=0;n<100;n++) {if(await evaluate(expression)) return;await new Promise(r=>setTimeout(r,50));}
      throw Error('Popup wait: '+expression+' '+await evaluate('document.body.textContent'));
    };
    const click=async(selector:string) => {
      await wait(`!!document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`);
      const point=await evaluate<{x:number;y:number}>(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
      await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
    };
    await wait(`!!document.querySelector('[data-site-status]') && !document.body.textContent.includes('Loading subscriptions') && !document.body.textContent.includes('Loading local history')`);
    return {evaluate,wait,click,send,fill:async(name:string,value:string) => evaluate(`document.querySelector('[name="${name}"]').value=${JSON.stringify(value)};document.querySelector('[name="${name}"]').dispatchEvent(new Event('change',{bubbles:true}));`),close:async()=> {await evaluate('window.close()');await cdp.detach();}};
  }
  async storage() {return this.worker.evaluate(async()=>await chrome.storage.local.get(null));}
  async permissions() {return this.worker.evaluate(async()=>({permissions:await chrome.permissions.getAll(),scripts:await chrome.scripting.getRegisteredContentScripts()}));}
  // A browser restart is not an unpacked-extension reload/reinstallation.
  async restart() {await this.context.close();this.sessions=[];await this.launch();await this.page.goto(this.a+'/checkout/clean');}
  async inventory() {
    const output: Record<string,string>={};
    const walk=async(path:string,relative='') => {for(const entry of await readdir(path,{withFileTypes:true})) {const name=join(relative,entry.name);if(entry.isDirectory()) await walk(join(path,entry.name),name);else output[name]=createHash('sha256').update(await readFile(join(path,entry.name))).digest('hex');}};
    await walk(this.extension);return output;
  }
  async stop() {
    const errors: unknown[] = [];
    try { await this.context?.close(); } catch (error) { errors.push(error); }
    const results = await Promise.allSettled(this.servers.map(server => new Promise<void>((resolveClose, rejectClose) => {
      server.close(error => error ? rejectClose(error) : resolveClose());
      server.closeAllConnections();
    })));
    for (const result of results) if (result.status === 'rejected') errors.push(result.reason);
    try { if (this.root) await rm(this.root, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    if (errors.length) throw errors[0];
  }
}
