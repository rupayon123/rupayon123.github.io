"""Keep old links and feed clients working while presenting one public website."""
import html
import hashlib
import json
from pathlib import Path
import re
import shutil
import sys
from urllib.parse import quote

ORIGIN = "https://gta-free-stem.pages.dev"
MODE = "redirect-v1"
REDIRECT_SCRIPT = (
    'const target=new URL("' + ORIGIN + '");'
    'target.pathname=window.location.pathname;'
    'target.search=window.location.search;'
    'target.hash=window.location.hash;'
    'window.location.replace(target.href);'
)


def redirect_html(path):
    target = html.escape(ORIGIN + quote(path, safe="/-._~"), quote=True)
    return ('<!doctype html><html lang="en"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1">'
            '<title>GTA Free STEM — our website has moved</title>'
            '<meta name="robots" content="noindex,follow">'
            '<link rel="canonical" href="' + target + '">'
            '<script>' + REDIRECT_SCRIPT + '</script>'
            '<meta http-equiv="refresh" content="0;url=' + target + '">'
            '</head><body><p>GTA Free STEM has one home: '
            '<a href="' + target + '">gta-free-stem.pages.dev</a>.</p>'
            '<p>Your saved items belong to the browser and website address where '
            'you saved them; they do not transfer automatically.</p></body></html>')


def prepare(source, destination):
    source, destination = Path(source).resolve(), Path(destination).resolve()
    if source == destination or source in destination.parents or destination in source.parents:
        raise ValueError("Use separate export and redirect directories")
    if destination.exists():
        raise ValueError("Redirect output must be new; never replace an existing directory")
    manifest = json.loads((source / "hosting-release.json").read_text())
    if not re.fullmatch(r"[a-f0-9]{40}", manifest.get("sourceCommit", "")) or not (source / "index.html").is_file():
        raise ValueError("A verified application export is required")
    shutil.copytree(source, destination)
    count = 0
    for page in destination.rglob("*.html"):
        relative = page.relative_to(destination)
        # Existing Search Console ownership proofs must remain literal files.
        if len(relative.parts) == 1 and re.fullmatch(r"google[a-f0-9]+\.html", page.name):
            continue
        path = "/" + relative.as_posix()
        if page.name == "index.html":
            path = path[:-len("index.html")]
        if path == "/404.html":
            path = "/"
        page.write_text(redirect_html(path), encoding="utf-8")
        count += 1
    (destination / "404.html").write_text(redirect_html("/"), encoding="utf-8")
    manifest.update(siteMode=MODE, canonicalOrigin=ORIGIN,
                    redirectScriptSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
    (destination / "hosting-release.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (destination / "robots.txt").write_text("User-agent: *\nAllow: /\nSitemap: " + ORIGIN + "/sitemap.xml\n")
    print(f"Prepared {count} redirect pages; non-HTML assets and native feed preserved.")


if __name__ == "__main__":
    prepare(*sys.argv[1:])
