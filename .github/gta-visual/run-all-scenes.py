"""Run the eight frozen scenes sequentially; publish original PNGs and metadata only."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

HERE = Path(__file__).resolve().parent
TEMP = Path(os.environ['RUNNER_TEMP'])
OUT = TEMP / 'gta-all-visual-evidence'
assert not OUT.exists()
OUT.mkdir()
(OUT / 'scenes').mkdir()
scenes = json.loads((HERE / 'scenes.json').read_text())
results = []
release_safe = True
for key in scenes:
    scene_temp = TEMP / ('gta-scene-' + key)
    scene_temp.mkdir()
    env = dict(os.environ, RUNNER_TEMP=str(scene_temp), GTA_EVIDENCE_SCENE=key)
    print(json.dumps({'scene': key, 'state': 'started'}), flush=True)
    guarded = subprocess.run([sys.executable, str(HERE / 'run-scene-guard.py')], env=env, cwd=HERE, capture_output=True, text=True)
    # The guard emits only bounded classifications, not its private browser log.
    print(guarded.stdout, end='', flush=True)
    try:
        receipt=json.loads((scene_temp/'gta-remaining-scene-evidence/resource-private.json').read_text())
        release_safe = release_safe and receipt['releaseConfirmed'] and receipt['remainingOwnedPids']==[]
    except (OSError,ValueError,KeyError):
        release_safe = False
    sanitized = subprocess.run([sys.executable, str(HERE / 'sanitize-scene-evidence.py')], env=env, cwd=HERE, capture_output=True, text=True)
    if sanitized.returncode == 0:
        source = scene_temp / 'gta-public-evidence'
        evidence = json.loads((source / 'evidence.json').read_text())
        shutil.copytree(source, OUT / 'scenes' / key)
        results.append({'scene': key, 'testStatus': evidence['testStatus'], 'screenshots': evidence.get('totalOriginalScreenshots',len(evidence['screenshots'])), 'manifest': 'scenes/' + key + '/evidence.json'})
        print(sanitized.stdout, end='', flush=True)
    else:
        results.append({'scene': key, 'testStatus': 'sanitizer-failed', 'screenshots': 0})
        print(json.dumps({'scene': key, 'sanitizerError': sanitized.stderr[-1500:]}), flush=True)
    if guarded.returncode or sanitized.returncode:
        print(json.dumps({'scene': key, 'state': 'stopped-after-failure', 'cleanupConfirmed': release_safe}), flush=True)
        break
passed = len(results) == len(scenes) and all(row['testStatus'] == 'passed' for row in results)
summary = {'schemaVersion': 1, 'appSourceCommit': os.environ['GTA_QA_SOURCE_COMMIT'],
           'nativeFeedSha256': os.environ['GTA_QA_NATIVE_SHA256'], 'previewUrl': os.environ['GTA_QA_BASE_URL'],
           'configuredScenes': list(scenes), 'expectedScenes': len(scenes), 'scenesExecuted': len(results), 'browserChecksPassed': passed,
           'visualAcceptance': False, 'safeToPublishEvidence': release_safe, 'originalScreenshotReviewRequired': True, 'scenes': results}
(OUT / 'evidence.json').write_text(json.dumps(summary, indent=2) + '\n')
(OUT / '_headers').write_text('/*\n  X-Robots-Tag: noindex, nofollow, noarchive\n  Cache-Control: no-store\n')
(OUT / 'robots.txt').write_text('User-agent: *\nDisallow: /\n')
assert all(not path.is_symlink() for path in OUT.rglob('*'))
print(json.dumps({'allScenes': summary, 'publicEvidenceDirectory': str(OUT)}), flush=True)
raise SystemExit(0 if passed else 1)
