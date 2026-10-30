"""SOURCE ONLY. One remote Hub-dark scene. Never upload raw logs or profiles."""
import hashlib,json,os,re,signal,subprocess,time
from pathlib import Path

HERE=Path(__file__).resolve().parent
TEMP=Path(os.environ['RUNNER_TEMP'])/'gta-hub-dark-evidence'
TEMP.mkdir(exist_ok=False)
CAPTURE=TEMP/'captures';TMP=TEMP/'profile';TMP.mkdir()
SCRIPT=HERE/'run-hub-dark.cjs'
assert hashlib.sha256(SCRIPT.read_bytes()).hexdigest()=='3888d1ff3f3750519eda4d45155918cae7c8bbbc21138de5a0413b093530e445'
receipt={'scope':'hub-dark-only','sourceCommit':'9f83e87e4447b805373ff9f7f206adb737e5c413','nativeSHA256':'07c1eafc85931f9a44f926242f8377680c569191d04928223780e861e70d101e','limitKiB':2097152,'nodeHeapMiB':512,'deadlineSeconds':1200,'memoryMetric':'Linux MemAvailable/MemTotal percent; NOT macOS memory_pressure','minimumHostFreePercent':100,'peakOwnedRSSKiB':0,'passed':False}
start=time.monotonic();owned={os.getpid()};process=None
def rows():
 return [r.strip().split(None,3) for r in subprocess.check_output(['ps','-axo','pid=,ppid=,rss=,command='],text=True).splitlines() if r.strip()]
def inventory():
 data=rows();children={os.getpid()}
 for _ in range(32):
  before=len(children);children.update(int(r[0]) for r in data if int(r[1]) in children or str(TMP) in r[3])
  if len(children)==before:break
 owned.update(children)
 return data
def sample():
 data=inventory();rss=sum(int(r[2]) for r in data if int(r[0]) in owned)
 info={line.split(':')[0]:int(line.split()[1]) for line in Path('/proc/meminfo').read_text().splitlines()}
 free=info['MemAvailable']/info['MemTotal']*100
 receipt['peakOwnedRSSKiB']=max(receipt['peakOwnedRSSKiB'],rss);receipt['minimumHostFreePercent']=min(receipt['minimumHostFreePercent'],free)
 if free<=30:raise RuntimeError('Remote VM available memory not above30%')
 if rss>2097152:raise RuntimeError('Total owned RSS exceeds2GiB')
 if time.monotonic()-start>1200:raise RuntimeError('One-scene deadline exceeded')
def live_owned():
 return [int(r[0]) for r in inventory() if int(r[0])!=os.getpid() and int(r[0]) in owned]
def cleanup():
 for sig in [signal.SIGTERM,signal.SIGKILL]:
  live=live_owned()
  if not live:return
  if process is not None and process.poll() is None:
   try:os.killpg(process.pid,sig)
   except ProcessLookupError:pass
  for pid in live:
   try:os.kill(pid,sig)
   except ProcessLookupError:pass
  until=time.monotonic()+3
  while live_owned() and time.monotonic()<until:time.sleep(.05)
 if live_owned():raise RuntimeError('Owned process cleanup unconfirmed')
try:
 sample()
 chrome=Path('/usr/bin/google-chrome');assert chrome.is_file(),'Preinstalled Chrome required; no download fallback'
 version=subprocess.check_output([str(chrome),'--version'],text=True).strip();assert re.fullmatch(r'Google Chrome [0-9.]+(?: [A-Za-z ]+)?',version);receipt['browserVersion']=version
 modules=HERE/'node_modules'
 for name,version in [('playwright-core','1.64.1'),('@axe-core/playwright','4.14.0'),('axe-core','4.14.0')]:assert json.loads((modules/name/'package.json').read_text())['version']==version
 # Browser gets only operating-system variables, never Actions or account tokens.
 env={k:os.environ[k] for k in ['PATH','HOME','LANG','LC_ALL','DISPLAY','XDG_RUNTIME_DIR','FONTCONFIG_PATH','LD_LIBRARY_PATH'] if k in os.environ}
 env.update(NODE_OPTIONS='--max-old-space-size=512',TMPDIR=str(TMP),GTA_QA_CAPTURE_DIR=str(CAPTURE),GTA_QA_BROWSER=str(chrome),GTA_QA_PLAYWRIGHT_MODULE=str(modules/'playwright-core'),GTA_QA_AXE_MODULE=str(modules/'@axe-core/playwright'))
 with (TEMP/'browser-private.log').open('w') as log:
  process=subprocess.Popen(['node',str(SCRIPT),'hub','dark'],cwd=HERE,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True);owned.add(process.pid)
  while process.poll() is None:sample();time.sleep(.05)
  receipt['exitCode']=process.wait();assert process.returncode==0,'Hub-dark first failure; no further tests'
 until=time.monotonic()+3
 while live_owned() and time.monotonic()<until:time.sleep(.05)
 assert not live_owned(),'Browser left owned processes'
 assert hashlib.sha256(SCRIPT.read_bytes()).hexdigest()=='3888d1ff3f3750519eda4d45155918cae7c8bbbc21138de5a0413b093530e445'
 receipt['passed']=True
except BaseException as error:
 # Raw error messages and paths remain private to this disposable VM.
 receipt['privateFailure']=repr(error)
finally:
 try:cleanup()
 except BaseException as error:receipt['privateCleanupFailure']=repr(error);receipt['passed']=False
 receipt['remainingOwnedPids']=live_owned();receipt['releaseConfirmed']=not receipt['remainingOwnedPids'] and not receipt.get('privateCleanupFailure')
 receipt['elapsedSeconds']=round(time.monotonic()-start,2)
 if process is not None:receipt['exitCodeAfterCleanup']=process.poll()
 if not receipt['releaseConfirmed']:receipt['passed']=False
 (TEMP/'resource-private.json').write_text(json.dumps(receipt,indent=2)+'\n')
 print(json.dumps({'scope':'hub-dark-only','passed':receipt['passed'],'cleanupConfirmed':receipt['releaseConfirmed'],'elapsedSeconds':receipt['elapsedSeconds']}))
raise SystemExit(0 if receipt['passed'] else 1)
