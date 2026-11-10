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
  await page.evaluate(async()=>{const visibleFinite=document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity && a.effect?.target instanceof Element && a.effect.target.checkVisibility({visibilityProperty:true,contentVisibilityAuto:true}));let timer;try{await Promise.race([Promise.allSettled(visibleFinite.map(a=>a.finished)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Rendered capture animation did not settle within3000ms')),3000);})]);}finally{clearTimeout(timer);}await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
  const state=()=>page.evaluate(()=>{const e=document.querySelector('.skip-link'),r=e?.getBoundingClientRect(),s=e?getComputedStyle(e):null;return {activeElement:{tag:document.activeElement?.tagName,className:document.activeElement?.getAttribute('class')},scrollX,scrollY,skipLink:e?{focused:e.matches(':focus'),top:s.top,position:s.position,visibility:s.visibility,rect:{x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom}}:null};});
  const before=await state(),focused=await page.evaluateHandle(()=>document.activeElement);
  let primaryError;
  try {
    await page.evaluate(()=>window.scrollTo(0,0));await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const atCapture=await state();log('capture-state',{name,before,atCapture,focusIntentionallyUnchanged:true});
    assert(await page.evaluate(e=>document.activeElement===e,focused),'Capture must preserve original focus');
    const viewportTarget=path.join(CAPTURE,name+'-actual-viewport.png');await page.screenshot({path:viewportTarget,fullPage:false});const viewportPng=await pngMetadata(viewportTarget);const actualViewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight,x:scrollX,y:scrollY}));assert.equal(viewportPng.pixelWidth,actualViewport.width);assert.equal(viewportPng.pixelHeight,actualViewport.height);log('actual-viewport-capture',{name,path:viewportTarget,sha256:viewportPng.sha256,sourceCommit:COMMIT,...actualViewport});
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
async function pngMetadata(file){
  const header=Buffer.alloc(24),fd=fs.openSync(file,'r');try{assert.equal(fs.readSync(fd,header,0,24,0),24);}finally{fs.closeSync(fd);}
  const hash=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file,{highWaterMark:65536}))hash.update(chunk);
  return {sha256:hash.digest('hex'),pixelWidth:header.readUInt32BE(16),pixelHeight:header.readUInt32BE(20),bytes:fs.statSync(file).size};
}
function browserOwnedPids(){
  const rows=[];for(const entry of fs.readdirSync('/proc')){if(!/^\d+$/.test(entry))continue;try{const stat=fs.readFileSync('/proc/'+entry+'/stat','utf8');const rest=stat.slice(stat.lastIndexOf(')')+2).split(' ');let command='';try{command=fs.readFileSync('/proc/'+entry+'/cmdline','utf8');}catch{}rows.push({pid:Number(entry),ppid:Number(rest[1]),command});}catch{}}
  const owned=new Set([process.pid]);for(let i=0;i<32;i++){const prior=owned.size;for(const row of rows)if(owned.has(row.ppid)||(process.env.TMPDIR&&row.command.includes(process.env.TMPDIR)))owned.add(row.pid);if(prior===owned.size)break;}
  owned.delete(process.pid);return [...owned];
}

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
 // Real catalog descriptions may be short; the controlled real-DOM positive case below always exercises the classifier.
 const scratch=await page.context().newPage();try{
  await scratch.setContent('<style>p{position:relative;width:240px;height:70px;font:15px/25.5px Arial}#collision span{position:absolute;left:0;top:0;width:200px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}#plain{height:auto;display:block;overflow:visible}#clampPositive{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;height:auto}</style><p id="collision"><span id="a">Actual overlap</span><span id="b">Actual overlap</span></p><p id="plain">A long description wraps normally over several lines without a clamp. A long description wraps normally over several lines without a clamp.</p><p id="clampPositive">A long single text node description wraps and is deliberately ellipsized after its third line. A long single text node description wraps and is deliberately ellipsized after its third line. A long single text node description wraps and is deliberately ellipsized after its third line.</p>');
  const positive=await scratch.locator('#clampPositive').evaluate(collect);assert(positive.some((a,i)=>positive.slice(i+1).some(b=>clampedRangeDuplicate(a,b))),'Controlled real DOM clamped text must exercise the positive classification');
  const bad=await scratch.locator('#collision').evaluate(collect);assert.equal(bad.length,2);assert(Math.min(bad[0].right,bad[1].right)-Math.max(bad[0].left,bad[1].left)>2);assert(Math.min(bad[0].bottom,bad[1].bottom)-Math.max(bad[0].top,bad[1].top)>2);assert(!clampedRangeDuplicate(bad[0],bad[1]),'Genuinely overlapping separate DOM text nodes remain hard failures');
  const plain=await scratch.locator('#plain').evaluate(collect);for(let i=0;i<plain.length;i++)for(let j=i+1;j<plain.length;j++)assert(!clampedRangeDuplicate(plain[i],plain[j]));
  log('range-clamp-regression',{actualSourceDuplicatePairs:actualPairs,controlledClampedSingleNodePromoted:true,actualPaintedOverlapTwoNodesNotPromoted:true,unclampedTextNotPromoted:true,productDOMUnmodified:true});
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
    const filterGroupLayout=[];
    for(const panel of document.querySelectorAll('.oe-filters'))if(visible(panel)){
      const groups=['.oe-community-filters','.scoped-saved-filters','.accessibility-filter','.oe-clear-support'].map(selector=>({selector,element:panel.querySelector(selector)})).filter(row=>row.element&&visible(row.element)).map(row=>({selector:row.selector,...box(row.element)}));
      filterGroupLayout.push({viewport:innerWidth,groups});
      if(innerWidth<=820)for(let i=1;i<groups.length;i++)if(groups[i].y<groups[i-1].bottom-2)issues.push({kind:'related-filter-groups-not-vertically-ordered',previous:groups[i-1],next:groups[i]});
      const clear=panel.querySelector('.oe-clear-support');if(clear&&visible(clear)){
        const range=document.createRange();range.selectNodeContents(clear);const rects=[...range.getClientRects()].filter(r=>r.width&&r.height),style=getComputedStyle(clear),r=box(clear);
        if(rects.length){const inkHeight=Math.max(...rects.map(r=>r.bottom))-Math.min(...rects.map(r=>r.top));const paddingAndBorder=['paddingTop','paddingBottom','borderTopWidth','borderBottomWidth'].reduce((sum,k)=>sum+(parseFloat(style[k])||0),0);const lineLeading=Math.max(0,(parseFloat(style.lineHeight)||0)-Math.max(...rects.map(r=>r.height)));const intrinsicCeiling=Math.max(parseFloat(style.minHeight)||0,inkHeight+lineLeading+paddingAndBorder)+4;
          if(r.height>intrinsicCeiling)issues.push({kind:'clear-support-button-stretched-beyond-own-label',...r,intrinsicCeiling,inkHeight,lineLeading,paddingAndBorder});
        }
      }
    }
    const checkbox = [...document.querySelectorAll('.accessibility-filter .accessibility-check')].filter(visible).map(label => ({ label: label.textContent.trim(), labelBox: box(label), inputBox: box(label.querySelector('input')) }));
    for (const row of checkbox) if (row.labelBox.height < 47.5 || Math.abs(row.inputBox.width-20) > 1 || Math.abs(row.inputBox.height-20) > 1) issues.push({ kind: 'checkbox-target-size', ...row });
    return { viewport: innerWidth, issues, metricWarnings, filterGroupLayout, checkboxCount: checkbox.length, pathwayBoxes: [...document.querySelectorAll('.hs-pathways li')].filter(visible).map(box) };
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
    const activeFontTransitionsBeforeSettle=document.getAnimations().filter(a=>a.effect?.getKeyframes().some(f=>typeof f.fontSize==='string')).length;
    const relevantAnimations=document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity && a.effect?.target instanceof Element && a.effect.target.checkVisibility({visibilityProperty:true,contentVisibilityAuto:true}));
    let settleTimer;try{await Promise.race([Promise.allSettled(relevantAnimations.map(a=>a.finished)),new Promise((_,reject)=>{settleTimer=setTimeout(()=>reject(new Error('Rendered finite animation did not settle within3000ms; visibility='+document.visibilityState+'; hasFocus='+document.hasFocus()+'; '+JSON.stringify(relevantAnimations.filter(a=>a.playState!=='finished').map(a=>({type:a.constructor.name,state:a.playState,properties:a.effect?.getKeyframes().map(f=>Object.keys(f)).flat()})).slice(0,5)))),3000);})]);}finally{clearTimeout(settleTimer);} 
    await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const samples = rows.filter(({e}) => e.getClientRects().length > 0 && e.checkVisibility({visibilityProperty:true,contentVisibilityAuto:true})).map(({e,before,beforeState}) => ({ element: e.tagName, className:e.className, selector:beforeState.selector, before, after: parseFloat(getComputedStyle(e).fontSize) }));
    return { count: rows.length, samples, fontReadiness:document.fonts.status, actualTwoAnimationFramesWaited:true,activeFontTransitionsBeforeSettle,finiteAnimationsSettledBeforeMeasurement:true,documentVisibilityAtMeasurement:document.visibilityState,documentHasFocusAtMeasurement:document.hasFocus() };
  });
}
async function savePreset(page, name) {
  const input=page.getByLabel('Filter name', { exact: true });await input.fill(name);
  const savedName=(await input.inputValue()).trim();assert(savedName,'Saved filter name must be nonempty');
  await page.getByRole('button', { name: 'Save filter', exact: true }).click();
  await page.getByText('Filter saved.', { exact: true }).waitFor();
  const parsed = JSON.parse(await archive(page));const preset=parsed.presets.find(p => p.name === savedName);assert(preset,'Saved filter must exist under the actual normalized input name');return preset;
}


async function theme(page,value){
  const current=await page.locator('html').getAttribute('data-theme');
  if(current!==value)await page.getByRole('button',{name:value==='dark'?'Switch to dark theme':'Switch to light theme',exact:true}).click();
  await page.waitForFunction(value=>document.documentElement.dataset.theme===value,value);
}
async function elementCapture(page,selector,name){const locator=page.locator(selector).first();if(!await locator.isVisible())return;await page.evaluate(()=>document.fonts.ready);const target=path.join(CAPTURE,name+'.png');log('element-capture-state',{name,selector,...await page.evaluate(()=>({activeElement:{tag:document.activeElement?.tagName,className:document.activeElement?.getAttribute('class')},scrollX,scrollY}))});await locator.screenshot({path:target});const png=await pngMetadata(target);log('element-capture',{selector,name,path:target,sha256:png.sha256,pixelWidth:png.pixelWidth,pixelHeight:png.pixelHeight,sourceCommit:COMMIT});}
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
    for(let index=0;index<40;index++){
      await page.evaluate(y=>window.scrollTo(0,y),requested);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const state=await page.evaluate(()=>{const e=document.querySelector('.skip-link'),r=e?.getBoundingClientRect();return {x:scrollX,y:scrollY,width:innerWidth,height:innerHeight,activeElement:{tag:document.activeElement?.tagName,className:document.activeElement?.getAttribute('class')},skipLink:e?{focused:e.matches(':focus'),top:getComputedStyle(e).top,rect:{top:r.top,bottom:r.bottom,height:r.height}}:null};});
      assert.equal(state.width,before.width);assert.equal(state.height,before.height);assert(await page.evaluate(e=>document.activeElement===e,focused),'Real viewport capture preserves exact focus');assert(state.y>lastY,'Scroll frames must advance');lastY=state.y;
      const target=path.join(CAPTURE,`${name}-viewport-${index+1}.png`);await page.screenshot({path:target,fullPage:false});const png=await pngMetadata(target);assert.equal(png.pixelWidth,before.width);assert.equal(png.pixelHeight,before.height);
      const frame={index:index+1,path:target,sha256:png.sha256,pixelWidth:png.pixelWidth,pixelHeight:png.pixelHeight,state};frames.push(frame);log('real-viewport-section-frame',{name,selector,sourceCommit:COMMIT,...frame});
      if(state.y+state.height>=Math.min(section.documentHeight,section.bottom+24)){log('real-viewport-section-covered',{name,selector,section,frames:frames.length,overlapPixels:120,unchangedViewport:true,noStitchingOrEditing:true});return;}
      requested=Math.min(section.documentHeight-state.height,state.y+state.height-120);
    }
    throw new Error('Section coverage exceeded bounded40 real viewport frames');
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
      const target=path.join(CAPTURE,name+'-dialog-viewport-'+(index+1)+'.png');await page.screenshot({path:target,fullPage:false});const png=await pngMetadata(target);assert.equal(png.pixelWidth,before.width);assert.equal(png.pixelHeight,before.height);
      log('real-dialog-section-frame',{name,selector,sourceCommit:COMMIT,index:index+1,path:target,sha256:png.sha256,pixelWidth:png.pixelWidth,pixelHeight:png.pixelHeight,state});
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
  const target=path.join(CAPTURE,name+'.png');await page.screenshot({path:target,fullPage:false});const png=await pngMetadata(target);log('footer-reachable',{name,sourceCommit:COMMIT,path:target,sha256:png.sha256,width:png.pixelWidth,height:png.pixelHeight});
 }finally{await page.evaluate(p=>window.scrollTo(p.x,p.y),prior);assert(await page.evaluate(e=>document.activeElement===e,focus));await focus.dispose();}
}
async function main(){
  assert(process.env.GTA_QA_BROWSER);assert(CAPTURE);
  const width=Number(process.argv[4]),scale=Number(process.argv[5]);assert([320,390,768,1440].includes(width));assert([100,200].includes(scale));
  browser=await chromium.launch({executablePath:process.env.GTA_QA_BROWSER,headless:true,args:['--disable-crash-reporter']});
  const context=await fresh({viewport:{width,height:844},colorScheme:'light'}),page=await context.newPage();activePage=page;
  await test(`${surface}-${mode} immutable preview`,async()=>{const r=await context.request.get(BASE+'/');assert(r.ok());assert(r.headers()['x-robots-tag']?.toLowerCase().includes('noindex'));const m=await(await context.request.get(BASE+'/hosting-release.json')).json();assert.equal(m.sourceCommit,COMMIT);assert.equal(m.nativeFeedSha256,NATIVE);});
  const label=`${surface}-${mode}-${width}-font${scale}`;
  await test(label+' real layout',async()=>{
    await actualListReady(page);await page.locator('.oe-card h3').first().waitFor({timeout:30000});
    if(scale===200){const rows=await enlargeFonts(page);assert(rows.samples.length>0);for(const row of rows.samples)assert(Math.abs(row.after/row.before-2)<0.01);const titles=rows.samples.filter(row=>row.selector.includes('article')&&row.element==='H3'),summaries=rows.samples.filter(row=>row.selector.includes('article')&&row.element==='P'&&row.className.split(/\s+/).includes('oe-summary'));assert(titles.length&&summaries.length,'Real current card text must be measured');log('layout-font200',{count:rows.samples.length,titles:titles.length,summaries:summaries.length});}
    const result=await geometry(page,label);assert.equal(result.checkboxCount,8);assert.equal(await page.locator('.oe-map-shell').count(),0);
    const gap=await page.locator('.oe-clear-support').evaluate(e=>({clearBottom:e.getBoundingClientRect().bottom,nextTop:e.nextElementSibling?.getBoundingClientRect().top}));assert(gap.nextTop-gap.clearBottom>=19.5,'Clear support retains its gap');
    await capture(page,label);await viewportSectionCapture(page,'.oe-filters',label+'-filters');await viewportSectionCapture(page,'.oe-card-grid',label+'-cards');await viewportSectionCapture(page,'.oe-directory-end',label+'-directory');
    if(width===320||width===1440)await axe(page,label);
  });
  await footerReachable(page,label+'-footer');const final=await(await context.request.get(BASE+'/hosting-release.json')).json();assert.equal(final.sourceCommit,COMMIT);assert.equal(final.nativeFeedSha256,NATIVE);assert.deepEqual(globalPageErrors,[]);fs.writeFileSync(path.join(CAPTURE,'mandatory-visual-reviews.json'),JSON.stringify({sourceCommit:COMMIT,surface,mode,visualAcceptance:false,pendingVisualReviews},null,2));log('LAYOUT-CASE-COMPLETE',{surface,mode,width,scale,passedCases:passed.length,sourceCommit:COMMIT,humanVisualReviewComplete:false,visualAcceptance:false});await context.close();
}
main().catch(async error=>{log('FIRST-FAILURE',{surface,mode,message:error.message,stack:error.stack,passedCases:passed});if(activePage&&!activePage.isClosed()){for(const fullPage of [false]){try{const name=fullPage?'FAILURE-fullpage':'FAILURE-viewport',target=path.join(CAPTURE,name+'.png');await activePage.screenshot({path:target,fullPage});const png=await pngMetadata(target);log('failure-capture',{name,path:target,sha256:png.sha256,pixelWidth:png.pixelWidth,pixelHeight:png.pixelHeight});}catch(e){log('failure-capture-error',{message:e.message});}}}process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();});
