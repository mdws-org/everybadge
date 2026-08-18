# everybadge.org

POAP shut down on 2026-08-03. This is the site for an archive of what it held: 197,577 events, with their metadata and their artwork.

## What was kept

- **Metadata**, 145 MB, covering all 197,577 events - names, dates, descriptions. This is the part that cannot be rebuilt from anything else. A hash proves a file is unaltered, but it will not tell you what the event was called.
- **Artwork**, 194 GB - the event images themselves.
- **Thumbnails**, 4.4 GB - 400px renders, enough to browse the whole corpus without pulling the full artwork.

Every file is addressed by its hash and listed in a public registry, so any copy can be checked against the original rather than trusted.

## Content roots

The archive is on IPFS. These roots are the whole of it:

- artwork - `bafybeickz3h6wnxdwsxeoixj3pxk24fnczqeymuqh7h7xge7iaownd4b3i`
- metadata - `bafybeiglmxn6ta7bt76p5ed6mnmek4m4uvmftonxjqe6zemp6j73qzwwuu`
- thumbnails - `bafybeia3q5zqbjdhzdmdny3vzoc6gddjn4tsi22p6jd2lsx3rcm362gin4`
- animated re-encodes - `bafybeibwodt254seymig7cbemxwgj4e5lztui3ccz6ypboafyl5i2ptn4a`

If you run IPFS, pinning the metadata root is the single most useful thing you can do. It is 145 MB and it is the copy that does not depend on anyone's server staying up.

## The site

A static shell - `index.html`, `app.js`, `style.css` - about 10 KB gzipped, no build step, no framework, no webfont. It browses newest-first, searches by name or id with a year filter, and shows one page per event at `/event/<id>`.

All the heavy bytes live behind `https://data.everybadge.org` (an R2 bucket, same key layout as the corpus): a browse index in 1,000-event shards, `cindex/` for artwork hashes, `meta/` for the original metadata, `thumb/` for 400px WebPs. If that host does not answer, the same paths are tried under the IPFS roots above through public gateways - the site is a convenience over an archive that exists without it.

Deployed as a Cloudflare Worker with static assets (`wrangler.jsonc`, `worker.js`), with Netlify as a second host from the same repo (`netlify.toml`). `_headers` carries a strict CSP.

Local development: `python3 ~/Projects/everybadge-build/devserve.py` serves the shell against a local copy of the index.

## Two things the data will tell you that look like bugs

Two events have no name in POAP's own metadata (81 and 146588); they show as "(untitled)". Ninety-five events carry years outside 2018-2026 - organiser typos like 985 and 3463 - and are shown as entered. Nothing in the archive is corrected.

## Security

Report issues at https://github.com/mdws-org/everybadge/issues. There is nothing to log into and nothing is collected; the surface is the static shell and the CSP.
