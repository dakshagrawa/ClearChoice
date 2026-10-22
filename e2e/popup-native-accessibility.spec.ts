import { expect, test } from 'playwright/test';
import { readFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { PackagedRuntime } from './packaged-runtime';

type Popup = Awaited<ReturnType<PackagedRuntime['popup']>>;

// Closed details may still expose layout boxes during native inspection. Only
// the first summary subtree escapes each closed ancestor's rendering boundary.
const visibilityPredicate = `e => {
  if (e.closest('[hidden]')) return false;
  for (let ancestor = e.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor.tagName !== 'DETAILS' || ancestor.open) continue;
    const summary = [...ancestor.children].find(child => child.tagName === 'SUMMARY');
    if (!summary || !summary.contains(e)) return false;
  }
  if (typeof e.checkVisibility === 'function' &&
      !e.checkVisibility({visibilityProperty:true, opacityProperty:true})) return false;
  if (!e.getClientRects().length || getComputedStyle(e).visibility !== 'visible') return false;
  for (let ancestor = e; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor);
    if (style.display === 'none' || Number(style.opacity) === 0) return false;
  }
  return true;
}`;

// Shared rendered geometry checks. Only runtime.popup() supplies evidence for
// native action-popup width; static payload snapshots below test reflow only.
const layoutMeasurements = `(() => {
  const width = document.documentElement.clientWidth;
  const visible = ${visibilityPredicate};
  return {
    width,
    bodyWidth: document.body.getBoundingClientRect().width,
    scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    clippedControls: [...document.querySelectorAll('button,select,input,textarea,a[href],summary')]
      .filter(visible).filter(e => {
        const r = e.getBoundingClientRect();
        return r.left < -1 || r.right > width + 1 || e.scrollWidth > e.clientWidth + 1;
      }).map(e => e.outerHTML),
  };
})()`;

type Layout = { width: number; bodyWidth: number; scrollWidth: number; clippedControls: string[] };

async function auditLayout(popup: Pick<Popup, 'evaluate'>, state: string, native: boolean) {
  const layout = await popup.evaluate<Layout>(layoutMeasurements);
  await test.info().attach(`${state}-layout`, { body: JSON.stringify(layout, null, 2), contentType: 'application/json' });
  if (native) {
    expect.soft(layout.width, `${state} native action-popup viewport`).toBeGreaterThanOrEqual(500);
    expect.soft(layout.width, `${state} native action-popup viewport`).toBeLessThanOrEqual(540);
    expect.soft(layout.bodyWidth, `${state} native popup body`).toBeGreaterThanOrEqual(500);
    expect.soft(layout.bodyWidth, `${state} native popup body`).toBeLessThanOrEqual(540);
  }
  expect.soft(layout.scrollWidth, `${state} horizontal overflow`).toBeLessThanOrEqual(layout.width + 1);
  expect.soft(layout.clippedControls, `${state} controls fit without clipping`).toEqual([]);
}

// Capture only rendered payload and the actual loaded built CSS while the genuine
// popup is open. The replay has no application scripts, extension APIs or RPC.
async function capturePayloadLayout(popup: Popup) {
  return popup.evaluate<{ html: string; css: string }>(`(() => {
    const css = [...document.styleSheets].map(sheet => [...sheet.cssRules].map(rule => rule.cssText).join('\\n')).join('\\n');
    const clone = document.documentElement.cloneNode(true);
    const originals = document.querySelectorAll('input,textarea,select');
    clone.querySelectorAll('input,textarea,select').forEach((e,i) => {
      const original = originals[i];
      if(e.tagName === 'TEXTAREA') e.textContent = original.value;
      else if(e.tagName === 'SELECT') [...e.options].forEach((option,j) => option.toggleAttribute('selected', original.options[j].selected));
      else {
        e.setAttribute('value', original.value);
        e.toggleAttribute('checked', original.checked);
      }
    });
    clone.querySelectorAll('script,link,style,iframe,object,embed,base,meta').forEach(e => e.remove());
    clone.querySelectorAll('*').forEach(e => [...e.attributes].forEach(attribute => {
      if(/^on/i.test(attribute.name) || ['src','srcset','action','formaction'].includes(attribute.name)) e.removeAttribute(attribute.name);
    }));
    return {html: '<!doctype html>' + clone.outerHTML, css};
  })()`);
}

// Rendered measurements, not token/CSS inspection. Chrome setup pregrants the
// reserved, form-free HTTPS fixture; CDP trusted input is NOT human consent QA.
const measurements = `(() => {
  const rgba = value => {
    const values = value.match(/[\\d.]+/g)?.map(Number);
    if (!values || values.length < 3) throw Error('Unsupported computed color: '+value);
    return [...values.slice(0,3), values[3] ?? 1];
  };
  const over = (fg,bg) => {
    const a = fg[3] + bg[3]*(1-fg[3]);
    return [...fg.slice(0,3).map((c,i)=>(c*fg[3]+bg[i]*bg[3]*(1-fg[3]))/a),a];
  };
  const background = element => {
    const layers=[];
    for(let e=element;e;e=e.parentElement) {
      const s=getComputedStyle(e);
      if(s.backgroundImage!=='none' || Number(s.opacity)!==1) throw Error('Non-flat/opacity surface requires pixel audit: '+e.outerHTML);
      const color=rgba(s.backgroundColor); layers.push(color);
      if(color[3]===1) break;
    }
    if(layers.at(-1)?.[3]!==1) throw Error('No opaque ancestor; do not assume white');
    return layers.reverse().reduce((bg,fg)=>over(fg,bg));
  };
  const lum = c => c.slice(0,3).map(x=>x/255).map(x=>x<=0.04045?x/12.92:((x+0.055)/1.055)**2.4).reduce((a,x,i)=>a+x*[0.2126,0.7152,0.0722][i],0);
  const contrast = (a,b) => (Math.max(lum(a),lum(b))+0.05)/(Math.min(lum(a),lum(b))+0.05);
  const visible = ${visibilityPredicate};
  const identity = e => ({tag:e.tagName, name:e.getAttribute('aria-label') || e.getAttribute('name') || e.textContent.trim().slice(0,100), action:e.dataset.action || e.dataset.subscriptionAction || null});
  const controls=[...document.querySelectorAll('button,select,input,textarea,a[href],summary')].filter(visible);
  const disabled=controls.filter(e=>e.matches(':disabled')).map(identity);
  const text=[];
  for(const e of document.querySelectorAll('body *')) {
    if(!visible(e) || e.closest(':disabled') || ['SCRIPT','STYLE','OPTION'].includes(e.tagName)) continue;
    const content=[...e.childNodes].filter(n=>n.nodeType===Node.TEXT_NODE).map(n=>n.textContent).join('').trim();
    if(!content && !['INPUT','TEXTAREA','SELECT'].includes(e.tagName)) continue;
    const s=getComputedStyle(e), bg=background(e), fg=over(rgba(s.color),bg);
    const large=parseFloat(s.fontSize)>=24 || (parseFloat(s.fontSize)>=18.6667 && Number(s.fontWeight)>=700);
    text.push({...identity(e),text:content.slice(0,100),color:s.color,background:bg,font:s.fontSize,weight:s.fontWeight,ratio:contrast(fg,bg),minimum:large?3:4.5});
  }
  const targets=controls.filter(e=>!e.matches(':disabled')).map(e=> {
    const r=e.getBoundingClientRect();
    // Inline help links have no authored 44px policy. WCAG 2.5.8 permits
    // undersized targets when their 24px diameter circles do not intersect
    // another target/circle. Do not silently exempt all anchors.
    const spaced=controls.filter(o=>o!==e && !o.matches(':disabled')).every(o=>{
      const b=o.getBoundingClientRect(), x=r.x+r.width/2,y=r.y+r.height/2;
      if(b.width<24 || b.height<24) return Math.hypot(x-b.x-b.width/2,y-b.y-b.height/2)>=24;
      return Math.hypot(Math.max(b.x-x,0,x-b.right),Math.max(b.y-y,0,y-b.bottom))>=12;
    });
    return {...identity(e),width:r.width,height:r.height,policy:e.tagName==='A'?'WCAG 2.5.8 spacing':'authored 44px',pass:e.tagName==='A'?(r.width>=24 && r.height>=24)||spaced:r.width>=44 && r.height>=44};
  });
  const e=document.activeElement;
  let focus=null;
  if(controls.includes(e) && !e.matches(':disabled')) {
    const s=getComputedStyle(e), bg=background(e.parentElement), outline=rgba(s.outlineColor);
    const r=e.getBoundingClientRect(), hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
    // Chromium native-popup scaling leaves scroll edges up to one CSS pixel
    // fractional (observed 0.686px); retain exact rectangles in the evidence.
    // This is rounding tolerance, not permission for clipped/occluded controls.
    focus={...identity(e),rect:{x:r.x,y:r.y,width:r.width,height:r.height},viewport:{width:innerWidth,height:innerHeight},visible:e.matches(':focus-visible'),inViewport:r.top>=-1 && r.bottom<=innerHeight+1 && r.left>=-1 && r.right<=innerWidth+1,hit:hit===e || e.contains(hit),outlineStyle:s.outlineStyle,outlineWidth:parseFloat(s.outlineWidth),outlineColor:s.outlineColor,shadow:s.boxShadow,ratio:contrast(over(outline,bg),bg)};
  }
  return {text,targets,disabled,focus,theme:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'};
})()`;

type Measures = {
  text: { name: string; ratio: number; minimum: number }[];
  targets: { name: string; pass: boolean }[];
  disabled: unknown[];
  focus: { name: string; visible: boolean; inViewport: boolean; hit: boolean; outlineStyle: string; outlineWidth: number; ratio: number } | null;
  theme: string;
};

async function key(popup: Popup, keyName: 'Tab' | 'Enter', shift = false) {
  const code = keyName === 'Tab' ? 9 : 13;
  for (const type of ['keyDown', 'keyUp']) await popup.send('Input.dispatchKeyEvent', {
    type, key: keyName, code: keyName, windowsVirtualKeyCode: code, modifiers: shift ? 8 : 0,
    ...(keyName === 'Enter' && type === 'keyDown' ? { text: '\r', unmodifiedText: '\r' } : {}),
  });
  // Native keyboard scroll and synthesized activation settle on rendering frames.
  await popup.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
}

async function keyboardCancel(popup: Popup) {
  const count = await popup.evaluate<number>(`document.querySelectorAll('button,select,input,textarea,a[href],summary').length`);
  for (let step = 0; step <= count; step++) {
    if (await popup.evaluate(`document.activeElement.matches('[data-subscription-action="cancel"]')`)) {
      await key(popup, 'Enter');
      return;
    }
    await key(popup, 'Tab');
  }
  throw Error('Cancel unreachable via native popup keyboard traversal');
}

async function attachNativeScreenshot(popup: Popup, theme: string, state: string) {
  const screenshot = await popup.send('Page.captureScreenshot', { format: 'png' });
  await test.info().attach(`${theme}-${state}-native-popup`, { body: Buffer.from(screenshot.data as string, 'base64'), contentType: 'image/png' });
}

async function audit(popup: Popup, theme: string, state: string) {
  await auditLayout(popup, `${theme}-${state}`, true);
  await attachNativeScreenshot(popup, theme, state);
  const measured = await popup.evaluate<Measures>(measurements);
  await test.info().attach(`${theme}-${state}-computed`, { body: JSON.stringify(measured, null, 2), contentType: 'application/json' });
  expect.soft(measured.theme).toBe(theme);
  expect.soft(measured.text.length).toBeGreaterThan(10);
  expect.soft(measured.text.filter(t => t.ratio < t.minimum), `${theme}/${state} rendered text contrast`).toEqual([]);
  expect.soft(measured.targets.filter(t => !t.pass), `${theme}/${state} actual target geometry`).toEqual([]);
  const axe = await popup.evaluate(`axe.run().then(r=>r.violations.filter(v=>['serious','critical'].includes(v.impact)).map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))})))`);
  await test.info().attach(`${theme}-${state}-axe`, { body: JSON.stringify(axe, null, 2), contentType: 'application/json' });
  expect.soft(axe, `${theme}/${state} full Axe serious/critical`).toEqual([]);
}

async function keyboardReview(popup: Popup, theme: string, state: string) {
  const count = await popup.evaluate<number>(`(() => {
    const visible = ${visibilityPredicate};
    const controls=[...document.querySelectorAll('button,select,input,textarea,a[href],summary')].filter(e=>!e.disabled && visible(e));
    controls.forEach((e,i)=>e.dataset.a11yOrder=String(i));
    controls[0].focus(); return controls.length;
  })()`);
  const evidence: unknown[] = [];
  // Initial focus is only a traversal anchor. Every measured focus follows
  // actual CDP Tab/Shift+Tab, including forward/backward checks of each control.
  for (let i = 1; i < count; i++) {
    await key(popup, 'Tab');
    expect.soft(await popup.evaluate(`document.activeElement.dataset.a11yOrder`), `${state} forward order`).toBe(String(i));
    const result = await popup.evaluate<Measures>(measurements);
    if (result.focus?.name === 'nextBillingDate') {
      const diagnostic = await popup.evaluate(`(async () => {
        const e=document.activeElement, frames=[];
        for(let i=0;i<12;i++) {
          const s=getComputedStyle(e);
          frames.push({frame:i,active:document.activeElement===e,documentFocus:document.hasFocus(),focus:e.matches(':focus'),focusVisible:e.matches(':focus-visible'),focusWithin:e.matches(':focus-within'),outline:s.outline,shadow:s.boxShadow});
          await new Promise(resolve=>requestAnimationFrame(resolve));
        }
        return {html:e.outerHTML,frames};
      })()`);
      await test.info().attach(`${theme}-${state}-date-forward-diagnostic`, { body: JSON.stringify(diagnostic, null, 2), contentType: 'application/json' });
      await popup.send('DOM.enable');
      const dom = await popup.send('DOM.getDocument', { depth: -1, pierce: true });
      await test.info().attach(`${theme}-${state}-date-forward-shadow-dom`, { body: JSON.stringify(dom, null, 2), contentType: 'application/json' });
      const screenshot = await popup.send('Page.captureScreenshot');
      await test.info().attach(`${theme}-${state}-date-forward-pixels`, { body: Buffer.from(screenshot.data as string, 'base64'), contentType: 'image/png' });
    }
    evidence.push(result.focus);
    expect.soft(result.focus?.inViewport, `${state} focus target within viewport`).toBe(true);
    expect.soft(result.focus?.hit, `${state} focused target center hit-tests correctly`).toBe(true);
    expect.soft(result.focus?.visible, `${theme}/${state} ${result.focus?.name} focus-visible`).toBe(true);
    expect.soft(result.focus?.outlineStyle).not.toBe('none');
    expect.soft(result.focus?.outlineWidth).toBeGreaterThanOrEqual(1);
    expect.soft(result.focus?.ratio, `${theme}/${state} ${result.focus?.name} focus contrast`).toBeGreaterThanOrEqual(3);
  }
  for (let i = count - 2; i >= 0; i--) {
    await key(popup, 'Tab', true);
    expect.soft(await popup.evaluate(`document.activeElement.dataset.a11yOrder`), `${state} reverse order`).toBe(String(i));
    const result = await popup.evaluate<Measures>(measurements);
    evidence.push(result.focus);
    expect.soft(result.focus?.inViewport, `${state} focus target within viewport`).toBe(true);
    expect.soft(result.focus?.hit, `${state} focused target center hit-tests correctly`).toBe(true);
    expect.soft(result.focus?.visible).toBe(true);
    expect.soft(result.focus?.outlineWidth).toBeGreaterThanOrEqual(1);
    expect.soft(result.focus?.ratio).toBeGreaterThanOrEqual(3);
  }
  await test.info().attach(`${theme}-${state}-keyboard`, { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
}

async function keyboardDisclosure(popup: Popup, theme: string) {
  const summary = '.site-detection details > summary';
  const reachSummary = async () => {
    const count = await popup.evaluate<number>(`document.querySelectorAll('button,select,input,textarea,a[href],summary').length`);
    for (let step = 0; step <= count; step++) {
      if (await popup.evaluate(`document.activeElement.matches('${summary}')`)) return;
      await key(popup, 'Tab');
    }
    throw Error('Site detection disclosure unreachable via native keyboard traversal');
  };
  const checkState = async (open: boolean) => {
    expect(await popup.evaluate(`document.querySelector('.site-detection details').open`)).toBe(open);
    expect(await popup.evaluate(`document.activeElement.matches('${summary}')`), 'Enter retains disclosure focus').toBe(true);
    const result = await popup.evaluate<Measures>(measurements);
    expect(result.focus?.name).toBe('About site detection');
    expect(result.focus?.visible).toBe(true);
    expect(result.focus?.inViewport).toBe(true);
    expect(result.focus?.hit).toBe(true);
    expect(result.focus?.outlineStyle).not.toBe('none');
    expect(result.focus?.outlineWidth).toBeGreaterThanOrEqual(1);
    expect(result.focus?.ratio).toBeGreaterThanOrEqual(3);
    expect(result.text.some(t => t.name.startsWith('Optional detection on supported English')), 'Disclosure content included only when open').toBe(open);
    const visibility = await popup.evaluate<{
      paragraph: boolean; nested: boolean; summary: boolean;
      nativeParagraph: boolean | null; nativeNested: boolean | null; nativeSummary: boolean | null;
    }>(`(() => {
      const visible = ${visibilityPredicate};
      const details = document.querySelector('.site-detection details');
      const paragraph = details.querySelector(':scope > p');
      const summary = details.querySelector(':scope > summary');
      // Wrap existing text without adding controls or changing its styling.
      const nested = document.createElement('span');
      while (paragraph.firstChild) nested.append(paragraph.firstChild);
      paragraph.append(nested);
      const native = e => typeof e.checkVisibility === 'function'
        ? e.checkVisibility({visibilityProperty:true, opacityProperty:true}) : null;
      try {
        return {paragraph:visible(paragraph), nested:visible(nested), summary:visible(summary),
          nativeParagraph:native(paragraph), nativeNested:native(nested), nativeSummary:native(summary)};
      } finally {
        nested.replaceWith(...nested.childNodes);
      }
    })()`);
    expect(visibility.paragraph, 'Paragraph rendered only when open').toBe(open);
    expect(visibility.nested, 'Nested paragraph descendant rendered only when open').toBe(open);
    expect(visibility.summary, 'First summary remains rendered when closed').toBe(true);
    if (visibility.nativeParagraph !== null) {
      expect(visibility.nativeParagraph, 'Native painted paragraph visibility agrees with disclosure state').toBe(open);
      expect(visibility.nativeNested, 'Native nested descendant visibility agrees with disclosure state').toBe(open);
      expect(visibility.nativeSummary, 'Native first summary visibility').toBe(true);
    }
  };
  await reachSummary();
  await checkState(false);
  await key(popup, 'Enter');
  await checkState(true);
  await audit(popup, theme, 'review-help-disclosure-open');
  await keyboardReview(popup, theme, 'review-help-disclosure-open');
  await reachSummary();
  await key(popup, 'Enter');
  await checkState(false);
  // Traverse the closed disclosure too: its contents must add no Tab stops,
  // while the surrounding status, warning and action checks remain in audit.
  await audit(popup, theme, 'review-help-disclosure-closed');
  await keyboardReview(popup, theme, 'review-help-disclosure-closed');
}

for (const theme of ['light', 'dark'] as const) {
  test(`native packaged ${theme}: rendered review/help, manual editor and delete confirmation accessibility (NOT human QA)`, async () => {
    test.setTimeout(90_000);
    const runtime = new PackagedRuntime();
    const before = await runtime.inventory();
    try {
      await runtime.start();
      let popup = await runtime.popup();
      await popup.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
      await popup.wait(`document.querySelector('[data-review-status]').textContent === 'No retained observations.'`);
      expect(await popup.evaluate(`document.querySelector('nav[aria-label="Review history pages"]').hidden`), 'Empty history hides pagination').toBe(true);
      expect(await popup.evaluate(`document.querySelector('nav[aria-label="Review history pages"]').getBoundingClientRect().height`)).toBe(0);
      expect(await popup.evaluate(`document.querySelector('[data-action="review-refresh"]').disabled`)).toBe(false);
      await popup.click('[data-action="site-enable"]');
      await popup.wait(`document.querySelector('[data-site-status]').textContent.startsWith('Detection enabled for')`);
      await popup.close();
      await runtime.page.goto(runtime.a + '/checkout/recurring');
      await expect(runtime.page.locator('[data-clearchoice-panel]')).toHaveCount(1);
      popup = await runtime.popup();
      await popup.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
      await popup.evaluate(await readFile('node_modules/axe-core/axe.min.js', 'utf8'));
      await popup.wait(`document.querySelectorAll('[data-review-id]').length === 1`);
      expect(await popup.evaluate(`document.querySelector('nav[aria-label="Review history pages"]').hidden`), 'Retained history restores pagination').toBe(false);
      await popup.click('[data-action="review-as-subscription"]');
      await auditLayout(popup, `${theme}-review-editor`, true);
      await attachNativeScreenshot(popup, theme, 'review-editor');
      for (const [name, value] of Object.entries({ merchant: 'Fake local membership', amount: '12.00', currency: 'USD', cadence: 'monthly' })) await popup.fill(name, value);
      await popup.click('[data-subscription-editor] [type="submit"]');
      await popup.wait(`document.querySelector('[aria-label="Subscriptions"] > [role="status"]').textContent === 'Subscription saved locally.'`);
      const saved = (await runtime.storage()).subscriptions;
      expect(saved).toHaveLength(1);
      await popup.click('[data-subscription-action="help"]');
      await popup.wait(`document.querySelector('[data-subscription-list]').textContent.includes('No known provider site; check your billing provider')`);
      // Reserved mock origins are deliberately not provider sites. Exercise the
      // genuine no-link help fallback without forging a provider or opening one.
      expect(await popup.evaluate(`document.querySelectorAll('[data-subscription-list] a').length`)).toBe(0);
      await keyboardDisclosure(popup, theme);
      const reviewHelpPayload = await capturePayloadLayout(popup);
      await audit(popup, theme, 'review-help');
      await keyboardReview(popup, theme, 'review-help');

      await popup.click('[data-subscription-action="add"]');
      const manualEditorPayload = await capturePayloadLayout(popup);
      await audit(popup, theme, 'manual-editor');
      await keyboardReview(popup, theme, 'manual-editor');
      // Genuine native form errors: visible associations and first-invalid focus.
      await popup.click('[data-subscription-editor] [type="submit"]');
      expect(await popup.evaluate(`document.activeElement.name`)).toBe('merchant');
      expect(await popup.evaluate(`(() => {
        const field = document.activeElement;
        return field.getAttribute('aria-invalid') === 'true' &&
          !!document.getElementById(field.getAttribute('aria-describedby'))?.textContent;
      })()`)).toBe(true);
      expect(await popup.evaluate(`document.querySelector('[name="customDescription"]').closest('label').hidden`)).toBe(true);
      await audit(popup, theme, 'manual-editor-errors');
      await popup.send('Emulation.setEmulatedMedia', { features: [
        { name: 'prefers-color-scheme', value: theme },
        { name: 'forced-colors', value: 'active' },
        { name: 'prefers-reduced-motion', value: 'reduce' },
      ] });
      expect(await popup.evaluate(`matchMedia('(forced-colors: active)').matches && matchMedia('(prefers-reduced-motion: reduce)').matches`)).toBe(true);
      await auditLayout(popup, `${theme}-forced-colors-reduced-motion-editor`, true);
      await attachNativeScreenshot(popup, theme, 'forced-colors-reduced-motion-editor');
      await popup.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
      await keyboardCancel(popup);
      expect(await popup.evaluate(`document.activeElement.dataset.subscriptionAction`)).toBe('add');
      expect((await runtime.storage()).subscriptions).toEqual(saved);
      // History refresh rebuilds its rows; cancellation must return to the live
      // new review control, not a detached element from the previous render.
      await popup.click('[data-action="review-refresh"]');
      await popup.wait(`document.querySelectorAll('[data-review-id]').length === 1 && !document.querySelector('[data-action="review-refresh"]').disabled`);
      await popup.click('[data-action="review-as-subscription"]');
      await keyboardCancel(popup);
      expect(await popup.evaluate(`document.activeElement.isConnected && document.activeElement.dataset.action === 'review-as-subscription'`)).toBe(true);

      await popup.click('[data-subscription-action="delete"]');
      await audit(popup, theme, 'delete-confirmation');
      await keyboardReview(popup, theme, 'delete-confirmation');
      await keyboardCancel(popup);
      expect(await popup.evaluate(`document.activeElement.isConnected && document.activeElement.dataset.subscriptionAction === 'delete'`)).toBe(true);
      expect((await runtime.storage()).subscriptions).toEqual(saved);
      await popup.close();

      // Payload-layout ONLY: synthetic static DOM from genuine native states,
      // reflowed with the actual built CSS. This is not privileged integration
      // or native-popup sizing evidence. Never navigate to the extension here.
      const narrow = await runtime.context.newPage();
      await narrow.setViewportSize({ width: 320, height: 720 });
      await narrow.emulateMedia({ colorScheme: theme });
      const narrowPopup = { evaluate: <T>(expression: string) => narrow.evaluate<T, undefined>(expression, undefined) };
      for (const [state, payload] of [['review-help', reviewHelpPayload], ['manual-editor', manualEditorPayload]] as const) {
        expect(payload.css, `${state} actual built popup CSS`).not.toBe('');
        await narrow.setContent(payload.html);
        await narrow.addStyleTag({ content: payload.css });
        await expect(narrow.locator('[data-subscription-action="help"]')).toHaveCount(1);
        await expect(narrow.locator('[data-subscription-list]')).toContainText('No known provider site');
        if (state === 'manual-editor') await expect(narrow.locator('[data-subscription-editor]')).toBeVisible();
        expect(await narrow.evaluate(() => window.innerWidth)).toBe(320);
        const rootClientWidth = await narrow.evaluate(() => document.documentElement.clientWidth);
        expect(rootClientWidth).toBeGreaterThan(0);
        expect(rootClientWidth).toBeLessThanOrEqual(320);
        await auditLayout(narrowPopup, `${theme}-320px-${state}-payload-layout-ONLY`, false);
        expect(await narrow.evaluate(() => document.body.getBoundingClientRect().width)).toBeLessThanOrEqual(320);
        await narrow.addStyleTag({ content: ':root { font-size: 175% !important; }' });
        await auditLayout(narrowPopup, `${theme}-320px-200percent-text-${state}-payload-layout-ONLY`, false);
      }
      await narrow.close();
    } finally {
      expect(await runtime.inventory(), 'approved dist must remain byte-identical').toEqual(before);
      await runtime.stop();
    }
  });
}
