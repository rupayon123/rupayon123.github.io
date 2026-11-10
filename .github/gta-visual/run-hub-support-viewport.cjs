/** B only Home/Hub visual acceptance: SOURCE ONLY until fresh grant.
 * Local CAPTURE writes unretouched PNGs; omit CAPTURE for a logs-only VM run.
 * No trace/video/upload/user profile. Human visual review remains separate. */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const CAPTURE = process.env.GTA_QA_CAPTURE_DIR ? path.resolve(process.env.GTA_QA_CAPTURE_DIR) : null;
if (CAPTURE) fs.mkdirSync(CAPTURE,{recursive:true});
let activePage;
const globalPageErrors=[];
const networkByContext=new WeakMap();
async function capture(page,name){
  if(!CAPTURE)return;
  await page.evaluate(()=>document.fonts.ready);await page.waitForFunction(()=>[...document.images].every(i=>i.complete&&i.naturalWidth>0));
  await page.evaluate(async()=>{await Promise.allSettled(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished));await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
  const state=()=>page.evaluate(()=>{const e=document.querySelector('.skip-link'),r=e?.getBoundingClientRect(),s=e?getComputedStyle(e):null;return {activeElement:{tag:document.activeElement?.tagName,className:document.activeElement?.getAttribute('class')},scrollX,scrollY,skipLink:e?{focused:e.matches(':focus'),top:s.top,position:s.position,visibility:s.visibility,rect:{x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom}}:null};});
  const before=await state(),focused=await page.evaluateHandle(()=>document.activeElement);
  let primaryError;
  try {
    await page.evaluate(()=>window.scrollTo(0,0));await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const atCapture=await state();log('capture-state',{name,before,atCapture,focusIntentionallyUnchanged:true});
    assert(await page.evaluate(e=>document.activeElement===e,focused),'Capture must preserve original focus');
    const viewportTarget=path.join(CAPTURE,name+'-actual-viewport.png');await page.screenshot({path:viewportTarget,fullPage:false});const viewportPng=fs.readFileSync(viewportTarget);const actualViewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight,x:scrollX,y:scrollY}));assert.equal(viewportPng.readUInt32BE(16),actualViewport.width);assert.equal(viewportPng.readUInt32BE(20),actualViewport.height);log('actual-viewport-capture',{name,path:viewportTarget,sha256:digest(viewportPng),sourceCommit:COMMIT,...actualViewport});
    const target=path.join(CAPTURE,name+'.png');await page.screenshot({path:target,fullPage:true});const png=fs.readFileSync(target);log('capture',{name,path:target,sha256:digest(png),bytes:png.length,pixelWidth:png.readUInt32BE(16),pixelHeight:png.readUInt32BE(20),sourceCommit:COMMIT});
  } catch(error) {primaryError=error;throw error;} finally {
    let cleanupError;
    try {
      await page.evaluate(({x,y})=>window.scrollTo(x,y),{x:before.scrollX,y:before.scrollY});
      const restored=await state();log('capture-scroll-restored',{name,restored});assert.equal(restored.scrollX,before.scrollX);assert.equal(restored.scrollY,before.scrollY);assert(await page.evaluate(e=>document.activeElement===e,focused),'Capture cleanup must preserve focus');
    } catch(error) {cleanupError=error;log('capture-cleanup-error',{name,message:error.message,primaryError:primaryError?.message??null});}
    try {await focused.dispose();} catch(error) {cleanupError??=error;log('capture-handle-disposal-error',{name,message:error.message,primaryError:primaryError?.message??null});}
    if(cleanupError&&!primaryError)throw cleanupError;
  }
}
const { chromium } = require(process.env.GTA_QA_PLAYWRIGHT_MODULE || 'playwright-core');
const AxeBuilder = require(process.env.GTA_QA_AXE_MODULE || '@axe-core/playwright').default;
const BASE = process.env.GTA_QA_BASE_URL;
const COMMIT = process.env.GTA_QA_SOURCE_COMMIT;
const NATIVE = process.env.GTA_QA_NATIVE_SHA256;
assert(BASE && /^https:\/\/[a-z0-9-]+\.gta-free-stem\.pages\.dev$/.test(BASE), 'Require an explicit non-production Cloudflare preview');
assert(/^[a-f0-9]{40}$/.test(COMMIT || ''), 'Require the exact current candidate commit');
assert(/^[a-f0-9]{64}$/.test(NATIVE || ''), 'Require the exact current native feed hash');
const LEGACY = 'gta-stem-named-filters-v1';
const DATABASE = 'gta-scoped-saved-filters', KEY = 'gta.scopedPresets.v2';
const log = (event, data = {}) => console.log(JSON.stringify({ event, ...data }));
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const passed = [];
const pendingVisualReviews = [];
let browser;
async function test(name, body) { log('case-start', { name }); const result = await body(); assert.deepEqual(globalPageErrors,[],'No runtime page errors'); passed.push(name); log('case-pass', { name, ...result }); }
async function fresh(options = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', ...options });
  const network={hosts:new Set(),failed:[],cancelled:[],badResponses:[]};networkByContext.set(context,network);
  context.on('request',request=>{network.hosts.add(new URL(request.url()).hostname);});
  context.on('response',response=>{if(new URL(response.url()).hostname.endsWith('openfreemap.org')&&response.status()>=400)network.badResponses.push({url:response.url(),status:response.status()});});
  context.on('requestfailed',request=>{const error=request.failure()?.errorText||'unknown';const item={url:request.url(),error};if(/ERR_ABORTED|cancelled/i.test(error))network.cancelled.push(item);else network.failed.push(item);});
  context.on('page',page=>page.on('pageerror',error=>globalPageErrors.push({url:page.url(),message:error.message})));
  context.setDefaultTimeout(15000); context.setDefaultNavigationTimeout(45000);
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === BASE || url.hostname === 'tiles.openfreemap.org' || url.hostname.endsWith('.openfreemap.org')) return route.continue();
    return route.abort('blockedbyclient');
  });
  return context;
}
async function ready(page, path) {
  await page.goto(BASE + path);
  await page.locator('main').waitFor();
  if(path.startsWith('/opportunities/')||path.startsWith('/high-school/activities/'))await page.locator('.oe-explorer[data-library-status=ready]').waitFor({timeout:30000});
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0));
}
async function filters(page, student = false) {
  const toggle = page.locator(student ? '.hs-filter-toggle' : '.oe-filter-toggle');
  if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await page.locator('.scoped-saved-filters').waitFor();
  await page.waitForFunction(() => { const fieldset = document.querySelector('.scoped-saved-filters'); return fieldset && !fieldset.disabled; });
}
async function idleResults(page) { await page.waitForFunction(() => document.querySelector('.oe-results')?.getAttribute('aria-busy') === 'false'); }
async function archive(page) {
  return page.evaluate(async ({ DATABASE, KEY }) => {
    if (!(await indexedDB.databases()).some(db => db.name === DATABASE)) return null;
    return new Promise((resolve, reject) => {
      const open = indexedDB.open(DATABASE); open.onerror = () => reject(open.error);
      open.onsuccess = () => { const db = open.result, tx = db.transaction('archives', 'readonly'); let raw = null;
        const read = tx.objectStore('archives').get(KEY); read.onsuccess = () => { raw = read.result ?? null; };
        tx.oncomplete = () => { db.close(); resolve(raw); }; tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
  }, { DATABASE, KEY });
}
async function privacy(page) {
  const url = new URL(page.url());
  for (const key of ['accessSupport', 'youthCriteria', 'categories', 'includeOnRequest']) assert(!url.searchParams.has(key), key + ' must stay local');
  assert(!/sign-language|support-person|hearing-captioning/.test(url.search));
}
async function geometry(page, label) {
  const result = await page.evaluate(() => {
    const visible = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
    const box = e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    const selectorFor = e => { const parts = []; while (e && e.nodeType === 1) { const parent = e.parentElement; parts.unshift(e.tagName.toLowerCase() + (parent ? ':nth-child(' + ([...parent.children].indexOf(e) + 1) + ')' : '')); e = parent; } return parts.join(' > '); };
    const describe = e => { const s = getComputedStyle(e); return { selector: selectorFor(e), element: e.tagName, className: e.getAttribute('class'), text: e.textContent.trim(), ariaLabel: e.getAttribute('aria-label'), fontFamily: s.fontFamily, fontSize: s.fontSize, lineHeight: s.lineHeight, overflowX: s.overflowX, overflowY: s.overflowY, bounds: box(e), clientWidth: e.clientWidth, scrollWidth: e.scrollWidth, ancestors: [e.parentElement, e.parentElement?.parentElement].filter(Boolean).map(a => ({selector: selectorFor(a), bounds: box(a), overflowX: getComputedStyle(a).overflowX, overflowY: getComputedStyle(a).overflowY})) }; };
    const issues = [], metricWarnings = [], epsilon = 2;
    if (document.documentElement.scrollWidth > innerWidth + epsilon) issues.push({ kind: 'document-overflow', width: document.documentElement.scrollWidth, viewport: innerWidth });
    for (const e of document.querySelectorAll('a,button,input:not([type=hidden]),select,textarea,.hs-pathways li,.oe-card,.accessibility-filter,.scoped-saved-filters')) {
      if (!visible(e)||e.closest('.sr-only,.oe-sr-only')) continue;
      // Geographical markers may be intentionally clipped by the map canvas.
      // Map controls/popups remain checked; markers receive a separate interaction test.
      if (e.matches('.oe-map-marker,.oe-map-venue-dot')) continue;
      const r = box(e); if (r.x < -epsilon || r.right > innerWidth + epsilon) issues.push({ kind: 'control-outside-viewport', element: e.tagName, className: e.className, ...r });
    }
    for (const e of document.querySelectorAll('h1,h2,h3,h4,p,label,legend,button,dt,dd')) {
      if (!visible(e) || e.closest('.sr-only,.oe-sr-only,svg,.gta-artwork')) continue;
      const walker = document.createTreeWalker(e, NodeFilter.SHOW_TEXT), fragments = []; let node;
      while ((node = walker.nextNode())) { if (!node.textContent.trim() || node.parentElement?.closest('svg,[aria-hidden=true],.sr-only,.oe-sr-only')) continue; const range = document.createRange(); range.selectNodeContents(node); for (const r of range.getClientRects()) if (r.width && r.height) fragments.push({x:r.x,y:r.y,left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,text:node.textContent,parentSelector:selectorFor(node.parentElement)}); }
      if (e.clientWidth && e.scrollWidth > e.clientWidth + epsilon) {
        const finding = {kind: fragments.length ? 'text-horizontal-clipping' : 'nontext-scroll-overflow-needs-visual-review', ...describe(e), fragments};
        // An icon-only button still receives viewport/sibling bounds checks and a
        // mandatory original PNG review; its scrollWidth cannot prove TEXT clipping.
        (fragments.length ? issues : metricWarnings).push(finding);
      }
      for (let i = 0; i < fragments.length; i++) for (let j = i + 1; j < fragments.length; j++) {
        const a = fragments[i], b = fragments[j], dx = Math.min(a.right, b.right) - Math.max(a.left, b.left), dy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (dx > epsilon && dy > epsilon) {
          const sameLine = Math.abs(a.top-b.top) <= epsilon;
          const finding = {kind: sameLine ? 'same-line-text-fragment-overlap' : 'wrapped-line-font-rect-intersection-needs-visual-review', ...describe(e), dx, dy, fragments:[a,b], baselineAvailable:false, baselineNote:'DOM Range exposes font rectangles, not glyph ink or baselines. Different wrapped lines require original PNG inspection.'};
          (sameLine ? issues : metricWarnings).push(finding);
        }
      }
    }
    for (const selector of ['.hero-actions','.home-saved-filter-links','.home-next-steps','.home-topic-links','.hs-utility-links','.header-inner','.site-tools','.desktop-nav','.hs-pathways ul','.scoped-preset-actions','.hs-actions','.oe-card-grid','.hs-result-list','.accessibility-detail-links','.accessibility-filter','.scoped-saved-filters','.hs-pathways button']) {
      for (const parent of document.querySelectorAll(selector)) {
        const children = [...parent.children].filter(visible);
        for (let i = 0; i < children.length; i++) for (let j = i + 1; j < children.length; j++) {
          const a = box(children[i]), b = box(children[j]), dx = Math.min(a.right,b.right)-Math.max(a.x,b.x), dy = Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y);
          if (dx > epsilon && dy > epsilon) issues.push({ kind: 'sibling-overlap', selector, first: children[i].tagName, second: children[j].tagName, dx, dy });
        }
      }
    }
    const checkbox = [...document.querySelectorAll('.accessibility-filter .accessibility-check')].filter(visible).map(label => ({ label: label.textContent.trim(), labelBox: box(label), inputBox: box(label.querySelector('input')) }));
    for (const row of checkbox) if (row.labelBox.height < 47.5 || Math.abs(row.inputBox.width-20) > 1 || Math.abs(row.inputBox.height-20) > 1) issues.push({ kind: 'checkbox-target-size', ...row });
    return { viewport: innerWidth, issues, metricWarnings, checkboxCount: checkbox.length, pathwayBoxes: [...document.querySelectorAll('.hs-pathways li')].filter(visible).map(box) };
  });
  log('geometry', { label, ...result });
  // Preserve readable original evidence before a hard assertion stops the run.
  // This adds diagnostics only; the strict result.issues assertion stays below.
  for (const [index, selector] of [...new Set(result.issues.filter(w=>w.selector).map(w=>w.selector))].entries()) {
    await elementCapture(page,selector,`${label}-HARD-FAILURE-element-${index+1}`);
    await elementCapture(page,selector+' > *',`${label}-HARD-FAILURE-child-${index+1}`);
  }
  for (const [index, selector] of [...new Set(result.metricWarnings.map(w=>w.selector))].entries()) {
    const name = `${label}-mandatory-visual-review-${index+1}`;
    pendingVisualReviews.push({label, selector, capture:name+'.png', status:'PENDING human original PNG inspection', findings:result.metricWarnings.filter(w=>w.selector===selector)});
    fs.writeFileSync(path.join(CAPTURE,'mandatory-visual-reviews.json'),JSON.stringify({sourceCommit:COMMIT,surface,mode,visualAcceptance:false,pendingVisualReviews},null,2));
    await elementCapture(page, selector, name);
  }
  log('mandatory-visual-review', {label, count:result.metricWarnings.length, visualAcceptance:false});
  assert.deepEqual(result.issues, [], label + ' strict geometry assertions');
  return result;
}
async function enlargeFonts(page) {
  return page.evaluate(async () => {
    await document.fonts.ready;
    const selectorFor=e=>{const parts=[];while(e&&e.nodeType===1){const parent=e.parentElement;parts.unshift(e.tagName.toLowerCase()+(parent?':nth-child('+([...parent.children].indexOf(e)+1)+')':''));e=parent;}return parts.join(' > ');};
    const snapshot=e=>({selector:selectorFor(e),text:e.textContent?.trim().slice(0,100),connected:e.isConnected,fontSize:getComputedStyle(e).fontSize,font:getComputedStyle(e).font,inlineFontSize:e.style.getPropertyValue('font-size'),inlinePriority:e.style.getPropertyPriority('font-size'),inlineStyle:e.getAttribute('style'),animation:getComputedStyle(e).animationName,transition:getComputedStyle(e).transitionProperty,matchingFontRules:e.tagName==='H1'?[...document.styleSheets].flatMap(sheet=>{try{const out=[];const scan=rules=>{for(const rule of rules){if(rule.selectorText&&e.matches(rule.selectorText)&&(rule.style.fontSize||rule.style.font))out.push({selector:rule.selectorText,fontSize:rule.style.fontSize,fontPriority:rule.style.getPropertyPriority('font-size'),font:rule.style.font});if(rule.cssRules)scan(rule.cssRules);}};scan(sheet.cssRules);return out;}catch{return [];}}):undefined});
    const rows = [...document.querySelectorAll('h1,h2,h3,h4,p,button,input,select,textarea,label,legend,summary,a,li,dt,dd,span')]
      .filter(e => !e.closest('svg,.gta-artwork,.sr-only,.oe-sr-only')).map(e => ({ e, before: parseFloat(getComputedStyle(e).fontSize), beforeState:snapshot(e) }));
    for (const { e, before } of rows) e.style.setProperty('font-size', before * 2 + 'px', 'important');
    const immediate=rows.map(({e})=>snapshot(e));
    await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const diagnostics=rows.map(({e,before,beforeState},index)=>({before,beforeState,immediate:immediate[index],settled:snapshot(e)}));
    const samples = rows.filter(({e}) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden').map(({e,before,beforeState}) => ({ element: e.tagName, selector:beforeState.selector, before, after: parseFloat(getComputedStyle(e).fontSize) }));
    return { count: rows.length, samples, diagnostics, fontReadiness:document.fonts.status, actualTwoAnimationFramesWaited:true };
  });
}
async function savePreset(page, name) {
  await page.getByLabel('Filter name', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Save filter', exact: true }).click();
  await page.getByText('Filter saved.', { exact: true }).waitFor();
  const parsed = JSON.parse(await archive(page)); return parsed.presets.find(p => p.name === name);
}


async function theme(page,value){
  const current=await page.locator('html').getAttribute('data-theme');
  if(current!==value)await page.getByRole('button',{name:value==='dark'?'Switch to dark theme':'Switch to light theme',exact:true}).click();
  await page.waitForFunction(value=>document.documentElement.dataset.theme===value,value);
}
async function viewportSectionCapture(page,selector,name){
  const focused=await page.evaluateHandle(()=>document.activeElement);
  const before=await page.evaluate(()=>({x:scrollX,y:scrollY,width:innerWidth,height:innerHeight}));let primaryError;
  try {
    const section=await page.locator(selector).evaluate(e=>{const r=e.getBoundingClientRect();return {top:r.top+scrollY,bottom:r.bottom+scrollY,left:r.left,right:r.right,documentHeight:document.documentElement.scrollHeight};});
    assert(section.left>=-2&&section.right<=before.width+2,'Section stays inside real viewport width');
    let requested=Math.max(0,section.top-24),lastY=-1;const frames=[];
    for(let index=0;index<20;index++){
      await page.evaluate(y=>window.scrollTo(0,y),requested);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const state=await page.evaluate(()=>{const e=document.querySelector('.skip-link'),r=e?.getBoundingClientRect();return {x:scrollX,y:scrollY,width:innerWidth,height:innerHeight,activeElement:{tag:document.activeElement?.tagName,className:document.activeElement?.getAttribute('class')},skipLink:e?{focused:e.matches(':focus'),top:getComputedStyle(e).top,rect:{top:r.top,bottom:r.bottom,height:r.height}}:null};});
      assert.equal(state.width,before.width);assert.equal(state.height,before.height);assert(await page.evaluate(e=>document.activeElement===e,focused),'Real viewport capture preserves exact focus');assert(state.y>lastY,'Scroll frames must advance');lastY=state.y;
      const target=path.join(CAPTURE,`${name}-viewport-${index+1}.png`);await page.screenshot({path:target,fullPage:false});const png=fs.readFileSync(target);assert.equal(png.readUInt32BE(16),before.width);assert.equal(png.readUInt32BE(20),before.height);
      const frame={index:index+1,path:target,sha256:digest(png),pixelWidth:png.readUInt32BE(16),pixelHeight:png.readUInt32BE(20),state};frames.push(frame);log('real-viewport-section-frame',{name,selector,sourceCommit:COMMIT,...frame});
      if(state.y+state.height>=Math.min(section.documentHeight,section.bottom+24)){log('real-viewport-section-covered',{name,selector,section,frames:frames.length,overlapPixels:120,unchangedViewport:true,noStitchingOrEditing:true});return;}
      requested=Math.min(section.documentHeight-state.height,state.y+state.height-120);
    }
    throw new Error('Section coverage exceeded bounded20 real viewport frames');
  } catch(error){primaryError=error;throw error;} finally {
    let cleanupError;
    try {await page.evaluate(({x,y})=>window.scrollTo(x,y),before);assert(await page.evaluate(e=>document.activeElement===e,focused));const restored=await page.evaluate(()=>({x:scrollX,y:scrollY}));assert.equal(restored.x,before.x);assert.equal(restored.y,before.y);log('real-viewport-section-restored',{name,restored});}catch(error){cleanupError=error;log('viewport-section-cleanup-error',{name,message:error.message,primaryError:primaryError?.message??null});}
    try{await focused.dispose();}catch(error){cleanupError??=error;log('viewport-section-handle-error',{name,message:error.message,primaryError:primaryError?.message??null});}
    if(cleanupError&&!primaryError)throw cleanupError;
  }
}

const surface='hub',mode='dark';
async function footerReachable(page,name){
 const prior=await page.evaluate(()=>({x:scrollX,y:scrollY})),focus=await page.evaluateHandle(()=>document.activeElement);
 try{const links=page.locator('.legal-footer a');assert((await links.count())>0);
  for(let i=0;i<await links.count();i++){const link=links.nth(i);await link.scrollIntoViewIfNeeded();const r=await link.evaluate(e=>{const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,uncovered:!!hit&&(hit===e||e.contains(hit))};});assert(r.left>=-2&&r.right<=r.width+2&&r.top>=-2&&r.bottom<=r.height+2&&r.uncovered,JSON.stringify(r));}
  await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));const last=await page.locator('.legal-footer>p').boundingBox();assert(last&&last.y>=-2&&last.y+last.height<=await page.evaluate(()=>innerHeight)+2,'Final footer content must be reachable');
  const target=path.join(CAPTURE,name+'.png');await page.screenshot({path:target,fullPage:false});const png=fs.readFileSync(target);log('footer-reachable',{name,sourceCommit:COMMIT,path:target,sha256:digest(png),width:png.readUInt32BE(16),height:png.readUInt32BE(20)});
 }finally{await page.evaluate(p=>window.scrollTo(p.x,p.y),prior);assert(await page.evaluate(e=>document.activeElement===e,focus));await focus.dispose();}
}
async function main(){
  assert(CAPTURE);assert(process.env.GTA_QA_BROWSER);browser=await chromium.launch({executablePath:process.env.GTA_QA_BROWSER,headless:true,args:['--disable-crash-reporter']});const context=await fresh({viewport:{width:320,height:844},colorScheme:'light'}),page=await context.newPage();activePage=page;
  const response=await context.request.get(BASE+'/');assert(response.ok());assert(response.headers()['x-robots-tag']?.includes('noindex'));const m=await(await context.request.get(BASE+'/hosting-release.json')).json();assert.equal(m.sourceCommit,COMMIT);assert.equal(m.nativeFeedSha256,NATIVE);
  await ready(page,'/high-school/');await theme(page,'dark');await page.getByRole('button',{name:'Reading Buddies teen volunteer',exact:true}).waitFor();await filters(page,true);
  const enlarged=await enlargeFonts(page);log('computed-font200',{...enlarged});for(const row of enlarged.samples)assert(Math.abs(row.after/row.before-2)<.01,JSON.stringify({kind:'font200-ratio-mismatch',sample:row,diagnostics:enlarged.diagnostics.filter(d=>d.beforeState.selector.includes(' > h1:')).slice(0,1)}));
  await viewportSectionCapture(page,'.accessibility-filter','hub-320-dark-font200-support-real');
  await footerReachable(page,'hub-footer-real');
  const final=await(await context.request.get(BASE+'/hosting-release.json')).json();assert.equal(final.sourceCommit,COMMIT);assert.equal(final.nativeFeedSha256,NATIVE);assert.deepEqual(globalPageErrors,[]);log('SUPPORT-REAL-VIEWPORT-SUPPLEMENT-COMPLETE',{sourceCommit:COMMIT,scope:'Only320darkfont200 supportsection real viewport frames; not repeated Hub behavior',humanVisualReviewComplete:false,visualAcceptance:false});await context.close();
}
main().catch(async error=>{log('FIRST-FAILURE',{message:error.message,stack:error.stack});if(activePage&&!activePage.isClosed())try{const target=path.join(CAPTURE,'hub-FAILURE-viewport.png');await activePage.screenshot({path:target,fullPage:false});const png=fs.readFileSync(target);log('failure-capture',{path:target,sha256:digest(png),sourceCommit:COMMIT});}catch{}process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();});
