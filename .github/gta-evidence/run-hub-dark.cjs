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
const BASE = 'https://review-accessibility.gta-free-stem.pages.dev';
const COMMIT = '9f83e87e4447b805373ff9f7f206adb737e5c413';
const NATIVE = '07c1eafc85931f9a44f926242f8377680c569191d04928223780e861e70d101e';
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
    const snapshot=e=>({selector:selectorFor(e),text:e.textContent?.trim().slice(0,100),connected:e.isConnected,fontSize:getComputedStyle(e).fontSize,font:getComputedStyle(e).font,inlineFontSize:e.style.getPropertyValue('font-size'),inlinePriority:e.style.getPropertyPriority('font-size'),inlineStyle:e.getAttribute('style')});
    const rows = [...document.querySelectorAll('h1,h2,h3,h4,p,button,input,select,textarea,label,legend,summary,a,li,dt,dd,span')]
      .filter(e => !e.closest('svg,.gta-artwork,.sr-only,.oe-sr-only')).map(e => ({ e, before: parseFloat(getComputedStyle(e).fontSize), beforeState:snapshot(e) }));
    for (const { e, before } of rows) e.style.fontSize = before * 2 + 'px';
    const immediate=rows.map(({e})=>snapshot(e));
    await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const diagnostics=rows.map(({e,before,beforeState},index)=>({before,beforeState,immediate:immediate[index],settled:snapshot(e)}));
    const samples = rows.filter(({e}) => e.matches('h1,.accessibility-check span,.scoped-saved-filters input')).map(({e,before}) => ({ element: e.tagName, before, after: parseFloat(getComputedStyle(e).fontSize) }));
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
const surface=process.argv[2],mode=process.argv[3];
assert(['home','hub'].includes(surface));assert(['light','dark'].includes(mode));
const route=surface==='home'?'/':'/high-school/';
const longName=[...('探究 '.repeat(28))].slice(0,80).join('');
const oldFilters={query:'',region:'All',city:'',category:'All',age:'16',language:'all',distanceKm:25,postalCode:'',nearMe:false,blackFocused:false,girlsFocused:false,indigenousFocused:false,volunteerHours:false,coop:false,mentorship:false,leadership:false};
const legacy=JSON.stringify({version:1,filters:[{id:'qa-home-readonly',name:longName,highSchool:false,filters:oldFilters,createdAt:'2026-10-30T00:00:00.000Z',updatedAt:'2026-10-30T00:00:00.000Z'}]});
async function elementCapture(page,selector,name){const locator=page.locator(selector).first();if(!await locator.isVisible())return;await page.evaluate(()=>document.fonts.ready);const target=path.join(CAPTURE,name+'.png');log('element-capture-state',{name,selector,...await page.evaluate(()=>({activeElement:{tag:document.activeElement?.tagName,className:document.activeElement?.getAttribute('class')},scrollX,scrollY}))});await locator.screenshot({path:target});const png=fs.readFileSync(target);log('element-capture',{selector,name,path:target,sha256:digest(png),pixelWidth:png.readUInt32BE(16),pixelHeight:png.readUInt32BE(20),sourceCommit:COMMIT});}
async function actualReady(page){
  await ready(page,route);await theme(page,mode);assert.equal(await page.locator('.oe-map-shell').count(),0,'B must use actual no-Map routes');
  if(surface==='home')await page.getByRole('link',{name:longName,exact:true}).waitFor();
  else {await page.getByRole('button',{name:'Reading Buddies teen volunteer',exact:true}).waitFor();await filters(page,true);}
}
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
    log('axe',{label,violations:result.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.length}))});assert.equal(result.violations.length,0,label);
  } finally {await previous.dispose();}
}
async function main(){
  assert(process.env.GTA_QA_BROWSER);assert(CAPTURE,'B requires actual local captures');
  browser=await chromium.launch({executablePath:process.env.GTA_QA_BROWSER,headless:true,args:['--disable-crash-reporter']});
  const context=await fresh({colorScheme:'light'});const page=await context.newPage();activePage=page;
  if(surface==='home')await context.addInitScript(({BASE,LEGACY,legacy})=>{if(location.origin!==BASE)return;if(localStorage.getItem(LEGACY)===null)localStorage.setItem(LEGACY,legacy);},{BASE,LEGACY,legacy});
  await test(`${surface}-${mode} immutable source and noindex`,async()=>{const response=await context.request.get(BASE+'/');assert(response.ok());assert(response.headers()['x-robots-tag']?.toLowerCase().includes('noindex'));const manifest=await(await context.request.get(BASE+'/hosting-release.json')).json();assert.equal(manifest.sourceCommit,COMMIT);assert.equal(manifest.nativeFeedSha256,NATIVE);return{sourceCommit:COMMIT,nativeSHA256:NATIVE};});
  await test(`${surface}-${mode} four actual viewport layouts`,async()=>{
    await actualReady(page);
    for(const width of [320,390,768,1440]){
      await page.setViewportSize({width,height:1000});if(surface==='hub')await filters(page,true);
      const result=await geometry(page,`${surface}-${width}-${mode}`);
      if(surface==='hub'){assert.equal(result.checkboxCount,8);assert.equal(result.pathwayBoxes.length,4);assert.equal(new Set(result.pathwayBoxes.map(b=>Math.round(b.x))).size,width>=1160?4:width>680?2:1);const heights=result.pathwayBoxes.map(b=>b.height);assert(Math.max(...heights)-Math.min(...heights)<=2);}
      await capture(page,`${surface}-${width}-${mode}`);if(width<=390){await elementCapture(page,'.site-header',`${surface}-${width}-${mode}-header`);if(surface==='hub'){await elementCapture(page,'.hs-pathways',`hub-${width}-${mode}-pathways`);await elementCapture(page,'.scoped-saved-filters',`hub-${width}-${mode}-presets`);await elementCapture(page,'.accessibility-filter',`hub-${width}-${mode}-support`);}else await elementCapture(page,'.home-saved-filters',`home-${width}-${mode}-long-saved-link`);}if(width===320||width===1440)await axe(page,`${surface}-${width}-${mode}`);
    }
    if(surface==='home'){assert.equal(await archive(page),null,'Home must not create/migrate scoped preset storage');assert.equal(await page.evaluate(key=>localStorage.getItem(key),LEGACY),legacy,'Home v1 bytes unchanged');}
    else {await page.getByLabel('Choose a saved filter',{exact:true}).focus();await page.keyboard.press('Tab');assert(await page.getByLabel('Filter name',{exact:true}).evaluate(e=>e===document.activeElement));const outline=await page.getByLabel('Filter name',{exact:true}).evaluate(e=>({width:parseFloat(getComputedStyle(e).outlineWidth),style:getComputedStyle(e).outlineStyle}));assert(outline.width>=2&&outline.style!=='none');}
    await privacy(page);return{actualWidths:[320,390,768,1440],theme:mode,homeLegacyFixture:surface==='home',mapNotMounted:true};
  });
  await test(`${surface}-${mode} actual font200 at320 and390`,async()=>{
    for(const width of [320,390]){await page.setViewportSize({width,height:844});await actualReady(page);const enlarged=await enlargeFonts(page);log('computed-font200',{surface,mode,width,...enlarged});assert(enlarged.samples.length);for(const row of enlarged.samples)assert(Math.abs(row.after/row.before-2)<0.01,JSON.stringify({kind:'font200-ratio-mismatch',...row}));await geometry(page,`${surface}-${width}-${mode}-font200`);if(surface==='hub'){await elementCapture(page,'.hs-result-list h4:has(button:text-is(\"Understand your school community-involvement requirements\"))',`hub-${width}-${mode}-font200-repaired-title`);await elementCapture(page,'.hs-result-list li:has(button:text-is(\"Understand your school community-involvement requirements\"))',`hub-${width}-${mode}-font200-repaired-title-parent`);}await capture(page,`${surface}-${width}-${mode}-font200`);await elementCapture(page,'.site-header',`${surface}-${width}-${mode}-font200-header`);if(surface==='hub')await elementCapture(page,'.accessibility-filter',`hub-${width}-${mode}-font200-support`);else await elementCapture(page,'.home-saved-filters',`home-${width}-${mode}-font200-saved`);}
    return{computedFontSizesDoubled:true,viewportUnchanged:true,nativeBrowserZoomClaim:false};
  });
  if(surface==='hub'){
    await test(`hub-${mode} full actual role facts/forms`,async()=>{
      await page.setViewportSize({width:390,height:844});await actualReady(page);
      const leads=page.locator('.hs-result-group[aria-label="Volunteer roles — costs need confirmation"] .hs-result-list > li');assert.equal(await leads.count(),2);assert.equal(await page.getByRole('heading',{name:'Individual volunteer roles',exact:true}).count(),0,'Unknown-cost leads must not appear as confirmed-free individual roles');
      for(const [key,title,form] of [['reading','Reading Buddies teen volunteer','form-reading-buddies-teen-application'],['math','Math Buddies teen volunteer','form-math-buddies-teen-application']]){
        await page.getByRole('button',{name:title,exact:true}).click();const detail=page.locator('.hs-detail');const text=await detail.innerText();for(const fact of ['grades 9–12','orientation','one application','unconfirmed','not guarantee','ten weekly','one hour','planned commitment is not recorded completed time'])assert(text.toLowerCase().includes(fact.toLowerCase()),fact);assert((await page.getByRole('link',{name:'Review provider application',exact:true}).getAttribute('href')).includes(form));await geometry(page,`role-${key}-390-${mode}`);await capture(page,`role-${key}-390-${mode}`);await page.getByRole('button',{name:'Back to results',exact:true}).click();await page.waitForFunction(title=>document.activeElement?.textContent===title,title);
      }
      return{actualUnknownCostLeads:2,verifiedFreeIndividualRoles:0,distinctForms:true,plannedHoursNotRecorded:true};
    });
    await test(`hub-${mode} keyboard language and real reduced/normal press`,async()=>{
      await page.setViewportSize({width:1440,height:1000});await actualReady(page);const card=page.locator('.hs-pathways button').first();await card.hover();let box=await card.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();assert.equal(await card.evaluate(e=>getComputedStyle(e).transform),'none');await capture(page,`hub-${mode}-reduced-pressed`);await page.mouse.up();
      await page.emulateMedia({reducedMotion:'no-preference'});await card.scrollIntoViewIfNeeded();const before=await card.boundingBox();await card.hover();const after=await card.boundingBox();assert(Math.abs(before.x-after.x)<=1&&Math.abs(before.y-after.y)<=1);await page.mouse.down();await page.waitForFunction(()=>getComputedStyle(document.querySelector('.hs-pathways button')).transform!=='none');await geometry(page,`hub-${mode}-normal-pressed`);await capture(page,`hub-${mode}-normal-pressed`);await page.mouse.up();await page.emulateMedia({reducedMotion:'reduce'});
      await page.setViewportSize({width:390,height:844});await page.locator('.language-tool select').selectOption('fr');await page.getByText('This student content is currently available in English.',{exact:true}).waitFor();assert.equal(await page.locator('.hs-hub').getAttribute('lang'),'en');await geometry(page,`hub-${mode}-french-shell390`);await capture(page,`hub-${mode}-french-shell390`);return{keyboardFocusVisible:true,reducedMotionNoShift:true,normalPressPresent:true,englishContentSemantics:true};
    });
  }
  const final=await(await context.request.get(BASE+'/hosting-release.json')).json();assert.equal(final.sourceCommit,COMMIT);assert.equal(final.nativeFeedSha256,NATIVE);assert.deepEqual(globalPageErrors,[]);fs.writeFileSync(path.join(CAPTURE,'mandatory-visual-reviews.json'),JSON.stringify({sourceCommit:COMMIT,surface,mode,visualAcceptance:false,pendingVisualReviews},null,2));log('B-SCENE-COMPLETE',{surface,mode,sourceCommit:COMMIT,passedCases:passed.length,pendingVisualReviewCount:pendingVisualReviews.length,humanVisualReviewComplete:false,visualAcceptance:false,otherBScenesNotClaimed:true});await context.close();
}
main().catch(async error=>{log('FIRST-FAILURE',{surface,mode,message:error.message,stack:error.stack,passedCases:passed});if(activePage&&!activePage.isClosed()){for(const fullPage of [false,true]){try{const name=fullPage?'FAILURE-fullpage':'FAILURE-viewport';const target=path.join(CAPTURE,name+'.png');await activePage.screenshot({path:target,fullPage});const png=fs.readFileSync(target);log('failure-capture',{name,path:target,sha256:digest(png),pixelWidth:png.readUInt32BE(16),pixelHeight:png.readUInt32BE(20),rawFailureFrame:true});}catch(captureError){log('failure-capture-error',{message:captureError.message});}}}process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();});
