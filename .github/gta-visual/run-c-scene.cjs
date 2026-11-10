/** C only Browse/Teen real List visual acceptance: SOURCE ONLY until fresh grant.
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
function clampedRangeDuplicate(a,b){
 const eps=2,inside=(r,p)=>r.left>=p.left-eps&&r.right<=p.right+eps&&r.top>=p.top-eps&&r.bottom<=p.bottom+eps;
 const contains=(x,y)=>x.left<=y.left+eps&&x.right>=y.right-eps&&x.top<=y.top+eps&&x.bottom>=y.bottom-eps;
 return Number.isInteger(a.nodeIndex)&&a.nodeIndex===b.nodeIndex&&a.parentSelector===b.parentSelector&&a.lineClamp>0&&a.lineClamp===b.lineClamp&&a.clipHidden&&b.clipHidden&&a.normalLeading&&b.normalLeading&&Math.abs(a.top-b.top)<=eps&&Math.abs(a.bottom-b.bottom)<=eps&&(Math.abs(a.left-b.left)<=eps||Math.abs(a.right-b.right)<=eps)&&(contains(a,b)||contains(b,a))&&inside(a,a.parentBox)&&inside(b,b.parentBox);
}
async function rangeClampRegression(page){
 const collect=(container)=>{const walker=document.createTreeWalker(container,NodeFilter.SHOW_TEXT),out=[];let node,index=0;while((node=walker.nextNode())){if(!node.textContent.trim())continue;const id=index++,parent=node.parentElement,style=getComputedStyle(parent),box=parent.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(node);for(const r of range.getClientRects())if(r.width&&r.height)out.push({left:r.left,right:r.right,top:r.top,bottom:r.bottom,nodeIndex:id,parentSelector:parent.id||parent.tagName,lineClamp:parseInt(style.webkitLineClamp)||0,clipHidden:style.overflowX==='hidden'&&style.overflowY==='hidden',normalLeading:parseFloat(style.lineHeight)>=parseFloat(style.fontSize),parentBox:{left:box.left,right:box.right,top:box.top,bottom:box.bottom}});}return out;};
 const actual=[];for(const summary of await page.locator('.oe-summary').all())actual.push(await summary.evaluate(collect));
 let actualPairs=0;for(const rows of actual)for(let i=0;i<rows.length;i++)for(let j=i+1;j<rows.length;j++)if(clampedRangeDuplicate(rows[i],rows[j]))actualPairs++;
 assert(actualPairs>0,'Actual clamped source paragraphs must exercise the duplicate-range classification');
 const scratch=await page.context().newPage();try{
  await scratch.setContent('<style>p{position:relative;width:240px;height:70px;font:15px/25.5px Arial}#collision span{position:absolute;left:0;top:0;width:200px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}#plain{height:auto;display:block;overflow:visible}</style><p id="collision"><span id="a">Actual overlap</span><span id="b">Actual overlap</span></p><p id="plain">A long description wraps normally over several lines without a clamp. A long description wraps normally over several lines without a clamp.</p>');
  const bad=await scratch.locator('#collision').evaluate(collect);assert.equal(bad.length,2);assert(Math.min(bad[0].right,bad[1].right)-Math.max(bad[0].left,bad[1].left)>2);assert(Math.min(bad[0].bottom,bad[1].bottom)-Math.max(bad[0].top,bad[1].top)>2);assert(!clampedRangeDuplicate(bad[0],bad[1]),'Genuinely overlapping separate DOM text nodes remain hard failures');
  const plain=await scratch.locator('#plain').evaluate(collect);for(let i=0;i<plain.length;i++)for(let j=i+1;j<plain.length;j++)assert(!clampedRangeDuplicate(plain[i],plain[j]));
  log('range-clamp-regression',{actualSourceDuplicatePairs:actualPairs,actualPaintedOverlapTwoNodesNotPromoted:true,unclampedTextNotPromoted:true,productDOMUnmodified:true});
 }finally{await scratch.close();}
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
      const walker = document.createTreeWalker(e, NodeFilter.SHOW_TEXT), fragments = []; let node,nodeIndex=0;
      while ((node = walker.nextNode())) { if (!node.textContent.trim() || node.parentElement?.closest('svg,[aria-hidden=true],.sr-only,.oe-sr-only')) continue; const id=nodeIndex++,parentStyle=getComputedStyle(node.parentElement),parentRect=node.parentElement.getBoundingClientRect();const range = document.createRange(); range.selectNodeContents(node); for (const r of range.getClientRects()) if (r.width && r.height) fragments.push({nodeIndex:id,lineClamp:parseInt(parentStyle.webkitLineClamp)||0,clipHidden:parentStyle.overflowX==='hidden'&&parentStyle.overflowY==='hidden',normalLeading:parseFloat(parentStyle.lineHeight)>=parseFloat(parentStyle.fontSize),parentBox:{left:parentRect.left,right:parentRect.right,top:parentRect.top,bottom:parentRect.bottom},x:r.x,y:r.y,left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,text:node.textContent,parentSelector:selectorFor(node.parentElement)}); }
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
  const clampArtifacts=result.issues.filter(issue=>issue.kind==='same-line-text-fragment-overlap'&&issue.fragments?.length===2&&clampedRangeDuplicate(issue.fragments[0],issue.fragments[1]));
  result.issues=result.issues.filter(issue=>!clampArtifacts.includes(issue));
  result.metricWarnings.push(...clampArtifacts.map(issue=>({...issue,kind:'clamped-single-node-duplicate-range-needs-original-PNG-review',note:'A single normally spaced, explicitly clamped text node exposes two contained rectangles for its ellipsized last line. Original image inspection remains mandatory.'})));
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
    const snapshot=e=>({selector:selectorFor(e),text:e.textContent?.trim().slice(0,100),connected:e.isConnected,fontSize:getComputedStyle(e).fontSize,font:getComputedStyle(e).font,inlineFontSize:e.style.getPropertyValue('font-size'),inlinePriority:e.style.getPropertyPriority('font-size'),inlineStyle:e.getAttribute('style')});
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
async function elementCapture(page,selector,name){const locator=page.locator(selector).first();if(!await locator.isVisible())return;await page.evaluate(()=>document.fonts.ready);const target=path.join(CAPTURE,name+'.png');log('element-capture-state',{name,selector,...await page.evaluate(()=>({activeElement:{tag:document.activeElement?.tagName,className:document.activeElement?.getAttribute('class')},scrollX,scrollY}))});await locator.screenshot({path:target});const png=fs.readFileSync(target);log('element-capture',{selector,name,path:target,sha256:digest(png),pixelWidth:png.readUInt32BE(16),pixelHeight:png.readUInt32BE(20),sourceCommit:COMMIT});}
async function axe(page,label){
  const previous=await page.evaluateHandle(()=>document.activeElement);
  const state=()=>page.evaluate(()=>({tag:document.activeElement?.tagName,className:document.activeElement?.getAttribute('class'),scrollX,scrollY}));
  const before=await state();
  try {
    const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();
    const afterAudit=await state();
    await page.evaluate(({element,before})=>{if(element===document.body){if(document.activeElement instanceof HTMLElement)document.activeElement.blur();}else{if(!(element instanceof HTMLElement)||!element.isConnected)throw new Error('Pre-audit focus target unavailable');element.focus({preventScroll:true});}window.scrollTo(before.scrollX,before.scrollY);},{element:previous,before});
    const restored=await state();const sameElement=await page.evaluate(element=>document.activeElement===element,previous);
    log('axe-focus-scroll-restoration',{label,before,afterAudit,restored,sameElement,dedicatedKeyboardFocusChecksUnchanged:true});
    assert(sameElement,'Restore exact pre-audit activeElement');assert.equal(restored.scrollX,before.scrollX);assert.equal(restored.scrollY,before.scrollY);
    log('axe',{label,violations:result.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.length}))});assert.equal(result.violations.length,0,JSON.stringify({label,violations:result.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary})).slice(0,3)}))}));
  } finally {await previous.dispose();}
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

async function dialogViewportSectionCapture(page,selector,name){
  await page.evaluate(()=>document.fonts.ready);await page.waitForFunction(()=>[...document.images].every(i=>i.complete&&i.naturalWidth>0));
  const dialog=page.locator('dialog.oe-detail[open]');assert.equal(await dialog.count(),1);
  assert(await page.locator(selector).evaluate(e=>e.closest('dialog.oe-detail')?.open),'Evidence must be inside the open actual dialog');
  const focused=await page.evaluateHandle(()=>document.activeElement);
  const before=await dialog.evaluate(e=>({windowX:scrollX,windowY:scrollY,top:e.scrollTop,left:e.scrollLeft,width:innerWidth,height:innerHeight}));let primaryError;
  try{
    const section=await page.locator(selector).evaluate(e=>{const d=e.closest('dialog.oe-detail'),r=e.getBoundingClientRect(),dr=d.getBoundingClientRect();return {top:r.top-dr.top-d.clientTop+d.scrollTop,bottom:r.bottom-dr.top-d.clientTop+d.scrollTop,scrollHeight:d.scrollHeight};});
    let requested=Math.max(0,section.top-24),lastTop=-1;
    for(let index=0;index<20;index++){
      await dialog.evaluate((e,y)=>e.scrollTo(0,y),requested);await page.waitForFunction(top=>{const e=document.querySelector('dialog.oe-detail[open]');return e&&Math.abs(e.scrollTop-Math.max(0,Math.min(top,e.scrollHeight-e.clientHeight)))<1;},requested);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const state=await dialog.evaluate(e=>{const r=e.getBoundingClientRect();return {scrollTop:e.scrollTop,scrollLeft:e.scrollLeft,clientHeight:e.clientHeight,windowX:scrollX,windowY:scrollY,width:innerWidth,height:innerHeight,open:e.open,port:{top:r.top+e.clientTop,bottom:r.top+e.clientTop+e.clientHeight,left:r.left+e.clientLeft,right:r.left+e.clientLeft+e.clientWidth}};});
      assert(state.open);assert.equal(state.width,before.width);assert.equal(state.height,before.height);assert.equal(state.windowX,before.windowX);assert.equal(state.windowY,before.windowY);
      assert(state.port.top>=-2&&state.port.bottom<=state.height+2&&state.port.left>=-2&&state.port.right<=state.width+2,'Actual dialog scrollport must be inside real viewport');
      assert(state.clientHeight>120);assert(state.scrollTop>lastTop,'Dialog frames must advance');lastTop=state.scrollTop;
      assert(await page.evaluate(e=>document.activeElement===e,focused),'Dialog capture preserves exact focus');
      const target=path.join(CAPTURE,name+'-dialog-viewport-'+(index+1)+'.png');await page.screenshot({path:target,fullPage:false});const png=fs.readFileSync(target);assert.equal(png.readUInt32BE(16),before.width);assert.equal(png.readUInt32BE(20),before.height);
      log('real-dialog-section-frame',{name,selector,sourceCommit:COMMIT,index:index+1,path:target,sha256:digest(png),pixelWidth:png.readUInt32BE(16),pixelHeight:png.readUInt32BE(20),state});
      if(state.scrollTop+state.clientHeight>=Math.min(section.scrollHeight,section.bottom+24)){log('real-dialog-section-covered',{name,selector,section,frames:index+1,overlapPixels:120,unchangedViewport:true,noStitchingOrEditing:true});return;}
      requested=Math.min(section.scrollHeight-state.clientHeight,state.scrollTop+state.clientHeight-120);
    }
    throw new Error('Dialog section coverage exceeded bounded20 real viewport frames');
  }catch(error){primaryError=error;throw error;}finally{
    let cleanupError;
    try{
      await dialog.evaluate((e,prior)=>e.scrollTo(prior.left,prior.top),before);await page.evaluate(prior=>window.scrollTo(prior.windowX,prior.windowY),before);await page.waitForFunction(prior=>{const e=document.querySelector('dialog.oe-detail[open]');return e&&e.scrollTop===prior.top&&e.scrollLeft===prior.left&&scrollX===prior.windowX&&scrollY===prior.windowY;},before);
      const restored=await dialog.evaluate(e=>({top:e.scrollTop,left:e.scrollLeft,windowX:scrollX,windowY:scrollY}));
      assert.equal(restored.top,before.top);assert.equal(restored.left,before.left);assert.equal(restored.windowX,before.windowX);assert.equal(restored.windowY,before.windowY);assert(await page.evaluate(e=>document.activeElement===e,focused));
      log('real-dialog-section-restored',{name,restored});
    }catch(error){cleanupError=error;log('dialog-section-cleanup-error',{name,message:error.message,primaryError:primaryError?.message??null});}
    try{await focused.dispose();}catch(error){cleanupError??=error;log('dialog-section-handle-error',{name,message:error.message,primaryError:primaryError?.message??null});}
    if(cleanupError&&!primaryError)throw cleanupError;
  }
}

const surface=process.argv[2],mode=process.argv[3];assert(['browse','teen'].includes(surface));assert(['light','dark'].includes(mode));
const route=surface==='browse'?'/opportunities/':'/high-school/activities/';
async function actualListReady(page){
  await page.goto(BASE+route);
  // Real UI switch unmounts the default map; no CSS hiding or forced app state.
  const list=page.locator('.oe-view-toggle button').first();await list.waitFor();await list.click();
  await page.waitForFunction(()=>document.querySelector('.oe-view-toggle button')?.getAttribute('aria-pressed')==='true');
  // Observed aria-pressed change proves the actual hydrated handler ran.
  await page.waitForFunction(()=>!document.querySelector('.oe-map-shell'));
  log('early-list-unmounted',{surface,mode,libraryStatus:await page.locator('.oe-explorer').getAttribute('data-library-status')});
  await page.locator('.oe-explorer[data-library-status=ready]').waitFor({timeout:30000});await page.evaluate(()=>document.fonts.ready);await page.waitForFunction(()=>[...document.images].every(i=>i.complete&&i.naturalWidth>0));await theme(page,mode);await filters(page,false);await idleResults(page);
}
async function footerReachable(page,name){
 const prior=await page.evaluate(()=>({x:scrollX,y:scrollY})),focus=await page.evaluateHandle(()=>document.activeElement);
 try{const links=page.locator('.legal-footer a');assert((await links.count())>0);
  for(let i=0;i<await links.count();i++){const link=links.nth(i);await link.scrollIntoViewIfNeeded();const r=await link.evaluate(e=>{const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,uncovered:!!hit&&(hit===e||e.contains(hit))};});assert(r.left>=-2&&r.right<=r.width+2&&r.top>=-2&&r.bottom<=r.height+2&&r.uncovered,JSON.stringify(r));}
  await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));const last=await page.locator('.legal-footer>p').boundingBox();assert(last&&last.y>=-2&&last.y+last.height<=await page.evaluate(()=>innerHeight)+2,'Final footer content must be reachable');
  const target=path.join(CAPTURE,name+'.png');await page.screenshot({path:target,fullPage:false});const png=fs.readFileSync(target);log('footer-reachable',{name,sourceCommit:COMMIT,path:target,sha256:digest(png),width:png.readUInt32BE(16),height:png.readUInt32BE(20)});
 }finally{await page.evaluate(p=>window.scrollTo(p.x,p.y),prior);assert(await page.evaluate(e=>document.activeElement===e,focus));await focus.dispose();}
}
async function main(){
  assert(process.env.GTA_QA_BROWSER);assert(CAPTURE);browser=await chromium.launch({executablePath:process.env.GTA_QA_BROWSER,headless:true,args:['--disable-crash-reporter']});
  const context=await fresh({colorScheme:'light'}),page=await context.newPage();activePage=page;
  await test(`${surface}-${mode} immutable preview`,async()=>{const r=await context.request.get(BASE+'/');assert(r.ok());assert(r.headers()['x-robots-tag']?.toLowerCase().includes('noindex'));const m=await(await context.request.get(BASE+'/hosting-release.json')).json();assert.equal(m.sourceCommit,COMMIT);assert.equal(m.nativeFeedSha256,NATIVE);});
  await test(`${surface}-${mode} actual list matrix and clear gap`,async()=>{
    await actualListReady(page);
    for(const width of [320,390,768,1440]){
      await page.setViewportSize({width,height:1000});await filters(page,false);const label=`${surface}-${width}-${mode}`;
      if(width===320)await rangeClampRegression(page);
      const result=await geometry(page,label);assert.equal(result.checkboxCount,8);assert.equal(await page.locator('.oe-map-shell').count(),0);
      const gap=await page.locator('.oe-clear-support').evaluate(e=>({clearBottom:e.getBoundingClientRect().bottom,nextTop:e.nextElementSibling?.getBoundingClientRect().top,margin:getComputedStyle(e).marginBlockEnd}));
      log('clear-support-gap',{label,...gap});assert(gap.nextTop-gap.clearBottom>=19.5,'Clear support and following Category group retain20px gap');
      await capture(page,label);if(width<=390){await elementCapture(page,'.site-header',label+'-header');await viewportSectionCapture(page,'.scoped-saved-filters',label+'-presets');await viewportSectionCapture(page,'.accessibility-filter',label+'-support');await viewportSectionCapture(page,'.oe-filters',label+'-filter-panel');}
      if(width===320||width===1440)await axe(page,label);
    }
  });
  await test(`${surface}-${mode} computed font200 list reflow`,async()=>{
    for(const width of [320,390]){await page.setViewportSize({width,height:844});await actualListReady(page);const enlarged=await enlargeFonts(page);log('computed-font200',{surface,mode,width,...enlarged});assert(enlarged.samples.length);for(const row of enlarged.samples)assert(Math.abs(row.after/row.before-2)<0.01,JSON.stringify(row));const label=`${surface}-${width}-${mode}-font200`;await geometry(page,label);await capture(page,label);await viewportSectionCapture(page,'.scoped-saved-filters',label+'-presets');await viewportSectionCapture(page,'.accessibility-filter',label+'-support');}
  });
  await test(`${surface}-${mode} real support and scoped preset interactions`,async()=>{
    await page.setViewportSize({width:390,height:844});await actualListReady(page);
    const checks=page.locator('.accessibility-filter input[type=checkbox]');assert.equal(await checks.count(),8);for(let i=0;i<8;i++)assert.equal(await checks.nth(i).isChecked(),false);
    const resultCount=async()=>Number((await page.locator('.oe-result-toolbar > p strong').innerText()).replace(/\D/g,''));
    await checks.nth(3).check();await idleResults(page);assert.equal(await resultCount(),0,'Actual request-only ASL policy cannot match with request support off');
    await checks.last().check();await idleResults(page);const onCount=await resultCount();assert(onCount>0,'Actual ASL request policy matches only after opt-in');await privacy(page);
    await page.locator('.oe-card h3 button').first().click();const proof=page.locator('.accessibility-details');await proof.waitFor();const proofText=await proof.innerText();for(const fact of ['ASL/LSQ/Deaf interpretation','Request and confirmation needed','Provider request policy — not a guaranteed event service','at least two weeks','three business days','ten business days'])assert(proofText.includes(fact),fact);
    const source='https://tpl.ca/accessibility/accessibility-supports/programs-and-events/';const links=await proof.locator('a').evaluateAll(es=>es.map(e=>e.href));assert(links.includes(source));await dialogViewportSectionCapture(page,'.accessibility-details',`${surface}-${mode}-actual-asl-policy-conditions`);await page.getByRole('button',{name:'Close opportunity details',exact:true}).click();log('actual-request-support-semantics',{surface,mode,offCount:0,onCount,source,conditionsVerified:true});
    const communityChoice=page.locator('.oe-community-filters input[type=checkbox]').first();await communityChoice.check();await idleResults(page);
    const name='Saved support '+('探究 '.repeat(22));const preset=await savePreset(page,name);assert.equal(preset.scope,surface==='browse'?'browse':'teen-activities');assert.equal(preset.criteria.filters.blackFocused,true,'Existing community selection is saved exactly');
    await page.getByRole('button',{name:'Clear support filters',exact:true}).click();await idleResults(page);assert.equal(await checks.nth(3).isChecked(),false);assert.equal(await checks.last().isChecked(),false);
    await communityChoice.uncheck();await idleResults(page);
    // Select via the one actual picker; stored support criteria must restore locally.
    const picker=page.getByLabel('Choose a saved filter',{exact:true});await picker.selectOption('');await picker.selectOption(preset.id);await idleResults(page);assert(await checks.nth(3).isChecked());assert(await checks.last().isChecked());assert(await communityChoice.isChecked(),'Choosing the saved filter restores community focus');await privacy(page);
    await geometry(page,`${surface}-${mode}-restored-long-preset`);await viewportSectionCapture(page,'.scoped-saved-filters',`${surface}-${mode}-restored-long-preset`);
    await checks.last().uncheck();await page.getByRole('button',{name:'Update filter',exact:true}).click();await page.getByText('Filter saved.',{exact:true}).waitFor();const updated=JSON.parse(await archive(page)).presets.find(p=>p.id===preset.id);assert.equal(updated.revision,preset.revision+1);assert.equal(updated.criteria.support.includeOnRequest,false);assert.deepEqual(updated.criteria.support.categories,['sign-language']);
    await checks.last().check();await picker.selectOption('');await picker.selectOption(preset.id);await idleResults(page);assert(await checks.nth(3).isChecked());assert.equal(await checks.last().isChecked(),false);assert.equal(await resultCount(),0);await privacy(page);log('explicit-update-persisted',{id:preset.id,beforeRevision:preset.revision,afterRevision:updated.revision,changedOnRequestPersisted:true,reselectedViaActualPicker:true});
    await picker.focus();await page.keyboard.press('Tab');assert(await page.getByLabel('Filter name',{exact:true}).evaluate(e=>e===document.activeElement));const outline=await page.getByLabel('Filter name',{exact:true}).evaluate(e=>({width:parseFloat(getComputedStyle(e).outlineWidth),style:getComputedStyle(e).outlineStyle}));assert(outline.width>=2&&outline.style!=='none');await viewportSectionCapture(page,'.scoped-saved-filters',`${surface}-${mode}-keyboard-focus`);
    await page.getByRole('button',{name:'Delete filter',exact:true}).click();await page.getByText('Saved filter removed. Your current choices remain.',{exact:true}).waitFor();assert.equal(await picker.inputValue(),'');assert(!JSON.parse(await archive(page)).presets.some(p=>p.id===preset.id),'Delete must be committed to the actual archive');await privacy(page);
  });
  await test(`${surface}-${mode} actual RTL filter reflow`,async()=>{
    await page.setViewportSize({width:320,height:844});await actualListReady(page);
    const community=page.locator('.oe-community-filters');assert(await community.isVisible());
    assert.equal(await community.locator('input[type=checkbox]').count(),3);
    assert.equal(await community.evaluate(e=>!!e.closest('details')),false,'Community focus is directly visible, outside More filters');
    assert(await community.evaluate(e=>e.getBoundingClientRect().top<document.querySelector('.scoped-saved-filters').getBoundingClientRect().top),'Community focus appears before saved filters and support');
    await page.locator('.language-tool select').selectOption('ar');await page.waitForFunction(()=>document.documentElement.lang==='ar'&&document.documentElement.dir==='rtl');await idleResults(page);
    await geometry(page,`${surface}-${mode}-320-rtl`);await capture(page,`${surface}-${mode}-320-rtl`);await viewportSectionCapture(page,'.oe-community-filters',`${surface}-${mode}-320-rtl-community`);
    const enlarged=await enlargeFonts(page);for(const row of enlarged.samples)assert(Math.abs(row.after/row.before-2)<0.01);
    await geometry(page,`${surface}-${mode}-320-rtl-font200`);await capture(page,`${surface}-${mode}-320-rtl-font200`);await viewportSectionCapture(page,'.oe-filters',`${surface}-${mode}-320-rtl-font200-filters`);await axe(page,`${surface}-${mode}-320-rtl-font200`);
    await page.locator('.language-tool select').selectOption('en');await page.waitForFunction(()=>document.documentElement.lang==='en');
  });
  await footerReachable(page,`${surface}-${mode}-footer-real`);
  const final=await(await context.request.get(BASE+'/hosting-release.json')).json();assert.equal(final.sourceCommit,COMMIT);assert.equal(final.nativeFeedSha256,NATIVE);assert.deepEqual(globalPageErrors,[]);fs.writeFileSync(path.join(CAPTURE,'mandatory-visual-reviews.json'),JSON.stringify({sourceCommit:COMMIT,surface,mode,visualAcceptance:false,pendingVisualReviews},null,2));log('C-SCENE-COMPLETE',{surface,mode,passedCases:passed.length,sourceCommit:COMMIT,humanVisualReviewComplete:false,visualAcceptance:false,mapCoverageClaim:false});await context.close();
}
main().catch(async error=>{log('FIRST-FAILURE',{surface,mode,message:error.message,stack:error.stack,passedCases:passed});if(activePage&&!activePage.isClosed()){for(const fullPage of [false,true]){try{const name=fullPage?'FAILURE-fullpage':'FAILURE-viewport',target=path.join(CAPTURE,name+'.png');await activePage.screenshot({path:target,fullPage});const png=fs.readFileSync(target);log('failure-capture',{name,path:target,sha256:digest(png),pixelWidth:png.readUInt32BE(16),pixelHeight:png.readUInt32BE(20)});}catch(e){log('failure-capture-error',{message:e.message});}}}process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();});
