"""Copy original browser PNGs through a strict allowlist. Never publish raw logs."""
import hashlib,json,os,re,shutil,struct,zlib
from pathlib import Path
HERE=Path(__file__).resolve().parent
SCENES=json.loads((HERE/'scenes.json').read_text());KEY=os.environ['GTA_EVIDENCE_SCENE'];assert KEY in SCENES
SCENE=SCENES[KEY]
TEMP=Path(os.environ['RUNNER_TEMP'])/'gta-remaining-scene-evidence'
OUT=Path(os.environ['RUNNER_TEMP'])/'gta-public-evidence'
assert not OUT.exists();OUT.mkdir();(OUT/'screenshots').mkdir()
receipt=json.loads((TEMP/'resource-private.json').read_text())
assert receipt['releaseConfirmed'] and receipt['remainingOwnedPids']==[],'Cleanup proof required before publishing evidence'
assert receipt['scope']==KEY
assert receipt['sourceCommit']==os.environ['GTA_QA_SOURCE_COMMIT']
assert receipt['nativeSHA256']==os.environ['GTA_QA_NATIVE_SHA256']
images=[];total=0;captures=TEMP/'captures'
if captures.exists():
 assert captures.is_dir() and not captures.is_symlink()
 for source in sorted(captures.iterdir()):
  if source.suffix!='.png':continue
  assert re.fullmatch(r'(?:home|hub|browse|teen|role|beta|FAILURE)[A-Za-z0-9_-]*\.png',source.name)
  assert source.is_file() and not source.is_symlink();assert 0<source.stat().st_size<=10*1024*1024
  blob=source.read_bytes();assert blob[:8]==b'\x89PNG\r\n\x1a\n';offset=8;chunks=[]
  while offset<len(blob):
   length=struct.unpack('>I',blob[offset:offset+4])[0];kind=blob[offset+4:offset+8];payload=blob[offset+8:offset+8+length];crc=blob[offset+8+length:offset+12+length]
   assert len(payload)==length and len(crc)==4
   assert zlib.crc32(kind+payload)&0xffffffff==struct.unpack('>I',crc)[0]
   # Reject text/EXIF/unknown metadata instead of modifying screenshot bytes.
   assert kind in [b'IHDR',b'IDAT',b'IEND',b'PLTE',b'tRNS',b'sRGB',b'gAMA',b'cHRM',b'pHYs']
   chunks.append(kind);offset+=length+12
  assert offset==len(blob) and chunks[0]==b'IHDR' and chunks[-1]==b'IEND' and b'IDAT' in chunks
  width,height=struct.unpack('>II',blob[16:24]);assert 1<=width<=2000 and 1<=height<=40000
  target=OUT/'screenshots'/source.name;shutil.copyfile(source,target);digest=hashlib.sha256(blob).hexdigest();assert hashlib.sha256(target.read_bytes()).hexdigest()==digest
  total+=len(blob);assert total<=64*1024*1024
  images.append({'file':'screenshots/'+source.name,'sha256':digest,'width':width,'height':height,'bytes':len(blob)})
assert len(images)<=100
events=[]
for line in (TEMP/'browser-private.log').read_text().splitlines():
 try:
  row=json.loads(line)
  if isinstance(row,dict):events.append(row)
 except (json.JSONDecodeError,TypeError):pass
completion=[e for e in events if e.get('event')==SCENE['completionEvent']]
source_case=SCENE['sourceCase'];behavior_cases=SCENE['behaviorCases']
case_names=[e['name'] for e in events if e.get('event')=='case-pass']
cases_completed=sum(name in behavior_cases for name in case_names)
source_checks_completed=case_names.count(source_case) if source_case else 0
coverage=[e for e in events if e.get('event')=='real-viewport-section-covered']
dialog_coverage=[e for e in events if e.get('event')=='real-dialog-section-covered']
if receipt['passed']:
 assert len(images)>0,'Passed scene must include original screenshots'
 assert len(completion)==1 and completion[0]['sourceCommit']==receipt['sourceCommit']
 assert case_names==(([source_case] if source_case else [])+behavior_cases),'Every configured case must pass exactly once'
 if SCENE['family']=='C':
  assert cases_completed==4 and source_checks_completed==1 and completion[0]['passedCases']==5
  assert completion[0]['surface']==SCENE['args'][0] and completion[0]['mode']==SCENE['args'][1]
  name='-'.join(SCENE['args'])+'-actual-asl-policy-conditions'
  assert len(dialog_coverage)==1 and dialog_coverage[0]['name']==name
  frames=[e for e in events if e.get('event')=='real-dialog-section-frame' and e.get('name')==name]
  originals=[image for image in images if image['file'].startswith('screenshots/'+name+'-dialog-viewport-')]
  assert len(frames)==dialog_coverage[0]['frames']==len(originals) and 1<=len(frames)<=20
  assert all(image['width']==390 and image['height']==844 for image in originals)
 elif SCENE['family']=='viewport':
  assert len(coverage)==1 and coverage[0]['name']==SCENE['viewportSection']
  frames=[e for e in events if e.get('event')=='real-viewport-section-frame' and e.get('name')==SCENE['viewportSection']]
  originals=[image for image in images if image['file'].startswith('screenshots/'+SCENE['viewportSection']+'-viewport-')]
  assert len(frames)==coverage[0]['frames']==len(originals) and 1<=len(frames)<=20
  assert len([e for e in events if e.get('event')=='footer-reachable'])==1
  assert len(images)==len(originals)+1
  assert all(image['width']==320 and image['height']==844 for image in images)
 if SCENE['family']=='beta':
  assert cases_completed==len(behavior_cases) and source_checks_completed==1
  assert completion[0]['passedCases']==1+len(behavior_cases)
  states=[e for e in events if e.get('event')=='beta-page-covered']
  actual={(e['mode'],e['width'],e['fontScale']) for e in states}
  expected={(mode,width,scale) for mode in ['light','dark'] for scale,widths in [(100,[320,390,768,1440]),(200,[320,390])] for width in widths}
  assert len(states)==len(expected) and actual==expected,'Every planned beta page state must be fully captured'
def public_failure(events):
 message=next((str(e.get('message','')) for e in events if e.get('event')=='FIRST-FAILURE'),'')
 if not message:return None
 message=re.sub(r'(?:file://)?/(?:home|tmp|Users)/[^\s"<>]+','[runner-path]',message)
 return message if len(message)<=2000 else message[:160]+'\n[launch arguments omitted]\n'+message[-1800:]
manifest={'schemaVersion':1,'scene':KEY,'scope':SCENE['scope'],'appSourceCommit':receipt['sourceCommit'],'nativeFeedSha256':receipt['nativeSHA256'],'testStatus':'passed' if receipt['passed'] else 'failed','visualAcceptance':False,'humanScreenshotReviewRequired':True,'platform':'GitHub public standard ubuntu-24.04; preinstalled Google Chrome','platformLimit':'Linux render/font/host-memory results do not establish macOS Brave, native browser zoom or physical device behavior','browserVersion':receipt.get('browserVersion','unavailable'),'dependencies':{'playwright-core':'1.64.1','@axe-core/playwright':'4.14.0','axe-core':'4.14.0'},'harnessSHA256':SCENE['scriptSHA256'],'resource':{k:receipt[k] for k in ['limitKiB','nodeHeapMiB','deadlineSeconds','memoryMetric','minimumHostFreePercent','peakOwnedRSSKiB','elapsedSeconds','releaseConfirmed']},'casesCompleted':cases_completed,'expectedBehaviorCases':len(behavior_cases),'sourceChecksCompleted':source_checks_completed,'sourceVerification':'Pre/post assertions inside immutable scene script','viewportSectionsCompleted':len(coverage),'dialogSectionsCompleted':len(dialog_coverage),'axeViolationCounts':[len(e['violations']) for e in events if e.get('event')=='axe'],'pendingVisualReviewCount':completion[0].get('pendingVisualReviewCount') if completion else None,'screenshots':images,'failureSummary':public_failure(events),'rangeClampRegression':[e for e in events if e.get('event')=='range-clamp-regression']}
text=json.dumps(manifest,indent=2)+'\n';assert len(text.encode())<=32768
assert '/Users/' not in text and '/home/' not in text and '/tmp/' not in text and 'Bearer ' not in text
(OUT/'evidence.json').write_text(text)
(OUT/'_headers').write_text('/*\n  X-Robots-Tag: noindex, nofollow, noarchive\n  Cache-Control: no-store\n')
(OUT/'robots.txt').write_text('User-agent: *\nDisallow: /\n')
expected={'evidence.json','_headers','robots.txt'}|{e['file'] for e in images}
actual={str(p.relative_to(OUT)) for p in OUT.rglob('*') if p.is_file()};assert actual==expected
print(json.dumps({'sanitizedOriginalPNGs':len(images),'totalPNGBytes':total,'status':manifest['testStatus'],'visualAcceptance':False}))
