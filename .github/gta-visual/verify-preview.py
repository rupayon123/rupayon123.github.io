"""Verify preview transport and identity separately from rendered visual checks."""
import argparse
import json
import re
import subprocess
import tempfile
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('base')
    parser.add_argument('commit')
    parser.add_argument('native_sha256')
    args = parser.parse_args()
    assert re.fullmatch(r'https://[a-z0-9-]+\.gta-free-stem\.pages\.dev', args.base), 'Require a non-production preview URL'
    assert re.fullmatch(r'[a-f0-9]{40}', args.commit), 'Require an exact source commit'
    assert re.fullmatch(r'[a-f0-9]{64}', args.native_sha256), 'Require an exact native feed SHA256'
    with tempfile.TemporaryDirectory(prefix='gta-preview-verify-') as folder:
        folder = Path(folder)
        for index, suffix in enumerate(['/', '/hosting-release.json']):
            header = folder / f'{index}.headers'
            body = folder / f'{index}.body'
            result = subprocess.run(['curl', '--fail', '--silent', '--show-error', '--location',
                '--max-redirs', '3', '--max-time', '30', '--proto', '=https', '--proto-redir', '=https',
                '--dump-header', str(header), '--output', str(body), args.base + suffix],
                capture_output=True, text=True)
            if result.returncode:
                raise RuntimeError(f'Preview transport failed for {suffix}: curl {result.returncode}: {result.stderr.strip()}')
            # Curl may include proxy/redirect header blocks; verify the final response.
            headers = header.read_text().replace('\r\n', '\n').strip().split('\n\n')[-1]
            assert re.match(r'HTTP/\S+ 200(?:\s|$)', headers), headers
            noindex = re.search(r'^x-robots-tag:\s*([^\n]+)', headers, re.I | re.M)
            assert noindex and re.search(r'\bnoindex\b', noindex.group(1), re.I), 'Preview must retain noindex'
            if suffix.endswith('.json'):
                release = json.loads(body.read_text())
                assert release['sourceCommit'] == args.commit, release
                assert release['nativeFeedSha256'] == args.native_sha256, release
    print(json.dumps({'preview': args.base, 'sourceCommit': args.commit,
        'nativeFeedSha256': args.native_sha256, 'transportAndIdentity': 'passed',
        'renderedVisualChecks': 'not performed by this verifier'}))


if __name__ == '__main__':
    main()
