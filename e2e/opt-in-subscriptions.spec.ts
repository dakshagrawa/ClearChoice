import { expect, test } from 'playwright/test';
import { readFile } from 'node:fs/promises';
import { PackagedRuntime } from './packaged-runtime';
import { createHash } from 'node:crypto';
import { isFindingHistory, type FindingRecord } from '../src/shared/models';

async function badge(runtime: PackagedRuntime) {
  return runtime.worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
    return chrome.action.getBadgeText({tabId:tab.id});
  });
}

// Reserved RFC2606 mock domains map only to loopback in isolated Chrome.
// Only Chrome installation permissions are seeded, never the application registry.
// This exercises production opt-in, NOT human toolbar/consent QA.
test('pre-granted reserved mock setup: native production opt-in, quiet zero, explicit confirmation, isolation, restart and revoke (NOT consent QA)', async () => {
  test.setTimeout(90_000);
  const runtime = new PackagedRuntime();
  try {
    const before = await runtime.inventory();
    await runtime.start();
    expect((await runtime.permissions()).permissions.origins).toEqual([runtime.a+'/*']);
    expect((await runtime.permissions()).scripts).toEqual([]);
    for (const url of [`https://127.0.0.2:${new URL(runtime.a).port}/checkout/clean`, 'https://192.0.2.1/checkout/clean', 'https://othernotmapped.test/checkout/clean']) {
      const probe = await runtime.context.newPage();
      try { await expect(probe.goto(url,{timeout:5000})).rejects.toThrow('ERR_PROXY_CONNECTION_FAILED'); }
      finally { await probe.close(); }
    }
    let popup = await runtime.popup();
    await popup.click('[data-action="analyze"]');
    await popup.wait(`document.querySelector('main > [role="status"]').textContent === 'No matching signals found on this page.'`);
    expect(await runtime.page.locator('[data-clearchoice-panel]').count()).toBe(0);
    await popup.click('[data-action="restore"]');
    expect(await runtime.page.locator('[data-clearchoice-panel]').count()).toBe(0);
    expect(await runtime.worker.evaluate(async (origin) => chrome.permissions.contains({origins:[origin+'/*']}), runtime.a)).toBe(true);
    await popup.evaluate(`document.querySelector('[data-action="site-enable"]').addEventListener('click',e=>{window.__permissionClick={trusted:e.isTrusted,active:navigator.userActivation.isActive};});`);
    await popup.click('[data-action="site-enable"]');
    expect(await popup.evaluate('window.__permissionClick')).toEqual({trusted:true,active:true});
    await popup.wait(`document.querySelector('[data-site-status]').textContent.startsWith('Detection enabled for')`);
    expect((await runtime.permissions()).scripts).toHaveLength(1);
    expect((await runtime.permissions()).scripts[0].matches).toEqual([runtime.a+'/*']);
    expect((await runtime.storage()).grantState).toEqual({version:1,sites:{[runtime.a]:{enabled:true,generation:1}}});
    await popup.close();
    await runtime.page.waitForTimeout(400);
    expect(await runtime.page.locator('[data-clearchoice-panel]').count()).toBe(0);
    expect((await runtime.storage()).reviewHistory ?? []).toEqual([]);
    expect((await runtime.storage()).subscriptions ?? []).toEqual([]);
    expect(await runtime.worker.evaluate(async()=>{const [tab]=await chrome.tabs.query({active:true,currentWindow:true});return chrome.action.getBadgeText({tabId:tab.id});})).toBe('');
    await runtime.page.goto(runtime.a+'/checkout/recurring');
    await expect(runtime.page.locator('[data-clearchoice-panel]')).toHaveCount(1);
    const history = (await runtime.storage()).reviewHistory as {id:string;origin:string}[];
    expect(history).toHaveLength(1);
    expect(history[0].origin).toBe(runtime.a);
    expect(await runtime.worker.evaluate(async()=>{const [tab]=await chrome.tabs.query({active:true,currentWindow:true});return chrome.action.getBadgeText({tabId:tab.id});})).toBe('1');
    popup = await runtime.popup();
    await popup.click('[data-action="review-refresh"]');
    await popup.wait(`document.querySelectorAll('[data-review-id]').length === 1`);
    await popup.click('[data-action="review-as-subscription"]');
    expect(await popup.evaluate(`['merchant','amount','currency','cadence'].map(n=>document.querySelector('[name="'+n+'"]').value)`)).toEqual(['','','','']);
    await popup.click('[data-subscription-action="cancel"]');
    expect((await runtime.storage()).subscriptions ?? []).toEqual([]);
    await popup.click('[data-action="review-as-subscription"]');
    for(const [name,value] of Object.entries({merchant:'Fake local membership',amount:'12.00',currency:'USD',cadence:'monthly'})) await popup.fill(name,value);
    await popup.click('[data-subscription-editor] [type="submit"]');
    await popup.wait(`document.querySelector('[aria-label="Subscriptions"] > [role="status"]').textContent === 'Subscription saved locally.'`);
    const subscriptions = (await runtime.storage()).subscriptions as {sourceFindingId:string}[];
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0].sourceFindingId).toBe(history[0].id);
    await popup.close();
    await runtime.page.evaluate(()=>{document.querySelector('main')!.append(document.createElement('span'));});
    await runtime.page.waitForTimeout(400);
    expect((await runtime.storage()).reviewHistory).toHaveLength(1);
    await runtime.page.evaluate(()=>{history.pushState(null,'','/outside');document.querySelector('main')!.textContent='Local mock article';window.dispatchEvent(new PopStateEvent('popstate'));});
    await expect(runtime.page.locator('[data-clearchoice-panel]')).toHaveCount(0);
    await runtime.page.goto(runtime.b+'/checkout/recurring');
    await runtime.page.waitForTimeout(400);
    expect(await runtime.page.locator('[data-clearchoice-panel]').count()).toBe(0);
    expect((await runtime.storage()).reviewHistory).toHaveLength(1);
    expect(await runtime.worker.evaluate(async()=>chrome.permissions.contains({origins:['https://checkout-b.test/*']}))).toBe(false);
    const restartApi = await runtime.permissions();
    const restartStorage = await runtime.storage();
    const extensionId = runtime.extensionId;
    await runtime.restart();
    expect(await runtime.worker.evaluate(() => chrome.runtime.id)).toBe(extensionId);
    expect(new URL(runtime.worker.url()).hostname).toBe(extensionId);
    expect(await runtime.permissions()).toEqual(restartApi);
    expect((await runtime.permissions()).scripts).toHaveLength(1);
    expect(await runtime.storage()).toEqual(restartStorage);
    expect((await runtime.storage()).subscriptions).toEqual(subscriptions);
    await runtime.page.goto(runtime.a+'/checkout/recurring');
    await expect(runtime.page.locator('[data-clearchoice-panel]')).toHaveCount(1);
    expect((await runtime.storage()).reviewHistory).toHaveLength(1);
    expect(((await runtime.storage()).reviewHistory as {id:string;origin:string}[]).map(({id,origin})=>({id,origin}))).toEqual(history.map(({id,origin})=>({id,origin})));
    popup = await runtime.popup();
    await popup.click('[data-action="site-disable"]');
    await popup.wait(`document.querySelector('[data-site-status]').textContent.startsWith('Detection disabled and browser site access removed')`);
    expect((await runtime.permissions()).scripts).toEqual([]);
    expect((await runtime.permissions()).permissions.origins).toEqual([]);
    expect((await runtime.storage()).grantState).toEqual({version:1,sites:{[runtime.a]:{enabled:false,generation:2}}});
    expect((await runtime.storage()).subscriptions).toEqual(subscriptions);
    await popup.close();
    await expect(runtime.page.locator('[data-clearchoice-panel]')).toHaveCount(0);
    expect(await badge(runtime)).toBe('');
    const revokedHistory = (await runtime.storage()).reviewHistory;
    await runtime.page.goto(runtime.a+'/checkout/identical');
    await runtime.page.waitForTimeout(500);
    expect((await runtime.storage()).reviewHistory).toEqual(revokedHistory);
    expect(await badge(runtime)).toBe('');
    expect(await runtime.page.locator('[data-clearchoice-panel]').count()).toBe(0);
    expect(await runtime.inventory()).toEqual(before);
    const finalStorage = await runtime.storage();
    await test.info().attach('real-api-readback',{body:JSON.stringify({
      scope:'Pre-granted reserved mock setup, NOT human consent QA',
      api:await runtime.permissions(), grantState:finalStorage.grantState,
      reviewIds:(finalStorage.reviewHistory as {id:string}[]).map(record=>record.id),
      subscriptions:(finalStorage.subscriptions as {id:string;sourceFindingId?:string}[]).map(({id,sourceFindingId})=>({id,sourceFindingId})),
    },null,2),contentType:'application/json'});
  } finally { await runtime.stop(); }
});

test('native packaged popup: real manual CRUD, help fallback, focus and Axe, retention selection and browser restart (NOT consent QA)', async () => {
  test.setTimeout(90_000);
  const runtime = new PackagedRuntime();
  try {
    const before = await runtime.inventory();
    await runtime.start();
    let popup = await runtime.popup();
    await popup.click('[data-subscription-action="add"]');
    for(const [name,value] of Object.entries({merchant:'Netflix',amount:'12.00',currency:'USD',cadence:'monthly'})) await popup.fill(name,value);
    await popup.evaluate(await readFile('node_modules/axe-core/axe.min.js','utf8'));
    expect(await popup.evaluate(`axe.run().then(r=>r.violations.filter(v=>['serious','critical'].includes(v.impact)).map(v=>v.id))`)).toEqual([]);
    await popup.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
    await popup.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
    expect(await popup.evaluate(`document.activeElement.tagName !== 'BODY' && document.activeElement.matches(':focus-visible')`)).toBe(true);
    expect((await runtime.storage()).subscriptions ?? []).toEqual([]);
    await popup.click('[data-subscription-editor] [type="submit"]');
    await popup.wait(`document.querySelector('[aria-label="Subscriptions"] > [role="status"]').textContent === 'Subscription saved locally.'`);
    const saved = (await runtime.storage()).subscriptions as {id:string;merchant:string;sourceFindingId?:string}[];
    expect(saved).toHaveLength(1);
    expect(saved[0]).not.toHaveProperty('sourceFindingId');
    await popup.click('[data-subscription-action="help"]');
    await popup.wait(`document.querySelector('[data-subscription-list]').textContent.includes('No known provider site; check your billing provider')`);
    expect(await popup.evaluate(`document.querySelectorAll('[data-subscription-list] a').length`)).toBe(0);
    await popup.click('[data-subscription-action="edit"]');
    await popup.fill('merchant','Fake edited merchant');
    await popup.click('[data-subscription-editor] [type="submit"]');
    await popup.wait(`document.querySelector('[aria-label="Subscriptions"] > [role="status"]').textContent === 'Subscription saved locally.'`);
    const edited = (await runtime.storage()).subscriptions as {id:string;merchant:string}[];
    expect(edited[0].id).toBe(saved[0].id);
    expect(edited[0].merchant).toBe('Fake edited merchant');
    await popup.evaluate(`document.querySelector('[data-review-retention]').value='7';document.querySelector('[data-review-retention]').dispatchEvent(new Event('change',{bubbles:true}));`);
    await popup.wait(`document.querySelector('[data-review-retention]').value === '7' && !document.querySelector('[data-review-retention]').disabled`);
    expect((await runtime.storage()).retentionPolicy).toBe(7);
    await popup.close();
    await runtime.restart();
    expect((await runtime.storage()).subscriptions).toEqual(edited);
    expect((await runtime.storage()).retentionPolicy).toBe(7);
    popup = await runtime.popup();
    await popup.click('[data-subscription-action="delete"]');
    await popup.click('[data-subscription-action="cancel"]');
    expect((await runtime.storage()).subscriptions).toEqual(edited);
    await popup.click('[data-subscription-action="delete"]');
    await popup.click('[data-subscription-action="confirm-delete"]');
    await popup.wait(`document.querySelector('[aria-label="Subscriptions"] > [role="status"]').textContent === 'Subscription deleted locally.'`);
    expect((await runtime.storage()).subscriptions).toEqual([]);
    expect(await popup.evaluate(`document.activeElement.dataset.subscriptionAction`)).toBe('add');
    expect(await runtime.inventory()).toEqual(before);
  } finally { await runtime.stop(); }
});

test('no-host native openPopup Analyze honestly denies without activeTab (NOT human toolbar QA)', async () => {
  test.setTimeout(60_000);
  const runtime = new PackagedRuntime();
  try {
    const before = await runtime.inventory();
    await runtime.start({ pregrant: false });
    expect((await runtime.permissions()).permissions.origins).toEqual([]);
    expect((await runtime.permissions()).scripts).toEqual([]);
    expect((await runtime.storage()).grantState ?? {version:1,sites:{}}).toEqual({version:1,sites:{}});
    await runtime.page.goto(runtime.a+'/checkout/recurring');
    const popup = await runtime.popup();
    await popup.click('[data-action="analyze"]');
    // openPopup() is real Chrome UI, but unlike a human toolbar invocation it does
    // not acquire activeTab. Never seed a host grant to turn this denial into success.
    await popup.wait(`document.querySelector('main > [role="status"]').textContent === 'Chrome does not allow ClearChoice to analyze this page.'`);
    await expect(runtime.page.locator('[data-clearchoice-panel]')).toHaveCount(0);
    expect((await runtime.storage()).reviewHistory ?? []).toEqual([]);
    expect(await badge(runtime)).toBe('');
    expect((await runtime.permissions()).permissions.origins).toEqual([]);
    expect((await runtime.permissions()).scripts).toEqual([]);
    expect((await runtime.storage()).grantState ?? {version:1,sites:{}}).toEqual({version:1,sites:{}});
    expect((await runtime.storage()).subscriptions ?? []).toEqual([]);
    await popup.close();
    expect(await runtime.inventory()).toEqual(before);
  } finally { await runtime.stop(); }
});

// Synthetic timestamps/capacity below use genuine storage.local, not API replacements.
// Neither fixture proves elapsed time, 500 production observations, or human consent.
test('pre-granted packaged pruning of synthetic aged production finding preserves explicit subscription and receipts across restart (NOT elapsed-time/consent QA)', async () => {
  test.setTimeout(90_000);
  const runtime = new PackagedRuntime();
  try {
    const before = await runtime.inventory();
    await runtime.start();
    let popup = await runtime.popup();
    await popup.click('[data-action="site-enable"]');
    await popup.wait(`document.querySelector('[data-site-status]').textContent.startsWith('Detection enabled for')`);
    await popup.close();
    await runtime.page.goto(runtime.a+'/checkout/recurring');
    await expect(runtime.page.locator('[data-clearchoice-panel]')).toHaveCount(1);
    const original = (await runtime.storage()).reviewHistory as FindingRecord[];
    expect(original).toHaveLength(1);
    popup = await runtime.popup();
    await popup.click('[data-action="review-refresh"]');
    await popup.wait(`document.querySelectorAll('[data-review-id]').length === 1`);
    await popup.click('[data-action="review-as-subscription"]');
    for (const [name,value] of Object.entries({merchant:'Local pruning membership',amount:'12.00',currency:'USD',cadence:'monthly'})) await popup.fill(name,value);
    await popup.click('[data-subscription-editor] [type="submit"]');
    await popup.wait(`document.querySelector('[aria-label="Subscriptions"] > [role="status"]').textContent === 'Subscription saved locally.'`);
    const saved = await runtime.storage();
    expect(saved.subscriptions).toHaveLength(1);
    expect((saved.subscriptions as {sourceFindingId:string}[])[0].sourceFindingId).toBe(original[0].id);
    expect(saved.receipts).toHaveLength(1);
    await popup.close();
    await runtime.page.goto(runtime.a+'/checkout/clean');
    await runtime.page.waitForTimeout(500);
    await expect(runtime.page.locator('[data-clearchoice-panel]')).toHaveCount(0);
    // Production cutoff is latestSeen <= now - policy * 86_400_000 (UTC ms).
    // Eight days is deliberately beyond seven, NOT an exact-boundary clock test.
    const aged = await runtime.worker.evaluate(async () => {
      const {reviewHistory} = await chrome.storage.local.get('reviewHistory');
      const timestamp = new Date(Date.now() - 8 * 86_400_000).toISOString();
      const records = (reviewHistory as FindingRecord[]).map(record => ({...record,firstSeen:timestamp,latestSeen:timestamp}));
      await chrome.storage.local.set({reviewHistory:records});
      return records;
    });
    expect(isFindingHistory(aged)).toBe(true);
    expect((await runtime.storage()).reviewHistory).toEqual(aged);
    expect(aged[0].id).toBe(original[0].id);
    popup = await runtime.popup();
    await popup.evaluate(`document.querySelector('[data-review-retention]').value='7';document.querySelector('[data-review-retention]').dispatchEvent(new Event('change',{bubbles:true}));`);
    await popup.wait(`document.querySelector('[data-review-retention]').value === '7' && !document.querySelector('[data-review-retention]').disabled`);
    const pruned = await runtime.storage();
    expect(pruned.reviewHistory).toEqual([]);
    expect(pruned.retentionPolicy).toBe(7);
    expect(pruned.subscriptions).toEqual(saved.subscriptions);
    // setRetentionPolicy/readReviewSnapshot prune history only, not receipts.
    expect(pruned.receipts).toEqual(saved.receipts);
    expect(pruned.grantState).toEqual(saved.grantState);
    await popup.close();
    const api = await runtime.permissions();
    const extensionId = runtime.extensionId;
    await runtime.restart();
    expect(await runtime.worker.evaluate(() => chrome.runtime.id)).toBe(extensionId);
    expect(await runtime.storage()).toEqual(pruned);
    expect(await runtime.permissions()).toEqual(api);
    popup = await runtime.popup();
    await popup.wait(`document.querySelector('[data-review-retention]').value === '7'`);
    expect((await runtime.storage()).reviewHistory).toEqual([]);
    expect((await runtime.storage()).subscriptions).toEqual(saved.subscriptions);
    await popup.close();
    expect(await runtime.inventory()).toEqual(before);
    await test.info().attach('synthetic-aging-real-api-readback',{body:JSON.stringify({scope:'Synthetic eight-day timestamps on same production finding; NOT elapsed-time or consent QA',findingId:original[0].id,historyCount:0,policy:7,subscriptionPreserved:true,receiptsPreserved:true,restartPreserved:true}),contentType:'application/json'});
  } finally { await runtime.stop(); }
});

test('pre-granted packaged synthetic 500-record capacity rejects real distinct observation without mutation and recovers after space is freed (NOT 500 production observations/consent QA)', async () => {
  test.setTimeout(90_000);
  const runtime = new PackagedRuntime();
  try {
    const before = await runtime.inventory();
    await runtime.start();
    let popup = await runtime.popup();
    await popup.click('[data-action="site-enable"]');
    await popup.wait(`document.querySelector('[data-site-status]').textContent.startsWith('Detection enabled for')`);
    await popup.close();
    await runtime.page.goto(runtime.a+'/checkout/recurring');
    await expect(runtime.page.locator('[data-clearchoice-panel]')).toHaveCount(1);
    const seed = ((await runtime.storage()).reviewHistory as FindingRecord[])[0];
    popup = await runtime.popup();
    await popup.evaluate(`document.querySelector('[data-review-retention]').value='never';document.querySelector('[data-review-retention]').dispatchEvent(new Event('change',{bubbles:true}));`);
    await popup.wait(`document.querySelector('[data-review-retention]').value === 'never' && !document.querySelector('[data-review-retention]').disabled`);
    expect((await runtime.storage()).retentionPolicy).toBe('never');
    await popup.close();
    await runtime.page.goto(runtime.a+'/checkout/clean');
    await runtime.page.waitForTimeout(500);
    await expect(runtime.page.locator('[data-clearchoice-panel]')).toHaveCount(0);
    const sha = (value: string) => createHash('sha256').update(value).digest('hex');
    // Derived screened evidence and IDs follow production hashing. Preserve the
    // authentic ordinal-1 seed; identical route's ordinal-2 identity is absent.
    const capacity = [seed,...Array.from({length:499},(_,index) => {
      const screenedExcerpt = `Local synthetic membership ${index + 1} renews at $12.00 per month.`;
      const opaqueFingerprint = sha(`${seed.kind}\u0000${seed.reason}\u0000${screenedExcerpt}`);
      const id = `f_${sha(JSON.stringify([seed.origin,opaqueFingerprint,1]))}`;
      return {...seed,id,screenedExcerpt,opaqueFingerprint,ordinal:1};
    })];
    expect(isFindingHistory(capacity)).toBe(true);
    expect(capacity).toHaveLength(500);
    const newId = `f_${sha(JSON.stringify([seed.origin,seed.opaqueFingerprint,2]))}`;
    expect(capacity.some(record => record.id === newId)).toBe(false);
    const authentic = await runtime.storage();
    const api = await runtime.permissions();
    await runtime.worker.evaluate(async (reviewHistory) => {await chrome.storage.local.set({reviewHistory});},capacity);
    const full = await runtime.storage();
    expect(full).toEqual({...authentic,reviewHistory:capacity});
    // Passive real-message observation only: do not replace sendMessage/listeners
    // or synthesize a batch/acknowledgement. Production worker validates fingerprints.
    await runtime.worker.evaluate(() => {
      const state = globalThis as typeof globalThis & {capacityObserved?:boolean};
      state.capacityObserved = false;
      chrome.runtime.onMessage.addListener((message, sender) => {
        if (sender.tab && message.type === 'CLEARCHOICE_AUTO_SUBMIT' && message.batch?.findings?.some((finding: {ordinal:number}) => finding.ordinal === 2)) state.capacityObserved = true;
        return false;
      });
    });
    await runtime.page.goto(runtime.a+'/checkout/identical');
    await expect.poll(() => runtime.worker.evaluate(() => (globalThis as typeof globalThis & {capacityObserved?:boolean}).capacityObserved)).toBe(true);
    await runtime.page.waitForTimeout(700);
    await expect(runtime.page.locator('[data-clearchoice-panel]')).toHaveCount(0);
    expect(await badge(runtime)).toBe('');
    expect(await runtime.storage()).toEqual(full);
    expect(await runtime.permissions()).toEqual(api);
    await runtime.page.goto(runtime.a+'/checkout/clean');
    await runtime.page.waitForTimeout(500);
    await runtime.worker.evaluate(async (record) => {await chrome.storage.local.set({reviewHistory:[record]});},seed);
    expect(await runtime.storage()).toEqual({...full,reviewHistory:[seed]});
    await runtime.page.goto(runtime.a+'/checkout/identical');
    await expect(runtime.page.locator('[data-clearchoice-panel] article')).toHaveCount(2);
    await expect.poll(() => badge(runtime)).toBe('2');
    const recovered = await runtime.storage();
    const records = recovered.reviewHistory as FindingRecord[];
    expect(isFindingHistory(records)).toBe(true);
    expect(records).toHaveLength(2);
    expect(records.map(record=>record.id).sort()).toEqual([seed.id,newId].sort());
    expect(records.find(record=>record.id === seed.id)?.firstSeen).toBe(seed.firstSeen);
    expect(recovered.receipts).toHaveLength((full.receipts as unknown[]).length+1);
    expect((recovered.receipts as unknown[]).slice(0,-1)).toEqual(full.receipts);
    expect(recovered.subscriptions).toEqual(full.subscriptions);
    expect(recovered.grantState).toEqual(full.grantState);
    expect(recovered.retentionPolicy).toBe('never');
    expect(await runtime.permissions()).toEqual(api);
    expect(await runtime.inventory()).toEqual(before);
    await test.info().attach('synthetic-capacity-real-api-readback',{body:JSON.stringify({scope:'499 derived schema-valid records plus one authentic seed; NOT 500 production observations or consent QA',preloadedCount:500,distinctObservationSeen:true,rejectedStateUnchanged:true,rejectedPanelCount:0,rejectedBadge:'',recoveredIds:records.map(record=>record.id),recoveredCount:2}),contentType:'application/json'});
  } finally { await runtime.stop(); }
});

test('pre-granted identical findings stay distinct; actual unsupported Analyze is quiet (NOT consent QA)', async () => {
  test.setTimeout(60_000);
  const runtime = new PackagedRuntime();
  try {
    const before = await runtime.inventory();
    await runtime.start();
    let popup = await runtime.popup();
    await popup.click('[data-action="site-enable"]');
    await popup.wait(`document.querySelector('[data-site-status]').textContent.startsWith('Detection enabled for')`);
    await popup.close();
    await runtime.page.goto(runtime.a+'/checkout/identical');
    await expect(runtime.page.locator('[data-clearchoice-panel] article')).toHaveCount(2);
    const records = (await runtime.storage()).reviewHistory as {id:string;ordinal:number;screenedExcerpt:string;opaqueFingerprint:string}[];
    expect(records).toHaveLength(2);
    expect(new Set(records.map(record=>record.id)).size).toBe(2);
    expect(records.map(record=>record.ordinal).sort()).toEqual([1,2]);
    expect(new Set(records.map(record=>record.screenedExcerpt)).size).toBe(1);
    expect(new Set(records.map(record=>record.opaqueFingerprint)).size).toBe(1);
    expect(await badge(runtime)).toBe('2');
    expect((await runtime.storage()).subscriptions ?? []).toEqual([]);
    await runtime.page.goto(runtime.a+'/outside');
    popup = await runtime.popup();
    await popup.click('[data-action="analyze"]');
    await popup.wait(`document.querySelector('main > [role="status"]').textContent === 'This page does not look like a supported English checkout page.'`);
    await expect(runtime.page.locator('[data-clearchoice-panel]')).toHaveCount(0);
    expect(await badge(runtime)).toBe('');
    expect((await runtime.storage()).reviewHistory).toEqual(records);
    expect((await runtime.storage()).subscriptions ?? []).toEqual([]);
    await popup.close();
    expect(await runtime.inventory()).toEqual(before);
  } finally { await runtime.stop(); }
});
