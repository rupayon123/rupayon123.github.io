"""Copy original browser PNGs through a strict allowlist. Never publish raw logs."""
import hashlib,json,os,re,shutil,struct,zlib
from pathlib import Path
TEMP=Path(os.environ['RUNNER_TEMP'])/'gta-hub-dark-evidence'
OUT=Path(os.environ['RUNNER_TEMP'])/'gta-public-evidence'
assert not OUT.exists();OUT.mkdir();(OUT/'screenshots').mkdir()
receipt=json.loads((TEMP/'resource-private.json').read_text())
assert receipt['releaseConfirmed'] and receipt['remainingOwnedPids']==[],'Cleanup proof required before publishing evidence'
assert receipt['sourceCommit']=='9f83e87e4447b805373ff9f7f206adb737e5c413'
assert receipt['nativeSHA256']=='07c1eafc85931f9a44f926242f8377680c569191d04928223780e861e70d101e'
images=[];total=0;captures=TEMP/'captures'
if captures.exists():
 assert captures.is_dir() and not captures.is_symlink()
 for source in sorted(captures.iterdir()):
  if source.suffix!='.png':continue
  assert re.fullmatch(r'(?:hub|role|FAILURE)[A-Za-z0-9_-]*\.png',source.name)
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
completion=[e for e in events if e.get('event')=='B-SCENE-COMPLETE']
source_case='hub-dark immutable source and noindex'
behavior_cases=['hub-dark four actual viewport layouts','hub-dark actual font200 at320 and390','hub-dark full actual role facts/forms','hub-dark keyboard language and real reduced/normal press']
case_names=[e['name'] for e in events if e.get('event')=='case-pass']
cases_completed=sum(name in behavior_cases for name in case_names)
source_checks_completed=case_names.count(source_case)
if receipt['passed']:
 assert len(images)>0,'Passed scene must include original screenshots'
 assert case_names==[source_case,*behavior_cases],'One source check and all four Hub behavior cases must pass exactly once'
 assert cases_completed==4 and source_checks_completed==1
 assert len(completion)==1 and completion[0]['surface']=='hub' and completion[0]['mode']=='dark' and completion[0]['sourceCommit']==receipt['sourceCommit']
 assert completion[0]['passedCases']==5,'Runner counts provenance plus four behavior cases'
manifest={'schemaVersion':1,'scope':'Hub dark theme only','appSourceCommit':receipt['sourceCommit'],'nativeFeedSha256':receipt['nativeSHA256'],'testStatus':'passed' if receipt['passed'] else 'failed','visualAcceptance':False,'humanScreenshotReviewRequired':True,'platform':'GitHub public standard ubuntu-24.04; preinstalled Google Chrome','platformLimit':'Linux render/font/host-memory results do not establish macOS Brave, native browser zoom or physical device behavior','browserVersion':receipt.get('browserVersion','unavailable'),'dependencies':{'playwright-core':'1.64.1','@axe-core/playwright':'4.14.0','axe-core':'4.14.0'},'harnessSHA256':'3888d1ff3f3750519eda4d45155918cae7c8bbbc21138de5a0413b093530e445','resource':{k:receipt[k] for k in ['limitKiB','nodeHeapMiB','deadlineSeconds','memoryMetric','minimumHostFreePercent','peakOwnedRSSKiB','elapsedSeconds','releaseConfirmed']},'casesCompleted':cases_completed,'expectedBehaviorCases':4,'sourceChecksCompleted':source_checks_completed,'axeViolationCounts':[len(e['violations']) for e in events if e.get('event')=='axe'],'pendingVisualReviewCount':completion[0]['pendingVisualReviewCount'] if completion else None,'screenshots':images}
text=json.dumps(manifest,indent=2)+'\n';assert len(text.encode())<=32768
assert '/Users/' not in text and '/home/' not in text and '/tmp/' not in text and 'Bearer ' not in text
(OUT/'evidence.json').write_text(text)
(OUT/'_headers').write_text('/*\n  X-Robots-Tag: noindex, nofollow, noarchive\n  Cache-Control: no-store\n')
(OUT/'robots.txt').write_text('User-agent: *\nDisallow: /\n')
expected={'evidence.json','_headers','robots.txt'}|{e['file'] for e in images}
actual={str(p.relative_to(OUT)) for p in OUT.rglob('*') if p.is_file()};assert actual==expected
print(json.dumps({'sanitizedOriginalPNGs':len(images),'totalPNGBytes':total,'status':manifest['testStatus'],'visualAcceptance':False}))
