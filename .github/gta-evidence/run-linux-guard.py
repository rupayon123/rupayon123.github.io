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
start=time.monotonic();owned={os.getpid()};process=None;phase='setup'
class GuardStop(RuntimeError):
 def __init__(self,category):super().__init__(category);self.category=category
def select_owned(data,root_pid,profile,completed_probe_pid):
 # Exclude ONLY this already-completed synchronous probe, never a command class.
 data=[r for r in data if int(r[0])!=completed_probe_pid];children={root_pid}
 for _ in range(32):
  before=len(children);children.update(int(r[0]) for r in data if int(r[1]) in children or profile in r[3])
  if len(children)==before:break
 return data,children
def existing_owned(data,known,root_pid,state_reader):
 # Keep zombies/unknown states conservative; only a vanished /proc entry is gone.
 return [int(r[0]) for r in data if int(r[0])!=root_pid and int(r[0]) in known and state_reader(int(r[0])) is not None]
def rows():
 probe=subprocess.Popen(['ps','-axo','pid=,ppid=,rss=,command='],stdout=subprocess.PIPE,text=True)
 try:output,_=probe.communicate(timeout=5)
 except BaseException:
  probe.kill();probe.wait();raise
 if probe.returncode:raise GuardStop('process-probe-failed')
 return [r.strip().split(None,3) for r in output.splitlines() if r.strip()],probe.pid
def inventory():
 snapshot,completed_probe_pid=rows();data,children=select_owned(snapshot,os.getpid(),str(TMP),completed_probe_pid)
 owned.update(children)
 return data
def process_state(pid):
 try:return Path('/proc/'+str(pid)+'/stat').read_text().rpartition(')')[2].split()[0]
 except FileNotFoundError:return None
 except (PermissionError,IndexError):return 'unknown'
def reap_finished():
 if process is not None:process.poll() # Let Popen reap its own Node child.
 for pid in owned-{os.getpid()}-({process.pid} if process is not None else set()):
  try:os.waitpid(pid,os.WNOHANG)
  except (ChildProcessError,ProcessLookupError):pass
def sample():
 data=inventory();rss=sum(int(r[2]) for r in data if int(r[0]) in owned)
 info={line.split(':')[0]:int(line.split()[1]) for line in Path('/proc/meminfo').read_text().splitlines()}
 free=info['MemAvailable']/info['MemTotal']*100
 receipt['peakOwnedRSSKiB']=max(receipt['peakOwnedRSSKiB'],rss);receipt['minimumHostFreePercent']=min(receipt['minimumHostFreePercent'],free)
 if free<=30:raise GuardStop('remote-memory-floor')
 if rss>2097152:raise GuardStop('owned-rss-cap')
 if time.monotonic()-start>1200:raise GuardStop('scene-deadline')
def live_owned():
 reap_finished();return existing_owned(inventory(),owned,os.getpid(),process_state)
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
 if live_owned():raise GuardStop('owned-processes-remain')
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
  phase='browser'
  process=subprocess.Popen(['node',str(SCRIPT),'hub','dark'],cwd=HERE,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True);owned.add(process.pid)
  while process.poll() is None:sample();time.sleep(.05)
  receipt['exitCode']=process.wait()
  if process.returncode:raise GuardStop('browser-test-failure')
 phase='post-browser-cleanup'
 until=time.monotonic()+3
 while live_owned() and time.monotonic()<until:time.sleep(.05)
 if live_owned():raise GuardStop('owned-processes-after-browser')
 assert hashlib.sha256(SCRIPT.read_bytes()).hexdigest()=='3888d1ff3f3750519eda4d45155918cae7c8bbbc21138de5a0413b093530e445'
 receipt['passed']=True
except BaseException as error:
 # Raw error messages and paths remain private to this disposable VM.
 receipt['privateFailure']=repr(error)
 receipt['originalStopCategory']=error.category if isinstance(error,GuardStop) else phase+'-exception'
finally:
 try:cleanup()
 except BaseException as error:receipt['privateCleanupFailure']=repr(error);receipt['cleanupCategory']=error.category if isinstance(error,GuardStop) else 'cleanup-exception';receipt['passed']=False
 receipt['remainingOwnedPids']=live_owned();receipt['releaseConfirmed']=not receipt['remainingOwnedPids'] and not receipt.get('privateCleanupFailure')
 receipt['elapsedSeconds']=round(time.monotonic()-start,2)
 if process is not None:receipt['exitCodeAfterCleanup']=process.poll()
 if not receipt['releaseConfirmed']:receipt['passed']=False
 receipt.setdefault('originalStopCategory','none');receipt.setdefault('cleanupCategory','confirmed' if receipt['releaseConfirmed'] else 'unconfirmed')
 # Only bounded classifications and counts reach public job stdout.
 cases={'hub-dark immutable source and noindex':'source-pin','hub-dark four actual viewport layouts':'normal-layout','hub-dark actual font200 at320 and390':'font200','hub-dark full actual role facts/forms':'role-details','hub-dark keyboard language and real reduced/normal press':'keyboard-motion-language'}
 completed=[];last_case='not-started';failure_category='none'
 logfile=TEMP/'browser-private.log'
 if logfile.exists():
  for line in logfile.read_text().splitlines():
   try:event=json.loads(line)
   except (json.JSONDecodeError,TypeError):continue
   if not isinstance(event,dict):continue
   if event.get('event')=='case-start' and event.get('name') in cases:last_case=cases[event['name']]
   if event.get('event')=='case-pass' and event.get('name') in cases:completed.append(cases[event['name']])
   if event.get('event')=='FIRST-FAILURE':
    message=str(event.get('message',''))
    failure_category='layout-assertion' if 'strict geometry assertions' in message else 'font-size-assertion' if 'font200-ratio-mismatch' in message else 'browser-timeout' if 'Timeout' in message else 'browser-closed' if 'has been closed' in message else 'page-runtime-error' if 'No runtime page errors' in message else 'browser-assertion-or-runtime'
 states={}
 for pid in receipt['remainingOwnedPids']:
  state=process_state(pid) or 'vanished';states[state]=states.get(state,0)+1
 (TEMP/'resource-private.json').write_text(json.dumps(receipt,indent=2)+'\n')
 print(json.dumps({'scope':'hub-dark-only','passed':receipt['passed'],'originalStopCategory':receipt['originalStopCategory'],'cleanupCategory':receipt['cleanupCategory'],'finalNonProbeProcessCount':len(receipt['remainingOwnedPids']),'remainingProcessStateCounts':states,'browserCasesCompleted':len(completed),'lastBrowserCase':last_case,'browserFailureCategory':failure_category,'browserExitCode':receipt.get('exitCodeAfterCleanup'),'cleanupConfirmed':receipt['releaseConfirmed'],'peakOwnedRSSKiB':receipt['peakOwnedRSSKiB'],'minimumRemoteAvailablePercent':receipt['minimumHostFreePercent'],'elapsedSeconds':receipt['elapsedSeconds']}))
raise SystemExit(0 if receipt['passed'] else 1)
