# everybadge.org

POAP shut down on 2026-08-03. This is the site for an archive of what it held: 197,577 events, with their metadata and their artwork.

## What was kept

- **Metadata**, 145 MB, covering all 197,577 events - names, dates, descriptions. This is the part that cannot be rebuilt from anything else. A hash proves a file is unaltered, but it will not tell you what the event was called.
- **Artwork**, 194 GB - the event images themselves.
- **Thumbnails**, 4.4 GB - 400px renders, enough to browse the whole corpus without pulling the full artwork.

Every file is addressed by its hash and listed in a public registry, so any copy can be checked against the original rather than trusted.

## Content roots

The archive is on IPFS. These roots are the whole of it:

- artwork - `bafybeiccw6agfdwyezhaossnesw2ftzsycf3d6tljgkh4qdxy547twzi5y`
- metadata - `bafybeif5yj2ywl3eci7dvsvisvqybjjglgujrkvofh2i4u4wasvslktnoe`
- thumbnails - `bafybeidyhc2wvzhuvvcvzvsm5cca3jdj32ev4aejaveav4bxvmeddmucke`
- animated re-encodes - `bafybeibwodt254seymig7cbemxwgj4e5lztui3ccz6ypboafyl5i2ptn4a`

If you run IPFS, pinning the metadata root is the single most useful thing you can do. It is 145 MB and it is the copy that does not depend on anyone's server staying up.

## The site

A static shell - `index.html`, `app.js`, `style.css` - about 10 KB gzipped, no build step, no framework, no webfont. It browses newest-first, searches by name or id with a year filter, and shows one page per event at `/event/<id>`.

All the heavy bytes live behind `https://data.everybadge.org` (an R2 bucket, same key layout as the corpus): a browse index in 1,000-event shards, `cindex/` for artwork hashes, `meta/` for the original metadata, `thumb/` for 400px WebPs. If that host does not answer, the same paths are tried under the IPFS roots above through public gateways - the site is a convenience over an archive that exists without it. The event page says when its metadata came from a gateway, unchecked against the archive, and the footer says that a gateway then sees which event was opened.

Deployed as a Cloudflare Worker with static assets (`wrangler.jsonc`, `worker.js`), with Netlify as a second host from the same repo (`netlify.toml`). `_headers` carries a strict CSP.

`scripts/build-ipfs.py OUT_DIR` assembles the copy of the site for IPFS: the shell, with the CSP from `_headers` as a meta tag and a `_redirects` file for `/event/<id>`, plus a gzipped snapshot of the index and cindex, each index file checked against the manifest's sha256. That copy reads the data host first and falls back to its own snapshot, so it still browses and searches with the data host gone. The same commit and manifest give the same CID: `--cid` prints it, and `--add-flags` prints the `ipfs add` flags that make it so.

Local development: `python3 ~/Projects/everybadge-build/devserve.py` serves the shell against a local copy of the index.

## Two things the data will tell you that look like bugs

Two events have no name in POAP's own metadata (81 and 146588); they show as "(untitled)". Ninety-five events carry years outside 2018-2026 - organiser typos like 985 and 3463 - and are shown as entered. Nothing in the archive is corrected.

## Security

Report issues at https://github.com/mdws-org/everybadge/issues. There is nothing to log into and nothing is collected; the surface is the static shell and the CSP.
