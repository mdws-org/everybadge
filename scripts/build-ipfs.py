"""Assemble the IPFS build of everybadge.org: the shell plus a snapshot of the index.

    python3 scripts/build-ipfs.py OUT_DIR [--data URL] [--cid]
    python3 scripts/build-ipfs.py --add-flags

OUT_DIR must not exist yet. It receives:

  public/*                    everything except _headers, which no IPFS gateway reads
  index.html, 404.html        with the Content-Security-Policy from _headers as a
                              <meta> tag (frame-ancestors dropped: a meta CSP may not
                              carry it); index.html's script tag gains
                              data-bundle="/data/v1" so app.js knows a snapshot exists
  _redirects                  /event/<id> -> the shell, everything else missing -> 404.html
                              (read by subdomain and DNSLink gateways)
  data/v1/index/**.gz         manifest.json and every file it lists, sha256-checked
  data/v1/cindex/<n>.json.gz  one per browse shard
  build.json                  the commit and the manifest sha256 the build came from

Same inputs give the same bytes: gzip runs with mtime 0 at level 9 and nothing
records the build time, so `ipfs add` with the flags from --add-flags gives the
same CID on any machine with the same zlib. --cid prints that CID without adding
anything (needs kubo). Stdlib only; runs on Python 3.9+.
"""
import argparse
import gzip
import hashlib
import json
import pathlib
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

REPO = pathlib.Path(__file__).resolve().parent.parent
PUBLIC = REPO / "public"
BUNDLE = "/data/v1"
# The flags every `ipfs add` of this build uses, publisher and checker alike.
ADD_FLAGS = ["-rQ", "--cid-version=1", "--raw-leaves=true", "--chunker=size-262144", "--hash=sha2-256"]
SCRIPT_TAG = '<script src="/app.js" defer></script>'
REDIRECTS = "/event/* /index.html 200\n/* /404.html 404\n"


def fetch(url, attempts=3):
    for i in range(attempts):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "everybadge-build-ipfs"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except Exception as e:  # network errors and HTTP errors alike get a retry
            if i == attempts - 1:
                raise RuntimeError(f"fetch failed: {url}: {e}") from e
            time.sleep(2 * (i + 1))


def write_gz(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(gzip.compress(data, compresslevel=9, mtime=0))


def header_csp():
    """The CSP line under /* in _headers, minus frame-ancestors."""
    text = (PUBLIC / "_headers").read_text()
    m = re.search(r"^/\*\n((?:[ \t]+.*\n?)+)", text, re.M)
    if not m:
        sys.exit("_headers: no /* block")
    for line in m.group(1).splitlines():
        name, _, value = line.strip().partition(":")
        if name.lower() == "content-security-policy":
            kept = [d.strip() for d in value.split(";") if d.strip() and not d.strip().startswith("frame-ancestors")]
            return "; ".join(kept)
    sys.exit("_headers: no Content-Security-Policy under /*")


def stamp_html(out):
    csp = header_csp().replace("&", "&amp;").replace('"', "&quot;")
    meta = f'<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="{csp}">'
    for name in ("index.html", "404.html"):
        page = out / name
        html = page.read_text()
        if html.count('<meta charset="utf-8">') != 1:
            sys.exit(f"{name}: expected one charset meta to anchor the CSP")
        html = html.replace('<meta charset="utf-8">', meta)
        if name == "index.html":
            if html.count(SCRIPT_TAG) != 1:
                sys.exit(f"index.html: expected exactly one {SCRIPT_TAG}")
            html = html.replace(SCRIPT_TAG, f'<script src="/app.js" data-bundle="{BUNDLE}" defer></script>')
        page.write_text(html)


def copy_shell(out):
    shutil.copytree(PUBLIC, out, ignore=shutil.ignore_patterns("_headers", ".assetsignore"))
    stamp_html(out)
    (out / "_redirects").write_text(REDIRECTS)


def snapshot_index(out, data):
    """Manifest + listed files (sha256-checked) + cindex shards, gzipped under data/v1."""
    root = out / BUNDLE.lstrip("/")
    raw = fetch(f"{data}/v1/index/manifest.json")
    manifest = json.loads(raw)
    write_gz(root / "index" / "manifest.json.gz", raw)

    def index_file(item):
        name, info = item
        body = fetch(f"{data}/v1/index/{name}")
        if len(body) != info["bytes"] or hashlib.sha256(body).hexdigest() != info["sha256"]:
            raise RuntimeError(f"index/{name}: bytes or sha256 differ from the manifest (stale edge cache?)")
        write_gz(root / "index" / (name + ".gz"), body)

    def cindex_file(n):
        body = fetch(f"{data}/v1/cindex/{n}.json")
        if not isinstance(json.loads(body), dict):
            raise RuntimeError(f"cindex/{n}.json: not a JSON object")
        write_gz(root / "cindex" / f"{n}.json.gz", body)

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(index_file, sorted(manifest["files"].items())))
        list(pool.map(cindex_file, manifest["shards"]))
    return hashlib.sha256(raw).hexdigest(), len(manifest["files"]), len(manifest["shards"])


def git_state():
    try:
        commit = subprocess.run(["git", "-C", str(REPO), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
        dirty = bool(subprocess.run(["git", "-C", str(REPO), "status", "--porcelain", "--", "public", "scripts"], capture_output=True, text=True, check=True).stdout.strip())
        return commit, dirty
    except (OSError, subprocess.CalledProcessError):
        return None, None


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("out", nargs="?", type=pathlib.Path)
    ap.add_argument("--data", default="https://data.everybadge.org")
    ap.add_argument("--cid", action="store_true", help="print the CID (ipfs add --only-hash)")
    ap.add_argument("--add-flags", action="store_true", help="print the ipfs add flags and exit")
    args = ap.parse_args()
    if args.add_flags:
        print(" ".join(ADD_FLAGS))
        return
    if args.out is None:
        ap.error("OUT_DIR is required")
    if args.out.exists():
        sys.exit(f"{args.out} already exists")

    data = args.data.rstrip("/")
    copy_shell(args.out)
    sha, n_index, n_cindex = snapshot_index(args.out, data)
    commit, dirty = git_state()
    build = {"commit": commit, "dirty": dirty, "manifest_sha256": sha, "data": data}
    (args.out / "build.json").write_text(json.dumps(build, indent=1, sort_keys=True) + "\n")
    print(f"built {args.out}: commit {commit}{' (dirty)' if dirty else ''}, manifest {sha[:12]}, {n_index} index + {n_cindex} cindex files", file=sys.stderr)
    if args.cid:
        cid = subprocess.run(["ipfs", "add", *ADD_FLAGS, "--only-hash", "--offline", str(args.out)], capture_output=True, text=True, check=True).stdout.strip()
        print(cid)


if __name__ == "__main__":
    main()
