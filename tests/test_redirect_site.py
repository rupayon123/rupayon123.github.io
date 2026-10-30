import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("redirect_site", Path(__file__).parents[1] / "scripts/prepare-redirect-site.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RedirectSiteTests(unittest.TestCase):
    def test_nested_routes_verification_and_feed_are_preserved(self):
        with tempfile.TemporaryDirectory() as root:
            source, target = Path(root) / "out", Path(root) / "redirect"
            (source / "high-school").mkdir(parents=True)
            (source / "index.html").write_text("old root")
            (source / "high-school/index.html").write_text("old guide")
            (source / "google123abc.html").write_text("google-site-verification: google123abc.html")
            feed = b'{"opportunities":[]}'
            (source / "opportunities.json").write_bytes(feed)
            (source / "hosting-release.json").write_text(json.dumps({"sourceCommit": "a" * 40, "nativeFeedSha256": "b" * 64}))
            module.prepare(source, target)
            self.assertEqual((source / "index.html").read_text(), "old root")
            self.assertEqual((target / "opportunities.json").read_bytes(), feed)
            self.assertEqual((target / "google123abc.html").read_bytes(), (source / "google123abc.html").read_bytes())
            page = (target / "high-school/index.html").read_text()
            self.assertIn('href="https://gta-free-stem.pages.dev/high-school/"', page)
            self.assertIn('content="noindex,follow"', page)
            self.assertIn('content="0;url=https://gta-free-stem.pages.dev/high-school/"', page)
            self.assertEqual(json.loads((target / "hosting-release.json").read_text())["siteMode"], "redirect-v1")
            self.assertIn("window.location.pathname", (target / "404.html").read_text())

    def test_query_hash_and_hostile_path_cannot_change_destination_origin(self):
        # Execute the actual emitted script with URL inputs, without a browser.
        script = ('const vm=require("node:vm");const cases=['
                  '{pathname:"/high-school/",search:"?pathway=volunteer",hash:"#discover"},'
                  '{pathname:"//example.com/not-our-site",search:"?next=https://example.com",hash:"#x"}];'
                  'for(const current of cases){let result;const window={location:{...current,replace:v=>result=v}};'
                  'vm.runInNewContext(' + json.dumps(module.REDIRECT_SCRIPT) + ',{window,URL});'
                  'const target=new URL(result);if(target.origin!==' + json.dumps(module.ORIGIN) + ')throw Error("origin");'
                  'if(target.pathname!==current.pathname||target.search!==current.search||target.hash!==current.hash)throw Error("lost criteria");}')
        subprocess.run(["node", "-e", script], check=True, capture_output=True)

    def test_never_overwrite_export_or_existing_destination(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root)
            with self.assertRaises(ValueError):
                module.prepare(source, source)
            with self.assertRaises(ValueError):
                module.prepare(source, source / "nested")


if __name__ == "__main__":
    unittest.main()
