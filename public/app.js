/* everybadge.org - browse, search and view the POAP archive.
 *
 * Plain script, no framework, no build step. Everything heavy lives behind
 * DATA; this file is meant to stay small enough that a mirror re-syncing it
 * costs nothing.
 *
 * Data layout, served from R2 at DATA. The JSON tiers live under /v1/: their
 * shapes are a contract the moment a second client (the iOS app) exists, and a
 * version segment is the only way to change a shape without breaking every
 * deployed reader. Thumbnails are content-addressed and have no shape to
 * break, so they stay unversioned.
 *   v1/index/browse/<n>.json  [[id, name, year, anim, country, city, mints], ...]
 *                             for ids n*1000..+999
 *   v1/index/search.json      every event as the same row - 3.4 MB gz
 *   v1/index/manifest.json    counts, shard list, year histogram, place
 *                             tables, mint read date, anim extensions,
 *                             description shard list, file sha256s
 *   v1/index/desc/<key>.json  {"<id>": "description"}; key is the year
 *                             (2018..2026), `other` for a year outside that
 *                             era, `unknown` for none. Read only by the
 *                             description search
 *   v1/cindex/<n>.json        {"<id>": [sha256, typeCode], ...} same shard bounds
 *   v1/meta/<id>.json         the metadata POAP served for the event
 *   thumb/<xx>/<sha>.webp     400px thumbnail; xx = first two hex of sha
 *   anim/<id>.<ext>           animated re-encode; ext (mp4 or webp) from
 *                             manifest.anim_ext
 *
 * In a row, country and city index manifest.countries and manifest.cities
 * (-1 = none), and mints is the total POAP's Compass reported on
 * manifest.mints_read (0 where it had no row).
 *
 * A grid tile needs browse (name) + cindex (sha -> thumbnail path). They are
 * separate files on purpose: the sha is 64 hex chars per event and would
 * dominate the browse index, and cindex already exists for the poap-saver.
 *
 * `anim` means the corpus holds an animated re-encode at anim/<id>. Its
 * absence does NOT mean the artwork is still - 40,230 events are GIFs and
 * frame counts are unknowable without the full blob. The UI says "animated"
 * only on an event page that is showing the re-encode.
 *
 * Fallback: if DATA does not answer for a thumbnail, animation or metadata
 * file, the same path is tried under the IPFS roots through public gateways.
 * That is the point of content addressing - the site is a convenience over an
 * archive that exists without it. Only cindex and the index files (browse,
 * search, desc) have no IPFS twin: they are lookup structures, and the roots
 * printed on the page are enough to rebuild them.
 */
(function () {
    'use strict';

    /* The one thing that changes between local testing and production. A dev
       server sets data-data on this script's own <script> tag; nothing else in
       the file knows where the data lives. An attribute rather than an inline
       script, so the dev page can run under the production CSP (script-src
       'self') and a CSP regression cannot hide behind the dev server. */
    var DATA = (document.currentScript && document.currentScript.dataset.data) || 'https://data.everybadge.org';
    var V = DATA + '/v1';                // versioned JSON tiers; thumbnails stay at DATA
    var SHARD = 1000;
    var PAGE = 60;                       // tiles per "page" of the home grid
    var CAP = 600;                       // most tiles one search draws
    var ROOTS = {
        meta:  'bafybeiglmxn6ta7bt76p5ed6mnmek4m4uvmftonxjqe6zemp6j73qzwwuu',
        thumb: 'bafybeia3q5zqbjdhzdmdny3vzoc6gddjn4tsi22p6jd2lsx3rcm362gin4',
        blob:  'bafybeickz3h6wnxdwsxeoixj3pxk24fnczqeymuqh7h7xge7iaownd4b3i',
        anim:  'bafybeibwodt254seymig7cbemxwgj4e5lztui3ccz6ypboafyl5i2ptn4a',
    };
    /* Public gateways that answer a BROWSER. Tested 2026-08-18: ipfs.io,
       dweb.link, gateway.ipfs.io, w3s.link and nftstorage.link all return 403
       to a browser User-Agent (200 to curl - a bot rule, not a pinning
       problem), and cloudflare-ipfs.com is gone. These two return 200 with
       ACAO:* from a page. Re-test before adding or reordering; gateway rules
       change without notice. */
    var GATEWAYS = ['https://gateway.pinata.cloud/ipfs/', 'https://4everland.io/ipfs/'];
    var EXT = { p: 'png', g: 'gif', j: 'jpg', w: 'webp' };
    /* A cindex entry is [sha256, typeCode], read from the data host. Both go
       into URLs and the page, so neither is trusted as given: a sha must be
       64 hex characters, and a type code must be one of EXT's own keys -
       EXT['constructor'] is a function, not a missing value. */
    function artwork(entry) {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !/^[0-9a-f]{64}$/.test(entry[0])) return null;
        var ext = Object.prototype.hasOwnProperty.call(EXT, entry[1]) ? EXT[entry[1]] : 'bin';
        return { sha: entry[0], ext: ext };
    }

    var $ = function (id) { return document.getElementById(id); };
    var grid = $('grid'), status = $('status'), more = $('more');
    var q = $('q'), yearSel = $('year'), countrySel = $('country'), sortSel = $('sort'), descBox = $('in-desc');

    /* --------------------------------------------------------- data access */
    var cache = {};                       // url -> Promise<any>
    function getJSON(url) {
        if (!cache[url]) {
            cache[url] = fetch(url).then(function (r) {
                if (!r.ok) throw new Error(r.status + ' ' + url);
                return r.json();
            });
            cache[url].catch(function () { delete cache[url]; });
        }
        return cache[url];
    }
    function shard(n)  { return getJSON(V + '/index/browse/' + n + '.json'); }
    function cindex(n) { return getJSON(V + '/cindex/' + n + '.json'); }
    /* A function, not a captured promise. getJSON drops a rejected promise so a
       retry can succeed, but holding one in a module-level variable defeats that:
       a single transient failure at load would reject every later use forever. */
    function manifest() { return getJSON(V + '/index/manifest.json'); }
    /* The manifest once it has arrived, for the place tables tile() reads;
       null until then. */
    var M = null;
    function gotManifest(m) {
        M = m;
        fillYears(m.years);
        fillCountries(m);
    }
    function descShard(key) { return getJSON(V + '/index/desc/' + key + '.json'); }
    var searchP = null;                   // loaded on first keystroke, not on page load
    function searchIndex() {
        if (!searchP) {
            status.textContent = 'Loading the full index (about 3 MB, once)…';
            searchP = getJSON(V + '/index/search.json').then(function (rows) {
                status.textContent = '';
                return rows;
            }, function (e) {
                status.textContent = 'The search index did not load. ' + e.message;
                searchP = null;
                throw e;
            });
        }
        return searchP;
    }
    function thumbURL(sha)     { return DATA + '/thumb/' + sha.slice(0, 2) + '/' + sha + '.webp'; }
    function thumbIPFS(sha, i) { return GATEWAYS[i] + ROOTS.thumb + '/' + sha.slice(0, 2) + '/' + sha + '.webp'; }
    function metaURL(id)       { return V + '/meta/' + id + '.json'; }
    function metaIPFS(id, i)   { return GATEWAYS[i] + ROOTS.meta + '/' + id + '.json'; }
    function animURL(id, ext)     { return DATA + '/anim/' + id + '.' + ext; }
    function animIPFS(id, ext, i) { return GATEWAYS[i] + ROOTS.anim + '/' + id + '.' + ext; }

    /* Metadata with gateway fallback. Every source is tried before giving up,
       and "no such event" (404 from DATA) is not retried anywhere - a gap is a
       gap. Resolves to {meta, via}: `via` is the gateway that answered, or null
       when DATA did, because a gateway's copy is shown unchecked and the page
       says so. */
    function getMeta(id) {
        return fetch(metaURL(id)).then(function (r) {
            if (r.status === 404) return { meta: null, via: null };
            if (!r.ok) throw new Error(r.status);
            return r.json().then(function (meta) { return { meta: meta, via: null }; });
        }).catch(function () {
            var i = 0;
            function next() {
                if (i >= GATEWAYS.length) throw new Error('unreachable');
                var gateway = GATEWAYS[i];
                return fetch(metaIPFS(id, i++)).then(function (r) {
                    if (!r.ok) return next();
                    return r.json().then(function (meta) { return { meta: meta, via: gateway }; });
                }, next);
            }
            return next();
        });
    }

    /* --------------------------------------------------------- rendering */
    /* Remote strings become hrefs below. eventURL and image_url are free text
       an organiser typed into POAP's form; a javascript: or data: value would
       execute on this origin, and the only thing stopping it today is the CSP -
       a single header that is absent on any IPFS or gateway-served copy of this
       page. Check the scheme here so the behaviour does not depend on it. */
    function safeHref(u) {
        try {
            var proto = new URL(u, location.href).protocol;
            return (proto === 'https:' || proto === 'http:') ? u : null;
        } catch (e) { return null; }
    }

    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }
    /* Image with a fallback chain baked into onerror: DATA, then each gateway,
       then the "no artwork" state. The chain lives on the element so a tile
       scrolled past never runs it. */
    function thumbImg(sha, alt) {
        var img = el('img');
        img.alt = alt;
        img.loading = 'lazy';
        img.decoding = 'async';
        var step = 0;
        img.onerror = function () {
            if (step < GATEWAYS.length) { img.src = thumbIPFS(sha, step++); return; }
            img.onerror = null;
            /* Fall through to the same "no artwork" affordance an event with no
               artwork gets - an empty circle read as neither. */
            if (img.parentNode) img.parentNode.className += ' none';
            img.remove();
        };
        img.src = thumbURL(sha);
        return img;
    }
    /* "City, Country" for a row, from the manifest's place tables; '' when
       the row has neither or the manifest has not arrived. */
    function placeOf(row) {
        if (!M || !Array.isArray(M.cities) || !Array.isArray(M.countries)) return '';
        var city = row[5] >= 0 ? M.cities[row[5]] : '', country = row[4] >= 0 ? M.countries[row[4]] : '';
        return [city, country].filter(Boolean).join(', ');
    }
    function tile(row, ci) {
        var id = row[0], name = row[1], year = row[2], mints = row[6];
        var a = el('a', 'card');
        a.href = '/event/' + id;
        var th = el('div', 'th');
        var art = artwork(ci && ci[String(id)]);
        if (art) th.appendChild(thumbImg(art.sha, ''));
        else th.className += ' none';
        a.appendChild(th);
        var nm = el('span', name ? 'nm' : 'nm untitled', name || '(untitled)');
        var place = placeOf(row);
        nm.title = (name || 'This event has no name in the archive') + (place ? ' · ' + place : '');
        a.appendChild(nm);
        a.appendChild(el('span', 'yr', '#' + id + (year ? ' · ' + year : '') + (mints > 0 ? ' · ' + fmt(mints) + ' minted' : '')));
        return a;
    }
    function fmt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
    var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                  'August', 'September', 'October', 'November', 'December'];
    /* '2026-10-19' -> '19 October 2026', the way the page writes its own
       dates; '' for anything that is not a date in that form. */
    function longDate(s) {
        var d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
        if (!d || d[2] < 1 || d[2] > 12) return '';
        return Number(d[3]) + ' ' + MONTHS[d[2] - 1] + ' ' + d[1];
    }
    /* Move keyboard focus to a heading after an in-page view switch. Hiding
       the element that holds focus (a tile link, the back link) drops focus to
       <body>, and the next Tab restarts from the top of the document. Only on
       navigation the reader initiated - a cold load must not steal focus. */
    var navigated = false;
    function focusTo(elm) {
        if (!navigated || !elm) return;
        if (!elm.hasAttribute('tabindex')) elm.setAttribute('tabindex', '-1');
        try { elm.focus({ preventScroll: true }); } catch (e) { elm.focus(); }
    }

    /* --------------------------------------------------------- home grid */
    /* Newest first: shard numbers descend, rows within a shard descend. The
       cursor is (shardNo, offset-from-end) so "Show more" is stateless. */
    var home = { shards: null, si: 0, off: 0, busy: false };
    var homeFill = null;          // promise for the batch currently filling
    /* Same class of bug renderHits had: these two also build DOM across async
       fetches and append later. A search landing mid-fill would drop 60 home
       tiles under the results; a fast A -> back -> B would let A's metadata
       overwrite B's page. */
    var homeGen = 0, evGen = 0;
    function homeReset() {
        /* Claim the grid from anything still filling it: a search whose
           thumbnail lookups have not come back (renderGen), and a "Show more"
           batch still fetching (homeGen). That batch held home.busy, which made
           the fill below return at once and left the grid blank. */
        homeGen++; renderGen++;
        home.busy = false;
        grid.textContent = '';
        home.si = 0; home.off = 0;
        more.hidden = true;
        return manifest().then(function (m) {
            home.shards = m.shards.slice().reverse();
            $('count').textContent = fmt(m.events);
            gotManifest(m);
            homeFill = homeMore();
            return homeFill;
        }, function (e) {
            status.textContent = 'The archive index did not load. ' + e.message;
        });
    }
    function homeMore(userAsked) {
        if (home.busy || !home.shards || home.si >= home.shards.length) return;
        var gen = ++homeGen;
        home.busy = true; more.disabled = true;
        var want = PAGE, frag = document.createDocumentFragment();
        function step() {
            /* A search or reset owns the grid now. Checked before anything is
               touched: home.* and the button belong to whoever claimed it. */
            if (gen !== homeGen) return;
            if (want <= 0 || home.si >= home.shards.length) {
                var firstNew = frag.firstChild;
                grid.appendChild(frag);
                more.hidden = home.si >= home.shards.length;
                more.disabled = false; home.busy = false;
                /* New tiles are appended ABOVE the button, so a reader who
                   clicked it while it sat at the top of the viewport sees
                   nothing change - the additions are off-screen behind them.
                   Bring the first new tile into view, but only when this was a
                   real click rather than the initial fill. */
                if (userAsked && firstNew && firstNew.scrollIntoView) {
                    firstNew.scrollIntoView({ block: 'start' });
                }
                return;
            }
            var n = home.shards[home.si];
            return Promise.all([shard(n), cindex(n).catch(function () { return null; })])
                .then(function (r) {
                    if (gen !== homeGen) return;
                    var rows = r[0], ci = r[1];
                    var end = rows.length - home.off;
                    var start = Math.max(0, end - want);
                    for (var i = end - 1; i >= start; i--) frag.appendChild(tile(rows[i], ci));
                    want -= (end - start);
                    home.off += (end - start);
                    if (start === 0) { home.si++; home.off = 0; }
                    return step();
                }, function (e) {
                    if (gen !== homeGen) return;
                    /* Keep what was already collected and do NOT leave the cursor
                       past the shards that succeeded - discarding frag here made
                       those events unreachable with nothing to show it. */
                    grid.appendChild(frag);
                    status.textContent = 'Could not load part of the archive. ' + e.message;
                    more.hidden = false;
                    more.disabled = false; home.busy = false;
                });
        }
        return step();
    }
    var yearsFilled = false;
    function fillYears(hist) {
        if (yearsFilled) return;
        yearsFilled = true;
        /* Only years inside the plausible era get their own option; the junk
           years (985, 3463…) are real data but not a facet anyone wants. */
        var ys = Object.keys(hist).map(Number).filter(function (y) { return y >= 2018 && y <= 2026; }).sort(function (a, b) { return b - a; });
        ys.forEach(function (y) {
            var o = el('option', null, y + '  (' + fmt(hist[y]) + ')');
            o.value = y;
            yearSel.appendChild(o);
        });
    }
    /* Every country string the index holds, most events first. The option
       value is the name itself, not its table index: the name is what goes
       into a shared link, and a rebuild that reorders the table must not
       turn an old link into a different country. */
    var countriesFilled = false;
    function fillCountries(m) {
        if (countriesFilled || !Array.isArray(m.countries) || !Array.isArray(m.country_counts)) return;
        countriesFilled = true;
        var counts = m.country_counts, byCount = m.countries.map(function (_, i) { return i; });
        byCount.sort(function (a, b) { return (counts[b] - counts[a]) || (a - b); });
        var frag = document.createDocumentFragment();
        byCount.forEach(function (i) {
            var o = el('option', null, m.countries[i] + '  (' + fmt(counts[i]) + ')');
            o.value = m.countries[i];
            frag.appendChild(o);
        });
        countrySel.appendChild(frag);
    }

    /* --------------------------------------------------------- search */
    var searchTimer = null, lastQuery = '';     // '' is the home grid's key
    /* A row's name can be missing (tile() already allows for it), and a
       missing one must not end the search. */
    function norm(s) { return String(s == null ? '' : s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, ''); }
    function plural(n, one, many) { return n === 1 ? one : many; }

    /* The query as the form states it. */
    function readQuery() {
        return {
            text: q.value.trim(),
            year: yearSel.value,
            country: countrySel.value,
            sort: sortSel.value === 'mints' ? 'mints' : '',
            inDesc: descBox.checked
        };
    }
    /* The address-bar form of a query, '/' when nothing is set. Each part is
       carried only when it differs from the default. */
    function searchURL(s) {
        if (!s.text && !s.year && !s.country && !s.sort && !s.inDesc) return '/';
        return '/?q=' + encodeURIComponent(s.text) +
            (s.year ? '&y=' + encodeURIComponent(s.year) : '') +
            (s.country ? '&c=' + encodeURIComponent(s.country) : '') +
            (s.sort ? '&s=' + s.sort : '') +
            (s.inDesc ? '&d=1' : '');
    }
    /* Display order: newest (highest id) first, or most minted first with
       the newer event ahead on a tie. */
    function order(sort) {
        return sort === 'mints'
            ? function (a, b) { return ((b[6] || 0) - (a[6] || 0)) || (b[0] - a[0]); }
            : function (a, b) { return b[0] - a[0]; };
    }

    /* The place tables normalised once per manifest, so a term is matched
       against city and country the same way as against the name. */
    var placeNorm = null, placeNormFor = null;
    /* For each term, one flag per country and one per city: does that
       normalised string contain the term. A row's place then costs two
       array reads per term instead of two string searches. Null without a
       manifest, and the search matches names alone. */
    function placeHits(terms, m) {
        if (!m || !Array.isArray(m.countries) || !Array.isArray(m.cities)) return null;
        if (placeNormFor !== m) {
            placeNorm = { c: m.countries.map(norm), ci: m.cities.map(norm) };
            placeNormFor = m;
        }
        var p = placeNorm;
        return terms.map(function (t) {
            var c = new Uint8Array(p.c.length), ci = new Uint8Array(p.ci.length), i;
            for (i = 0; i < p.c.length; i++) if (p.c[i].indexOf(t) !== -1) c[i] = 1;
            for (i = 0; i < p.ci.length; i++) if (p.ci[i].indexOf(t) !== -1) ci[i] = 1;
            return { c: c, ci: ci };
        });
    }
    /* Index -1 (no place) reads as undefined from the typed array. */
    function placeHas(s, t, r) {
        var p = s.places && s.places[t];
        return !!p && (p.c[r[4]] === 1 || p.ci[r[5]] === 1);
    }

    /* Walk the rows newest first, keeping those that pass the facets and
       `test`. Newest-first stops once `room` rows are kept; most-minted has
       to see every match before it can pick the top `room`. `total` is how
       many matched, which is the full count only when sorting by mints. */
    function scan(rows, s, test, room) {
        var kept = [], mints = s.sort === 'mints';
        for (var i = rows.length - 1; i >= 0; i--) {
            if (!mints && kept.length >= room) break;
            var r = rows[i];
            if (s.y !== null && r[2] !== s.y) continue;
            if (s.c !== null && r[4] !== s.c) continue;
            if (test(r, i)) kept.push(r);
        }
        var total = kept.length;
        if (mints) kept = kept.sort(order('mints')).slice(0, room);
        return { hits: kept, total: total };
    }
    /* The exact pass: every term is a substring of the normalised name, city
       or country. */
    function exactTest(s) {
        var terms = s.terms;
        return function (r) {
            if (!terms.length) return true;
            var n = norm(r[1]);
            for (var t = 0; t < terms.length; t++) {
                if (n.indexOf(terms[t]) === -1 && !placeHas(s, t, r)) return false;
            }
            return true;
        };
    }

    /* Typo tolerance, tried when the exact pass finds fewer than
       FUZZY_BELOW events. A term of FUZZY_MIN to 6 characters matches a name
       token within edit distance 1, a longer term within 2; shorter terms
       still have to match exactly. */
    var FUZZY_BELOW = 10, FUZZY_MIN = 4;
    /* Unicode property escapes where the engine has them, so names in other
       scripts split on their own letters; otherwise everything outside ASCII
       counts as a letter. */
    var NONLETTER = (function () {
        try { return new RegExp('[^\\p{L}\\p{M}]+', 'u'); } catch (e) { return /[^a-z\u0080-\uffff]+/; }
    })();
    /* Name tokens parallel to the search rows: each row's normalised name
       split on non-letters, built on the first fuzzy pass and kept. Tokens
       under 3 characters are left out, since no term long enough to be tried
       comes within reach of one. */
    var nameTokens = null, nameTokensFor = null;
    function tokenRows(rows) {
        if (nameTokensFor !== rows) {
            nameTokens = new Array(rows.length);
            for (var i = 0; i < rows.length; i++) {
                var parts = norm(rows[i][1]).split(NONLETTER), keep = [];
                for (var k = 0; k < parts.length; k++) if (parts[k].length >= 3) keep.push(parts[k]);
                nameTokens[i] = keep;
            }
            nameTokensFor = rows;
        }
        return nameTokens;
    }
    /* Damerau-Levenshtein distance in its optimal-string-alignment form
       (swapping two adjacent characters is one edit), answered only as
       "within max or not": a length difference over max returns before any
       work, and a table row with no cell within max ends it early. */
    var dl0 = [], dl1 = [], dl2 = [];
    function withinDL(a, b, max) {
        var la = a.length, lb = b.length;
        if (la - lb > max || lb - la > max) return false;
        var p2 = dl0, p1 = dl1, cur = dl2, swap, i, j;
        for (j = 0; j <= lb; j++) p1[j] = j;
        for (i = 1; i <= la; i++) {
            var ca = a.charCodeAt(i - 1), best = cur[0] = i;
            for (j = 1; j <= lb; j++) {
                var cb = b.charCodeAt(j - 1);
                var v = p1[j - 1] + (ca === cb ? 0 : 1);
                if (p1[j] + 1 < v) v = p1[j] + 1;
                if (cur[j - 1] + 1 < v) v = cur[j - 1] + 1;
                if (i > 1 && j > 1 && ca === b.charCodeAt(j - 2) && cb === a.charCodeAt(i - 2) && p2[j - 2] + 1 < v) v = p2[j - 2] + 1;
                cur[j] = v;
                if (v < best) best = v;
            }
            if (best > max) return false;
            swap = p2; p2 = p1; p1 = cur; cur = swap;
        }
        return p1[lb] <= max;
    }
    /* The fuzzy pass: a row qualifies when every term matches somewhere -
       near a name token, or exactly as in the exact pass - and at least one
       only through a near token. A row where every term matched exactly is
       an exact hit already, and `s.seen` skips it. Each term remembers its
       verdict per distinct token, so a token that recurs across thousands of
       names ("meetup", "community") is measured once. */
    function fuzzyTest(s, rows) {
        var toks = tokenRows(rows), terms = s.terms;
        var memo = terms.map(function (t) { return t.length >= FUZZY_MIN ? Object.create(null) : null; });
        var maxd = terms.map(function (t) { return t.length >= 7 ? 2 : 1; });
        var near = [];
        return function (r, i) {
            if (s.seen[r[0]]) return false;
            var tk = toks[i], any = false, t, k;
            for (t = 0; t < terms.length; t++) {
                near[t] = false;
                if (!memo[t]) continue;
                for (k = 0; k < tk.length; k++) {
                    var v = memo[t][tk[k]];
                    if (v === undefined) v = memo[t][tk[k]] = withinDL(terms[t], tk[k], maxd[t]);
                    if (v) { near[t] = any = true; break; }
                }
            }
            if (!any) return false;
            var n = null;
            for (t = 0; t < terms.length; t++) {
                if (near[t] || placeHas(s, t, r)) continue;
                if (n === null) n = norm(r[1]);
                if (n.indexOf(terms[t]) === -1) return false;
            }
            return true;
        };
    }

    /* Every hit for the query in display order: the exact matches, then the
       fuzzy pass's close matches when the exact pass found few. Records the
       drawn ids in s.seen for the description pass. */
    function findHits(rows, m, s) {
        s.terms = norm(s.text).split(/\s+/).filter(Boolean);
        s.y = s.year ? Number(s.year) : null;
        /* A country the table does not hold matches nothing, rather than
           becoming -1 and matching every event without a country. */
        s.c = null;
        if (s.country) {
            var ci = m && Array.isArray(m.countries) ? m.countries.indexOf(s.country) : -1;
            s.c = ci >= 0 ? ci : -2;
        }
        s.seen = Object.create(null);
        var res = { hits: [], exact: 0, total: 0, close: 0, closeTotal: 0, closeCapped: false, idLookup: false };
        if (/^\d+$/.test(s.text) && s.y === null && s.c === null) {
            var id = Number(s.text);
            var hits = rows.filter(function (r) { return r[0] === id; });
            if (!hits.length) hits = rows.filter(function (r) { return String(r[0]).indexOf(s.text) === 0; }).slice(0, 200);
            if (s.sort === 'mints') hits.sort(order('mints'));
            res.hits = hits; res.exact = res.total = hits.length; res.idLookup = true;
            return res;
        }
        s.places = s.terms.length ? placeHits(s.terms, m) : null;
        var ex = scan(rows, s, exactTest(s), CAP);
        ex.hits.forEach(function (r) { s.seen[r[0]] = 1; });
        res.hits = ex.hits; res.exact = ex.hits.length; res.total = ex.total;
        if (ex.total < FUZZY_BELOW && s.terms.some(function (t) { return t.length >= FUZZY_MIN; })) {
            var room = CAP - ex.hits.length;
            var fz = scan(rows, s, fuzzyTest(s, rows), room);
            fz.hits.forEach(function (r) { s.seen[r[0]] = 1; });
            res.hits = ex.hits.concat(fz.hits);
            res.close = fz.hits.length; res.closeTotal = fz.total;
            res.closeCapped = s.sort === 'mints' ? fz.total > room : fz.hits.length >= room;
        }
        return res;
    }
    /* The status line for the name and place pass. `more` says a description
       pass follows, so an empty result is qualified rather than final. */
    function baseStatus(s, res, more) {
        var what = s.text ? '"' + s.text + '"' : [s.year, s.country].filter(Boolean).join(', ');
        var mints = s.sort === 'mints', line, capped = false;
        if (res.exact) {
            var n = mints ? res.total : res.exact;
            capped = mints ? res.total > CAP : res.exact >= CAP;
            line = what
                ? fmt(n) + (capped && !mints ? '+' : '') + plural(n, ' event matches ', ' events match ') + what
                : 'All ' + fmt(n) + ' events';
        } else if (res.close) {
            line = '0 exact matches for ' + what;
        } else {
            return 'Nothing matches ' + what + (more ? ' by name or place' : '.');
        }
        if (res.close) {
            var c = mints ? res.closeTotal : res.close;
            capped = res.closeCapped;
            line += ' and ' + fmt(c) + (capped && !mints ? '+' : '') + plural(c, ' close match', ' close matches');
        }
        if (capped) line += ' - showing the ' + (mints ? fmt(CAP) + ' most minted' : 'newest ' + fmt(CAP));
        return line;
    }

    function runSearch() {
        var s = readQuery();
        /* Most minted is a search even with nothing typed: it ranks the whole
           index. */
        var home = !s.text && !s.year && !s.country && !s.sort;
        /* The address bar follows every change to the form, the checkbox
           included, even when the grid has nothing to redraw. */
        history.replaceState(null, '', searchURL(s));
        /* The home grid is one state whatever the checkbox says, so its key
           is '' and ticking the box over it redraws nothing. */
        var key = home ? '' : [s.text, s.year, s.country, s.sort, s.inDesc ? 'd' : ''].join('\n');
        if (key === lastQuery) return;
        lastQuery = key;
        if (home) { status.textContent = ''; return homeReset(); }
        Promise.all([searchIndex(), manifest().catch(function () { return null; })]).then(function (r) {
            /* The box changed while the index was loading: this result answers
               a question nobody is asking any more, and drawing it would wipe
               the home grid (or a newer search) that now owns the page. */
            if (key !== lastQuery) return;
            var rows = r[0], m = r[1];
            if (m) gotManifest(m);
            var res = findHits(rows, m, s);
            var desc = !!m && s.inDesc && s.terms.length > 0 && !res.idLookup && res.hits.length < CAP;
            var gen = claimGrid();
            var base = baseStatus(s, res, desc);
            status.textContent = base;
            var drawn = drawHits(res.hits, gen);
            if (desc) {
                return drawn.then(function (ok) {
                    if (ok) return searchDescriptions(gen, key, rows, m, s, res, base);
                });
            }
        }).catch(function (e) {
            /* searchIndex() has already said when the index did not load; any
               other failure gets a sentence too, rather than a page that
               silently shows the previous results. */
            if (searchP && key === lastQuery) status.textContent = 'The search could not be completed. ' + (e && e.message ? e.message : '');
        });
    }

    var renderGen = 0;
    /* Each search render claims a generation. The cindex fetches and the
       description pass are async, so without this an older search's tiles
       land AFTER a newer search has cleared the grid, and the grid shows both
       result sets at once. */
    function claimGrid() {
        homeGen++;                          // cancel any home fill still in flight
        grid.textContent = '';
        more.hidden = true;
        return ++renderGen;
    }
    /* Bounded fan-out. A search for "gm" spans 155 shards, which as a bare
       Promise.all is ~1 MB over 155 simultaneous streams against the data
       origin - this site's own worst load generator. Six at a time costs a
       few hundred ms on the widest searches and nothing on typical ones. */
    function pooled(keys, limit, fn) {
        var out = new Array(keys.length), i = 0;
        function worker() {
            if (i >= keys.length) return Promise.resolve();
            var k = i++;
            return Promise.resolve(fn(keys[k])).then(function (v) { out[k] = v; }, function () { out[k] = null; })
                .then(worker);
        }
        var runners = [];
        for (var w = 0; w < Math.min(limit, keys.length); w++) runners.push(worker());
        return Promise.all(runners).then(function () { return out; });
    }
    /* Tiles for `hits` in hit order, once the cindex shards they need have
       arrived; grouped by shard so each file is fetched once. Null when a
       newer render has claimed the grid in the meantime. */
    function tilesFor(hits, gen) {
        var byShard = {};
        hits.forEach(function (r) { (byShard[Math.floor(r[0] / SHARD)] = byShard[Math.floor(r[0] / SHARD)] || []).push(r); });
        var ns = Object.keys(byShard);
        return pooled(ns, 6, function (n) { return cindex(n); }).then(function (cis) {
            if (gen !== renderGen) return null;      // a newer search owns the grid now
            var ciBy = {};
            ns.forEach(function (n, i) { ciBy[n] = cis[i]; });
            return hits.map(function (r) { return tile(r, ciBy[Math.floor(r[0] / SHARD)]); });
        });
    }
    /* Resolves true once the tiles are in the grid, false if superseded. */
    function drawHits(hits, gen) {
        return tilesFor(hits, gen).then(function (tiles) {
            if (!tiles) return false;
            var frag = document.createDocumentFragment();
            tiles.forEach(function (t) { frag.appendChild(t); });
            grid.appendChild(frag);
            return true;
        });
    }

    /* The description shards a query reads, in order: the year facet's shard
       alone, or every year newest first, then `other`, then `unknown`. Only
       keys the manifest lists with at least one description. */
    function descKeys(m, s) {
        var have = m.desc && m.desc.shards ? m.desc.shards : {};
        var keys = Object.keys(have).filter(function (k) { return have[k] > 0; });
        if (s.y !== null) return keys.indexOf(String(s.y)) !== -1 ? [String(s.y)] : [];
        var years = keys.filter(function (k) { return /^\d{4}$/.test(k); }).sort(function (a, b) { return b - a; });
        return years.concat(['other', 'unknown'].filter(function (k) { return keys.indexOf(k) !== -1; }));
    }
    /* search.json is in ascending id order (the newest-first scan relies on
       that too), so finding a row by id is a binary search. */
    function rowById(rows, id) {
        var lo = 0, hi = rows.length - 1;
        while (lo <= hi) {
            var mid = (lo + hi) >> 1, v = rows[mid][0];
            if (v === id) return rows[mid];
            if (v < id) lo = mid + 1; else hi = mid - 1;
        }
        return null;
    }
    /* The rows whose description holds every term, inside the facets and not
       already drawn by the name and place pass. */
    function matchDescriptions(d, rows, s) {
        var out = [];
        for (var id in d) {
            if (!Object.prototype.hasOwnProperty.call(d, id) || s.seen[id]) continue;
            var r = rowById(rows, Number(id));
            if (!r || (s.y !== null && r[2] !== s.y) || (s.c !== null && r[4] !== s.c)) continue;
            var text = norm(d[id]), ok = true;
            for (var t = 0; t < s.terms.length && ok; t++) ok = text.indexOf(s.terms[t]) !== -1;
            if (ok) out.push(r);
        }
        return out;
    }
    /* The description pass, after the name and place tiles are drawn. One
       shard at a time, so matches appear as each is searched and the status
       line names the shards reached so far. Stops at CAP tiles in all, or as
       soon as a newer search or the home grid claims the page. Its tiles go
       after the name hits, in display order among themselves. */
    function searchDescriptions(gen, key, rows, m, s, res, base) {
        var keys = descKeys(m, s), done = [], failed = [], found = 0, cut = false;
        var room = CAP - res.hits.length, cmp = order(s.sort), drawn = [], drawnEls = [];
        function current() { return gen === renderGen && key === lastQuery; }
        function insert(r, t) {
            var lo = 0, hi = drawn.length;
            while (lo < hi) {
                var mid = (lo + hi) >> 1;
                if (cmp(drawn[mid], r) <= 0) lo = mid + 1; else hi = mid;
            }
            grid.insertBefore(t, drawnEls[lo] || null);
            drawn.splice(lo, 0, r);
            drawnEls.splice(lo, 0, t);
        }
        function finish(k) {
            var stopped = found >= room && (cut || k < keys.length);
            var clause = found
                ? fmt(found) + (res.hits.length ? ' more' : '') + ' in descriptions' + (stopped ? ' - stopped at ' + fmt(CAP) : '')
                : 'none in descriptions';
            if (failed.length) clause += ' (' + failed.join(', ') + ' did not load)';
            status.textContent = base + '; ' + clause;
        }
        function next(k) {
            if (!current()) return;
            if (k >= keys.length || found >= room) return finish(k);
            done.push(keys[k]);
            status.textContent = base + '; searching descriptions: ' + done.join(', ') + ' …';
            return descShard(keys[k]).then(function (d) {
                if (!current()) return;
                var batch = matchDescriptions(d, rows, s).sort(cmp);
                if (batch.length > room - found) { batch = batch.slice(0, room - found); cut = true; }
                found += batch.length;
                return tilesFor(batch, gen).then(function (tiles) {
                    if (!tiles || !current()) return;
                    tiles.forEach(function (t, i) { insert(batch[i], t); });
                    return next(k + 1);
                });
            }, function () {
                failed.push(keys[k]);
                return next(k + 1);
            });
        }
        return next(0);
    }
    q.addEventListener('input', function () { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 180); });
    yearSel.addEventListener('change', runSearch);
    countrySel.addEventListener('change', runSearch);
    sortSel.addEventListener('change', runSearch);
    descBox.addEventListener('change', runSearch);
    $('search').addEventListener('submit', function (e) { e.preventDefault(); clearTimeout(searchTimer); runSearch(); });
    more.addEventListener('click', function () { homeMore(true); });

    /* --------------------------------------------------------- event page */
    /* #ev-img showing the still thumbnail: DATA, then each gateway. */
    function stillImg(img, sha, alt) {
        var step = 0;
        img.alt = alt;
        img.onerror = function () {
            if (step < GATEWAYS.length) { img.src = thumbIPFS(sha, step++); return; }
            img.onerror = null; img.alt = 'Artwork could not be loaded';
        };
        img.src = thumbURL(sha);
    }
    /* The re-encode's extension when the row says one exists and the
       manifest names a type this page plays; null otherwise. The value is
       remote and goes into a URL, so only the two known types pass. */
    function animExt(id, row, m) {
        if (!row || row[3] !== 1 || !m || !m.anim_ext) return null;
        var ext = Object.prototype.hasOwnProperty.call(m.anim_ext, String(id)) ? m.anim_ext[String(id)] : null;
        return ext === 'mp4' || ext === 'webp' ? ext : null;
    }
    /* The <video> standing in for #ev-img while an mp4 re-encode shows. */
    var evVideo = null;
    function dropVideo() {
        if (!evVideo) return;
        evVideo.onerror = null;
        evVideo.pause();
        evVideo.removeAttribute('src');
        evVideo.load();                     // stops a download still in flight
        evVideo.remove();
        evVideo = null;
        $('ev-img').hidden = false;
    }
    /* The animated re-encode in place of the still: an mp4 in a muted,
       looping <video> that takes #ev-img's place, a webp in #ev-img itself
       (an animated WebP plays in an img). Either tries DATA, then the IPFS
       anim root through each gateway, then calls failed(). */
    function playAnim(id, ext, img, poster, failed) {
        var step = 0;
        function next(media) {
            if (step < GATEWAYS.length) { media.src = animIPFS(id, ext, step++); return; }
            media.onerror = null;
            failed();
        }
        if (ext === 'webp') {
            img.onerror = function () { next(img); };
            img.src = animURL(id, ext);
            return;
        }
        var v = el('video');
        v.muted = true; v.defaultMuted = true;
        v.loop = true; v.autoplay = true; v.playsInline = true;
        v.setAttribute('playsinline', '');
        v.poster = poster;
        v.setAttribute('aria-label', img.alt);
        v.onerror = function () { next(v); };
        v.src = animURL(id, ext);
        img.hidden = true;
        img.parentNode.insertBefore(v, img);
        evVideo = v;
    }
    /* A line in the Artwork row saying which version is showing, with a link
       that swaps to the other. Opens on the animated one. */
    function animSwitch(id, ext, sha, alt, art) {
        var gen = evGen, img = $('ev-img'), line = el('div');
        art.appendChild(line);
        function say(text, label, then) {
            line.textContent = text;
            if (!label) return;
            line.appendChild(document.createTextNode(' · '));
            var a = el('a', null, label);
            a.href = '#';
            /* Handled here, not by the page router, which would take '#' on
               an event path as a navigation to the same event. */
            a.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                if (gen === evGen) then();
            });
            line.appendChild(a);
        }
        function still() {
            dropVideo();
            stillImg(img, sha, alt);
            say('Still thumbnail shown', 'Animated version', animated);
        }
        function animated() {
            dropVideo();
            img.onerror = null;
            say('Animated version shown', 'Still thumbnail', still);
            playAnim(id, ext, img, thumbURL(sha), function () {
                if (gen !== evGen) return;
                dropVideo();
                stillImg(img, sha, alt);
                say('The animated version could not be loaded.');
            });
        }
        animated();
    }
    function showEvent(id) {
        $('home').hidden = true;
        $('about').hidden = true;
        $('mirror').hidden = true;
        $('event').hidden = false;
        document.title = 'Event #' + id + ' - EveryBadge';
        var gen = ++evGen;
        var img = $('ev-img');
        /* Clear the handler BEFORE the src. This element is reused for every
           event, and removing src while a load is in flight fires error, which
           would run the PREVIOUS event's closure and paint its artwork here. */
        img.onerror = null;
        dropVideo();
        img.removeAttribute('src'); img.alt = '';
        $('ev-name').className = '';
        ['ev-year', 'ev-dates', 'ev-place', 'ev-mints', 'ev-desc', 'ev-art', 'ev-links'].forEach(function (k) {
            var dd = $(k), dt = dd.previousElementSibling;
            dd.hidden = false; if (dt) dt.hidden = false;
        });
        ['ev-name', 'ev-id', 'ev-year', 'ev-dates', 'ev-place', 'ev-mints', 'ev-desc', 'ev-art', 'ev-links'].forEach(function (k) { $(k).textContent = ''; });
        $('ev-id').textContent = String(id);
        $('ev-name').textContent = 'Loading…';
        window.scrollTo(0, 0);

        var n = Math.floor(id / SHARD);
        var rowP = shard(n).then(function (rows) {
            for (var i = 0; i < rows.length; i++) if (rows[i][0] === id) return rows[i];
            return null;
        }, function () { return null; });
        var ciP = cindex(n).then(function (ci) { return ci[String(id)] || null; }, function () { return null; });

        /* The manifest carries the mint read date and the re-encode types; a
           page without it still shows everything else. */
        var mP = manifest().catch(function () { return null; });

        Promise.all([rowP, ciP, getMeta(id).catch(function () { return undefined; }), mP]).then(function (r) {
            if (gen !== evGen) return;      // the reader already navigated on
            var row = r[0], entry = r[1], meta = r[2] ? r[2].meta : undefined;
            var via = r[2] ? r[2].via : null, m = r[3];
            if (!row && meta === null) {
                $('ev-name').textContent = 'No event #' + id + ' in the archive';
                focusTo($('ev-name'));
                $('ev-desc').textContent = 'Either it never existed or POAP never stored anything for it. The archive covers ids 1 to 229,341, and 31,752 ids inside that range are gaps like this one.';
                ['ev-year', 'ev-dates', 'ev-place', 'ev-mints', 'ev-art', 'ev-links', 'ev-source'].forEach(function (k) {
                    var dd = $(k), dt = dd.previousElementSibling;
                    dd.hidden = true; if (dt) dt.hidden = true;
                });
                return;
            }
            var name = (meta && meta.name) || (row && row[1]) || '';
            $('ev-name').textContent = name || '(untitled)';
            if (!name) $('ev-name').className = 'untitled';
            document.title = (name || 'Event #' + id) + ' - EveryBadge';
            focusTo($('ev-name'));
            $('ev-year').textContent = (meta && meta.year) || (row && row[2]) || '';
            var asOf = m ? longDate(m.mints_read) : '';
            $('ev-mints').textContent = row && row[6] > 0 ? fmt(row[6]) + (asOf ? ' as of ' + asOf : '') : '';

            if (meta) {
                /* Object.create(null): trait_type is remote. An attribute named
                   __proto__ would otherwise make attr.eventURL resolve through
                   the prototype chain rather than from a real attribute. */
                var attr = Object.create(null);
                (Array.isArray(meta.attributes) ? meta.attributes : []).forEach(function (a) {
                    if (a && typeof a.trait_type === 'string') attr[a.trait_type] = a.value;
                });
                var dates = [attr.startDate, attr.endDate].filter(Boolean);
                $('ev-dates').textContent = dates.length ? (dates[0] === dates[1] ? dates[0] : dates.join(' to ')) : '';
                var place = [attr.city, attr.country].filter(Boolean).join(', ');
                if (attr.virtualEvent === 'true' || attr.virtualEvent === true) place = place ? place + ' (virtual)' : 'Virtual';
                $('ev-place').textContent = place;
                $('ev-desc').textContent = meta.description || '';
                var links = $('ev-links');
                var ev = attr.eventURL && safeHref(attr.eventURL);
                if (ev) { var a1 = el('a', null, 'Event site'); a1.href = ev; a1.rel = 'nofollow noopener'; links.appendChild(a1); }
                /* No "POAP page" link. home_url is keyed on the TOKEN index, not
                   the event, so every one of the 197,577 records carries
                   app.poap.xyz/token/1 - checked across ids 1, 50000, 120345 and
                   190294, all identical. Linking it would send every visitor to
                   DappCon 2018. There is no working per-event replacement:
                   collectors.poap.xyz/drop/<id> 301s to poap.xyz's homepage for
                   any id, valid or not. The data is faithful; the label was not.

                   image_url IS per-event and still resolves (assets.poap.xyz
                   returned 200 on 2026-08-19), so it stays - scheme-checked. */
                var img_ = meta.image_url && safeHref(meta.image_url);
                if (img_) { var a3 = el('a', null, 'Original image URL'); a3.href = img_; a3.rel = 'nofollow noopener'; links.appendChild(a3); }
            } else if (meta === undefined) {
                $('ev-desc').textContent = 'The metadata file could not be reached right now - not from the archive host, not from the IPFS gateways. The name and year above come from the browse index.';
            }
            $('ev-source').textContent = via
                ? 'The archive host did not answer, so this record was read from the public IPFS gateway ' + new URL(via).hostname + '. It has not been checked against the archive.'
                : '';

            /* An empty row reads as a bug; hide the label with it. */
            ['ev-year', 'ev-dates', 'ev-place', 'ev-mints', 'ev-desc', 'ev-links', 'ev-source'].forEach(function (k) {
                var dd = $(k), dt = dd.previousElementSibling;
                var empty = !dd.textContent && !dd.children.length;
                dd.hidden = empty; if (dt) dt.hidden = empty;
            });
            var art = $('ev-art'), found = artwork(entry);
            if (found) {
                var sha = found.sha, ext = found.ext;
                var alt = name ? 'Artwork for ' + name : 'Event artwork';
                var full = el('a', null, 'Original ' + ext.toUpperCase());
                full.href = GATEWAYS[0] + ROOTS.blob + '/' + sha.slice(0, 2) + '/' + sha + '.' + ext;
                full.rel = 'noopener';
                art.appendChild(full);
                art.appendChild(document.createTextNode(' · sha256 '));
                art.appendChild(el('code', null, sha));
                var anim = animExt(id, row, m);
                if (anim) {
                    img.alt = alt;
                    animSwitch(id, anim, sha, alt, art);
                } else {
                    stillImg(img, sha, alt);
                }
            } else {
                art.textContent = 'No artwork in the archive for this event.';
            }
        }).catch(function (e) {
            /* Every other failure in this file has a written message; this path
               had none, so one malformed record left the page on "Loading..."
               with nothing to read. */
            if (gen !== evGen) return;
            $('ev-name').textContent = 'Event #' + id;
            $('ev-desc').hidden = false;
            $('ev-desc').previousElementSibling.hidden = false;
            $('ev-desc').textContent = 'This event could not be displayed: ' + (e && e.message ? e.message : 'unexpected data') + '.';
        });
    }
    function showHome() {
        var wasEvent = !$('event').hidden;
        $('event').hidden = true;
        $('home').hidden = false;
        $('about').hidden = false;
        $('mirror').hidden = false;
        document.title = 'EveryBadge - the POAP archive';
        if (wasEvent) focusTo($('home').querySelector('h1'));
    }

    /* --------------------------------------------------------- routing */
    /* /event/<id> is a real path so links are shareable and archivable; the
       host rewrites it to this page (worker.js on Cloudflare, netlify.toml on
       Netlify). */
    /* #about and #mirror sit BELOW the grid, and the grid grows asynchronously
       as tiles arrive. Scrolling once lands correctly and is then pushed away by
       the tiles appearing above - which is why the two anchors appeared to go to
       the same place. Scroll again once the batch settles. */
    /* The element a #hash names, by id. querySelector would read the hash as
       a CSS selector, and "#1" (or anything a visitor types) is not one: it
       threw, and on a cold load nothing caught it. */
    function hashTarget(hash) {
        try { return document.getElementById(decodeURIComponent(hash.slice(1))); }
        catch (e) { return null; }
    }
    function scrollToHash(hash) {
        var t = hashTarget(hash);
        if (!t) return;
        t.scrollIntoView();
        Promise.resolve(homeFill).then(function () {
            requestAnimationFrame(function () {
                var again = hashTarget(hash);
                if (again) again.scrollIntoView();
            });
        });
    }

    function route() {
        var m = location.pathname.match(/^\/event\/(\d{1,7})\/?$/);
        if (m) return showEvent(Number(m[1]));
        showHome();
        var p = new URLSearchParams(location.search);
        var qs = p.get('q') || '', ys = p.get('y') || '', cs = p.get('c') || '';
        var sorted = p.get('s') === 'mints', inDesc = p.get('d') === '1';
        if (qs || ys || cs || sorted || inDesc) {
            sortSel.value = sorted ? 'mints' : '';
            descBox.checked = inDesc;
            /* The year and country <select>s are filled from the manifest,
               which may not have arrived yet on a cold deep link. Setting
               .value before the option exists silently selects nothing, and
               the URL is then rewritten without &y or &c. lastQuery = null
               matches no key, so runSearch always runs. */
            return manifest().then(function (m) {
                gotManifest(m);
                q.value = qs; yearSel.value = ys; countrySel.value = cs; lastQuery = null;
                return runSearch();
            }, function () { q.value = qs; lastQuery = null; return runSearch(); });
        }
        if (!grid.children.length) homeReset();
        if (location.hash) scrollToHash(location.hash);   // cold load of /#about
    }
    document.addEventListener('click', function (e) {
        var a = e.target.closest && e.target.closest('a');
        if (!a || a.origin !== location.origin || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
        if (/^\/event\/\d+/.test(a.pathname) || a.pathname === '/') {
            /* Was `!$('event').hidden === false`, which parses as
               `(!hidden) === false` - i.e. "we are on the home view" - so the
               home page took the native scroll and skipped scrollToHash, which
               is the only case scrollToHash exists for. */
            if (a.hash && a.pathname === '/' && $('event').hidden) {
                e.preventDefault();
                history.pushState(null, '', a.pathname + a.search + a.hash);
                scrollToHash(a.hash);
                return;
            }
            e.preventDefault();
            navigated = true;
            history.pushState(null, '', a.pathname + a.search + a.hash);
            route();
            if (a.hash) scrollToHash(a.hash);
        }
    });
    window.addEventListener('popstate', function () { navigated = true; route(); });
    route();
})();
