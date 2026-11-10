const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {chromium}=require(process.env.GTA_QA_PLAYWRIGHT_MODULE||'playwright-core');
const AxeBuilder=require(process.env.GTA_QA_AXE_MODULE||'@axe-core/playwright').default;
const BASE=process.env.GTA_QA_BASE_URL,COMMIT=process.env.GTA_QA_SOURCE_COMMIT,NATIVE=process.env.GTA_QA_NATIVE_SHA256;
assert(BASE&&/^https:\/\/[a-z0-9-]+\.gta-free-stem\.pages\.dev$/.test(BASE));assert(/^[a-f0-9]{40}$/.test(COMMIT||''));assert(/^[a-f0-9]{64}$/.test(NATIVE||''));
const route=process.argv[2];assert(['landing','ios'].includes(route));const surface='beta-'+route;let mode='light';
const ROUTE=route==='landing'?'/beta/':'/beta/ios/';
const CAPTURE=path.resolve(process.env.GTA_QA_CAPTURE_DIR);fs.mkdirSync(CAPTURE,{recursive:true});
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');const log=(event,data={})=>console.log(JSON.stringify({event,...data}));
const pendingVisualReviews=[],globalPageErrors=[],passed=[];let browser,activePage;
async function test(name,body){log('case-start',{name});await body();assert.deepEqual(globalPageErrors,[]);passed.push(name);log('case-pass',{name});}
async function fresh(theme,reducedMotion='reduce'){
 const context=await browser.newContext({viewport:{width:390,height:844},colorScheme:theme,reducedMotion});
 await context.addInitScript(({base,theme})=>{if(location.origin===base)localStorage.setItem('gta-stem-opportunities-theme',theme);},{base:BASE,theme});
 await context.route('**/*',r=>new URL(r.request().url()).origin===BASE?r.continue():r.abort('blockedbyclient'));
 context.on('page',p=>{p.on('pageerror',e=>globalPageErrors.push({message:e.message}));p.on('console',e=>{if(e.type()==='error')globalPageErrors.push({message:e.text()});});});return context;
}
async function ready(page){await page.goto(BASE+ROUTE);await page.locator('.beta-page').waitFor();await page.evaluate(()=>document.fonts.ready);await page.waitForFunction(()=>[...document.images].every(i=>i.complete&&i.naturalWidth>0));await page.waitForFunction(theme=>document.documentElement.dataset.theme===theme,mode);}
async function sourceIdentity(context){const r=await context.request.get(BASE+'/');assert(r.ok());assert(r.headers()['x-robots-tag']?.toLowerCase().includes('noindex'));const m=await(await context.request.get(BASE+'/hosting-release.json')).json();assert.equal(m.sourceCommit,COMMIT);assert.equal(m.nativeFeedSha256,NATIVE);}
async function originalViewport(page,name,extra={}){await page.evaluate(()=>document.fonts.ready);await page.waitForFunction(()=>[...document.images].every(i=>i.complete&&i.naturalWidth>0));await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));const target=path.join(CAPTURE,name+'.png');const state=await page.evaluate(()=>({width:innerWidth,height:innerHeight,x:scrollX,y:scrollY,activeTag:document.activeElement?.tagName}));await page.screenshot({path:target,fullPage:false});const png=fs.readFileSync(target);assert.equal(png.readUInt32BE(16),state.width);assert.equal(png.readUInt32BE(20),state.height);log('beta-viewport-frame',{name,path:target,sha256:digest(png),sourceCommit:COMMIT,...state,...extra});}
async function allPageFrames(page,width,fontScale){
 const prior=await page.evaluate(()=>({x:scrollX,y:scrollY,width:innerWidth,height:innerHeight})),focus=await page.evaluateHandle(()=>document.activeElement);let last=-1;
 try{for(let index=0;index<20;index++){
   await page.evaluate(y=>window.scrollTo(0,y),index*(prior.height-120));await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
   const s=await page.evaluate(()=>({y:scrollY,height:innerHeight,width:innerWidth,documentHeight:document.documentElement.scrollHeight}));assert.equal(s.width,prior.width);assert.equal(s.height,prior.height);assert(s.y>last);last=s.y;
   assert(await page.evaluate(e=>document.activeElement===e,focus));await originalViewport(page,`beta-${route}-${width}-${mode}-font${fontScale}-viewport-${index+1}`,{mode,fontScale,index:index+1});
   if(s.y+s.height>=s.documentHeight-1){log('beta-page-covered',{route,mode,width,fontScale,frames:index+1,documentHeight:s.documentHeight,unchangedViewport:true,noScreenshotEditing:true});return;}
 }throw Error('Full beta page did not fit the bounded twenty real viewport frames');}
 finally{await page.evaluate(p=>window.scrollTo(p.x,p.y),prior);assert(await page.evaluate(e=>document.activeElement===e,focus));await focus.dispose();}
}
async function controlsAndFooter(page){
 const controls=page.locator('.beta-action,.beta-back,.beta-header>a,.legal-footer a');
 for(let i=0;i<await controls.count();i++){const e=controls.nth(i);await e.scrollIntoViewIfNeeded();const state=await e.evaluate(e=>{const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight,uncovered:!!hit&&(e===hit||e.contains(hit)),text:e.textContent?.trim()};});assert(state.left>=-2&&state.right<=state.viewportWidth+2,JSON.stringify(state));assert(state.top>=-2&&state.bottom<=state.viewportHeight+2,JSON.stringify(state));assert(state.width>=43.5&&state.height>=43.5,JSON.stringify(state));assert(state.uncovered,JSON.stringify(state));}
 await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));const last=await page.locator('.legal-footer>p').boundingBox();assert(last&&last.y>=-2&&last.y+last.height<=(await page.evaluate(()=>innerHeight))+2,'Final copyright stays reachable at actual document bottom');
 assert.equal(await page.locator('.beta-note').count(),1);assert.equal(await page.locator('a[href^="https://testflight.apple.com/join/"]').count(),0,'Pending dedicated invitation stays disabled');assert.equal(await page.locator('a[href*="play.google.com"]').count(),0);
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
    log('axe',{label,violations:result.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.length}))});assert.equal(result.violations.length,0,label);
  } finally {await previous.dispose();}
}

async function main(){
 assert(process.env.GTA_QA_BROWSER);browser=await chromium.launch({executablePath:process.env.GTA_QA_BROWSER,headless:true,args:['--disable-crash-reporter']});
 const identity=await fresh('light');await test(`${surface} immutable preview`,async()=>{await sourceIdentity(identity);if(route==='ios'){const r=await identity.request.get(BASE+'/beta/iphone-installation-guide.png');assert(r.ok());const bytes=await r.body();assert.equal(digest(bytes),'95cc190cef3d7ae19178daa812a57f13524cc03884c0e782570491ec86a7f3b7');assert.equal(bytes.readUInt32BE(16),1200);assert.equal(bytes.readUInt32BE(20),1500);}});await identity.close();
 for(const theme of ['light','dark']){mode=theme;const context=await fresh(theme),page=await context.newPage();activePage=page;
  for(const [scale,widths] of [[100,[320,390,768,1440]],[200,[320,390]]])for(const width of widths){await test(`${surface} ${theme} ${width} font${scale}`,async()=>{
   await page.setViewportSize({width,height:844});await ready(page);assert.equal(await page.locator('h1').count(),1);
   if(scale===200){const fonts=await enlargeFonts(page);assert(fonts.samples.length);for(const f of fonts.samples)assert(Math.abs(f.after/f.before-2)<0.01);}
   await geometry(page,`beta-${route}-${width}-${theme}-font${scale}`);await controlsAndFooter(page);
   if(width===320||width===1440)await axe(page,`beta-${route}-${width}-${theme}-font${scale}`);
   await allPageFrames(page,width,scale);
  });}
  await sourceIdentity(context);await context.close();
 }
 mode='light';const context=await fresh('light','no-preference'),page=await context.newPage();activePage=page;
 await test(`${surface} pointer keyboard and navigation`,async()=>{
  await page.setViewportSize({width:1440,height:900});await ready(page);const action=page.locator('.beta-action').first();await action.scrollIntoViewIfNeeded();await action.hover();await page.waitForTimeout(250);assert.notEqual(await action.evaluate(e=>getComputedStyle(e).transform),'none');await originalViewport(page,`beta-${route}-hover`);
  const box=await action.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.waitForTimeout(250);await originalViewport(page,`beta-${route}-pressed`);await page.mouse.move(0,0);await page.mouse.up();
  await page.goto(BASE+ROUTE);await page.keyboard.press('Tab');assert(await page.locator('.skip-link').evaluate(e=>document.activeElement===e));await page.keyboard.press('Enter');await page.waitForFunction(()=>document.activeElement?.id==='beta-content');await page.keyboard.press('Tab');assert(await page.evaluate(()=>document.activeElement?.matches('.beta-page main a')));const ring=await page.evaluate(()=>({width:parseFloat(getComputedStyle(document.activeElement).outlineWidth),style:getComputedStyle(document.activeElement).outlineStyle}));assert(ring.width>=2&&ring.style!=='none');await originalViewport(page,`beta-${route}-keyboard-focus`);
  if(route==='landing'){await page.getByRole('link',{name:'How testing works',exact:true}).click();assert.equal(new URL(page.url()).hash,'#how-testing-works');}
  else{assert.equal(await page.getByRole('link',{name:'Get TestFlight',exact:true}).getAttribute('href'),'https://apps.apple.com/us/app/testflight/id899247664');await page.getByRole('link',{name:'About the iPhone beta',exact:true}).click();assert.equal(new URL(page.url()).pathname,'/beta/');}
  await page.emulateMedia({reducedMotion:'reduce'});await page.goto(BASE+ROUTE);const reduced=page.locator('.beta-action').first();await reduced.hover();const durations=await reduced.evaluate(e=>getComputedStyle(e).transitionDuration.split(',').map(s=>parseFloat(s)*(s.trim().endsWith('ms')?0.001:1)));assert(durations.every(n=>n<=0.001),'Reduced-motion removes the bounce');
 });
 await sourceIdentity(context);await context.close();assert.deepEqual(globalPageErrors,[]);log('BETA-SCENE-COMPLETE',{route,sourceCommit:COMMIT,passedCases:passed.length,pendingVisualReviewCount:pendingVisualReviews.length,humanVisualReviewComplete:false,visualAcceptance:false});
}
main().catch(async error=>{log('FIRST-FAILURE',{message:error.message,stack:error.stack,passedCases:passed});if(activePage&&!activePage.isClosed())try{await originalViewport(activePage,`beta-${route}-FAILURE`);}catch{}process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();});
