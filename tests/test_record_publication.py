import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import Mock, patch
import urllib.error
from datetime import datetime, timezone

spec = importlib.util.spec_from_file_location("publication", Path(__file__).parents[1] / "scripts/record-publication.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.source = "a" * 40
        self.body = b'{"opportunities":[{"id":"real-test-row"}]}'
        self.manifest = {"sourceCommit": self.source, "nativeFeedSha256": hashlib.sha256(self.body).hexdigest(),
                         "nativeFeedRecords": 1, "publicationBytes": 123456, "publicationFiles": 100}
        self.payloads = {origin + path: value for origin in module.HOSTS for path, value in (
            ("/hosting-release.json?source=" + self.source, json.dumps(self.manifest).encode()),
            ("/opportunities.json?source=" + self.source, self.body))}
        self.read = Mock(side_effect=lambda url, limit: self.payloads[url])
        self.api = Mock(side_effect=self.missing_then_write)
        self.now = datetime(2026, 10, 25, 20, tzinfo=timezone.utc)

    def missing_then_write(self, method, payload=None):
        if method == "GET":
            raise urllib.error.HTTPError("https://api.github.com/fixture", 404, "not found", {}, None)
        return {"commit": {"sha": "b" * 40}}

    def record(self, **kwargs):
        return module.record(self.source, "123", module.REPOSITORY,
                             api=self.api, read=self.read, now=kwargs.get("now", self.now))

    def test_persisted_receipt_identifies_both_verified_hosts_and_exact_bytes(self):
        self.assertTrue(self.record())
        self.assertEqual(self.read.call_count, 4)
        method, payload = self.api.call_args.args
        self.assertEqual(method, "PUT")
        self.assertEqual(payload["branch"], "main")
        receipt = json.loads(base64.b64decode(payload["content"]))
        self.assertEqual(receipt["sourceCommit"], self.source)
        self.assertEqual([host["origin"] for host in receipt["hosts"]], list(module.HOSTS))
        self.assertEqual(receipt["hosts"][0]["nativeFeedBytes"], len(self.body))

    def test_stale_backup_cannot_replace_the_retained_receipt(self):
        stale = {**self.manifest, "sourceCommit": "c" * 40}
        self.payloads[module.HOSTS[1] + "/hosting-release.json?source=" + self.source] = json.dumps(stale).encode()
        with self.assertRaisesRegex(ValueError, "expected source"):
            self.record()
        self.api.assert_not_called()

    def test_modified_native_bytes_cannot_record_success(self):
        self.payloads[module.HOSTS[0] + "/opportunities.json?source=" + self.source] += b" "
        with self.assertRaisesRegex(ValueError, "bytes do not match"):
            self.record()
        self.api.assert_not_called()

    def test_false_native_count_cannot_record_success(self):
        wrong = {**self.manifest, "nativeFeedRecords": 2}
        self.payloads[module.HOSTS[0] + "/hosting-release.json?source=" + self.source] = json.dumps(wrong).encode()
        with self.assertRaisesRegex(ValueError, "count does not match"):
            self.record()
        self.api.assert_not_called()

    def test_disagreeing_publication_metadata_cannot_record_success(self):
        wrong = {**self.manifest, "publicationFiles": 101}
        self.payloads[module.HOSTS[1] + "/hosting-release.json?source=" + self.source] = json.dumps(wrong).encode()
        with self.assertRaisesRegex(ValueError, "hosts disagree"):
            self.record()
        self.api.assert_not_called()

    def test_each_manifest_bound_fails_closed(self):
        for key, value in [("nativeFeedRecords", 0), ("nativeFeedRecords", 5000),
                           ("nativeFeedRecords", True), ("publicationBytes", 800_000_001),
                           ("publicationFiles", 20_001), ("nativeFeedSha256", "invalid")]:
            with self.subTest(key=key, value=value):
                wrong = {**self.manifest, key: value}
                self.payloads[module.HOSTS[0] + "/hosting-release.json?source=" + self.source] = json.dumps(wrong).encode()
                with self.assertRaises(ValueError):
                    self.record()
                self.api.assert_not_called()

    def test_same_day_matching_receipt_still_checks_both_hosts_without_an_extra_commit(self):
        hosts = module.verify_hosts(self.source, self.read)
        self.read.reset_mock()
        old = {"verifiedDateUTC": "2026-10-25", "hosts": hosts}
        self.api.side_effect = None
        self.api.return_value = {"sha": "old-file-sha", "content": base64.b64encode(json.dumps(old).encode()).decode()}
        self.assertFalse(self.record())
        self.assertEqual(self.read.call_count, 4)
        self.assertEqual(self.api.call_count, 1)

    def test_next_day_real_verification_updates_existing_receipt_using_its_sha(self):
        hosts = module.verify_hosts(self.source, self.read)
        old = {"verifiedDateUTC": "2026-10-24", "hosts": hosts}
        self.api.side_effect = None
        self.api.return_value = {"sha": "old-file-sha", "content": base64.b64encode(json.dumps(old).encode()).decode()}
        self.assertTrue(self.record())
        self.assertEqual(self.api.call_args.args[1]["sha"], "old-file-sha")

    def test_network_failure_preserves_retained_receipt(self):
        self.read.side_effect = urllib.error.URLError("offline fixture")
        with self.assertRaises(urllib.error.URLError):
            self.record()
        self.api.assert_not_called()

    def test_repository_scope_and_commit_are_checked_before_network_or_writes(self):
        with self.assertRaises(ValueError):
            module.record(self.source, "123", "another/repository", api=self.api, read=self.read)
        with self.assertRaises(ValueError):
            module.record("main", "123", module.REPOSITORY, api=self.api, read=self.read)
        self.api.assert_not_called()
        self.read.assert_not_called()

    def test_public_download_is_bounded(self):
        response = Mock(status=200)
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = b"x" * 101
        with patch.object(module.urllib.request, "urlopen", return_value=response):
            with self.assertRaisesRegex(ValueError, "byte limit"):
                module.read_url(module.HOSTS[0], 100)
        response.read.assert_called_once_with(101)


if __name__ == "__main__":
    unittest.main()
