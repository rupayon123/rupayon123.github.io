"""Verify the canonical website, old-address redirects and compatible feed copies."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

REPOSITORY = "rupayon123/rupayon123.github.io"
HOSTS = ("https://gta-free-stem.pages.dev", "https://rupayon123.github.io")
RECEIPT_PATH = "last-verified-publication.json"
MAX_FEED_BYTES = 10_000_000
AGENT = "GTA-Free-STEM-Release-Check/1.0 (+https://github.com/" + REPOSITORY + ")"


def read_url(url, limit):
    request = urllib.request.Request(url, headers={"User-Agent": AGENT})
    with urllib.request.urlopen(request, timeout=30) as response:
        if response.status != 200:
            raise ValueError("Public verification did not return HTTP 200")
        body = response.read(limit + 1)
    if len(body) > limit:
        raise ValueError("Public verification response exceeds its byte limit")
    return body


def integer(value, minimum, maximum):
    return type(value) is int and minimum <= value <= maximum


def verify_hosts(expected, read=read_url):
    if not re.fullmatch(r"[a-f0-9]{40}", expected):
        raise ValueError("Expected source must be a full commit SHA")
    verified = []
    reference = None
    for origin in HOSTS:
        manifest = json.loads(read(origin + "/hosting-release.json?source=" + expected, 65_536))
        if not isinstance(manifest, dict) or manifest.get("sourceCommit") != expected:
            raise ValueError("Public host does not serve the expected source: " + origin)
        digest = manifest.get("nativeFeedSha256")
        if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
            raise ValueError("Invalid public feed digest")
        if not integer(manifest.get("nativeFeedRecords"), 1, 4999):
            raise ValueError("Invalid public feed count")
        if not integer(manifest.get("publicationBytes"), 1, 800_000_000):
            raise ValueError("Invalid publication size")
        if not integer(manifest.get("publicationFiles"), 1, 20_000):
            raise ValueError("Invalid publication file count")
        body = read(origin + "/opportunities.json?source=" + expected, MAX_FEED_BYTES)
        if len(body) > MAX_FEED_BYTES or hashlib.sha256(body).hexdigest() != digest:
            raise ValueError("Public feed bytes do not match the release: " + origin)
        feed = json.loads(body)
        if not isinstance(feed, dict) or not isinstance(feed.get("opportunities"), list):
            raise ValueError("Invalid public feed shape")
        if len(feed["opportunities"]) != manifest["nativeFeedRecords"]:
            raise ValueError("Public feed count does not match the release")
        facts = {key: manifest[key] for key in (
            "sourceCommit", "nativeFeedSha256", "nativeFeedRecords", "publicationBytes", "publicationFiles"
        )}
        if reference is not None and facts != reference:
            raise ValueError("Public hosts disagree about the release")
        reference = facts
        role = "website"
        if origin == HOSTS[1]:
            if manifest.get("siteMode") != "redirect-v1" or manifest.get("canonicalOrigin") != HOSTS[0]:
                raise ValueError("Old address is not configured as a canonical-site redirect")
            expected_redirect = hashlib.sha256((Path(__file__).parent / 'prepare-redirect-site.py').read_bytes()).hexdigest()
            if manifest.get("redirectScriptSha256") != expected_redirect:
                raise ValueError("Old address has stale redirect code")
            for path in ("/", "/high-school/"):
                page = read(origin + path + "?release=" + expected, 65_536).decode("utf-8")
                if ('href="' + HOSTS[0] + path + '"') not in page or 'window.location.replace(target.href)' not in page or 'content="noindex,follow"' not in page:
                    raise ValueError("Old address still presents a duplicate website")
            role = "redirect-and-compatible-feed"
        verified.append({"origin": origin, **facts, "nativeFeedBytes": len(body), "role": role})
    return verified


def github_api(method, payload=None):
    token = os.environ["GH_TOKEN"]
    url = "https://api.github.com/repos/" + REPOSITORY + "/contents/" + RECEIPT_PATH
    if method == "GET":
        url += "?ref=main"
    request = urllib.request.Request(url, method=method,
        headers={"Authorization": "Bearer " + token, "User-Agent": AGENT,
                 "Accept": "application/vnd.github+json", "Content-Type": "application/json",
                 "X-GitHub-Api-Version": "2022-11-28"},
        data=json.dumps(payload).encode() if payload is not None else None)
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def record(expected, run_id, repository, api=github_api, read=read_url, now=None):
    if repository != REPOSITORY or not re.fullmatch(r"[0-9]+", run_id):
        raise ValueError("Receipt writes are restricted to the hosting repository")
    # Finish every public check before consulting or changing the retained receipt.
    hosts = verify_hosts(expected, read)
    day = (now or datetime.now(timezone.utc)).astimezone(timezone.utc).date().isoformat()
    sha = None
    previous = None
    try:
        existing = api("GET")
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise
    else:
        sha = existing["sha"]
        previous = json.loads(base64.b64decode(existing["content"]))
    if isinstance(previous, dict) and previous.get("verifiedDateUTC") == day and previous.get("hosts") == hosts:
        print("Both public hosts verified; today's matching receipt is already recorded.")
        return False
    receipt = {"verifiedDateUTC": day, "sourceCommit": expected,
               "runUrl": "https://github.com/" + REPOSITORY + "/actions/runs/" + run_id, "hosts": hosts}
    payload = {"branch": "main", "message": "Record verified free-host publication " + expected[:7],
               "content": base64.b64encode((json.dumps(receipt, indent=2) + "\n").encode()).decode()}
    if sha is not None:
        payload["sha"] = sha
    api("PUT", payload)
    print("Verified both public hosts and recorded their source and feed digests.")
    return True


if __name__ == "__main__":
    # Allow bounded propagation delay after a real deployment; never record an unverified release.
    for attempt in range(6):
        try:
            record(os.environ["EXPECTED_SOURCE_COMMIT"], os.environ["GITHUB_RUN_ID"], os.environ["GITHUB_REPOSITORY"])
            break
        except (ValueError, urllib.error.URLError, TimeoutError):
            if attempt == 5:
                raise
            time.sleep(5)
