/* everybadge.org - browse, search and view the POAP archive.
 *
 * Plain script, no framework, no build step. Everything heavy lives behind
 * DATA; this file is meant to stay small enough that a mirror re-syncing it
 * costs nothing.
 *
 * Data layout (same keys as the B2 corpus, served from R2 at DATA):
 *   browse/<n>.json   [[id, name, year, anim], ...] for ids n*1000..n*1000+999
 *   cindex/<n>.json   {"<id>": [sha256, typeCode], ...}   same shard boundaries
 *   search.json       every event as [id, name, year, anim] - 2.9 MB gzipped
 *   manifest.json     counts, shard list, year histogram, per-file sha256
 *   thumb/<xx>/<sha>.webp    400px thumbnail; xx = first two hex of sha
 *   meta/<id>.json    the metadata POAP served for the event
 *
 * A grid tile needs browse (name) + cindex (sha -> thumbnail path). They are
 * separate files on purpose: the sha is 64 hex chars per event and would
 * dominate the browse index, and cindex already exists for the poap-saver.
 *
 * `anim` means the corpus holds an animated re-encode at anim/<id>. It does NOT
 * mean the artwork is animated - 40,230 events are GIFs and frame counts are
 * unknowable without the full blob. This UI never says "animated".
 *
 * Fallback: if DATA does not answer for a thumbnail or metadata file, the same
 * path is tried under the IPFS roots through public gateways. That is the
 * point of content addressing - the site is a convenience over an archive that
 * exists without it. Only cindex/browse/search have no IPFS twin: they are
 * lookup structures, and the roots printed on the page are enough to rebuild
 * them.
 */
(function () {
    'use strict';

    /* The one thing that changes between local testing and production. A dev
       server can set window.EVERYBADGE_DATA before this script runs; nothing
       else in the file knows where the data lives. */
    var DATA = window.EVERYBADGE_DATA || 'https://data.everybadge.org';
    var SHARD = 1000;
    var PAGE = 60;                       // tiles per "page" of the home grid
    var ROOTS = {
        meta:  'bafybeiglmxn6ta7bt76p5ed6mnmek4m4uvmftonxjqe6zemp6j73qzwwuu',
        thumb: 'bafybeia3q5zqbjdhzdmdny3vzoc6gddjn4tsi22p6jd2lsx3rcm362gin4',
        blob:  'bafybeickz3h6wnxdwsxeoixj3pxk24fnczqeymuqh7h7xge7iaownd4b3i',
    };
    /* Public gateways that answer a BROWSER. Tested 2026-08-18: ipfs.io,
       dweb.link, gateway.ipfs.io, w3s.link and nftstorage.link all return 403
       to a browser User-Agent (200 to curl - a bot rule, not a pinning
       problem), and cloudflare-ipfs.com is gone. These two return 200 with
       ACAO:* from a page. Re-test before adding or reordering; gateway rules
       change without notice. */
    var GATEWAYS = ['https://gateway.pinata.cloud/ipfs/', 'https://4everland.io/ipfs/'];
    var EXT = { p: 'png', g: 'gif', j: 'jpg', w: 'webp' };

    var $ = function (id) { return document.getElementById(id); };
    var grid = $('grid'), status = $('status'), more = $('more');
    var q = $('q'), yearSel = $('year');

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
    function shard(n)  { return getJSON(DATA + '/browse/' + n + '.json'); }
    function cindex(n) { return getJSON(DATA + '/cindex/' + n + '.json'); }
    var manifestP = getJSON(DATA + '/manifest.json');
    var searchP = null;                   // loaded on first keystroke, not on page load
    function searchIndex() {
        if (!searchP) {
            status.textContent = 'Loading the full index (about 3 MB, once)…';
            searchP = getJSON(DATA + '/search.json').then(function (rows) {
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
    function metaURL(id)       { return DATA + '/meta/' + id + '.json'; }
    function metaIPFS(id, i)   { return GATEWAYS[i] + ROOTS.meta + '/' + id + '.json'; }

    /* Metadata with gateway fallback. Every source is tried before giving up,
       and "no such event" (404 from DATA) is not retried anywhere - a gap is a
       gap. */
    function getMeta(id) {
        return fetch(metaURL(id)).then(function (r) {
            if (r.status === 404) return null;
            if (!r.ok) throw new Error(r.status);
            return r.json();
        }).catch(function () {
            var i = 0;
            function next() {
                if (i >= GATEWAYS.length) throw new Error('unreachable');
                return fetch(metaIPFS(id, i++)).then(function (r) {
                    if (!r.ok) return next();
                    return r.json();
                }, next);
            }
            return next();
        });
    }

    /* --------------------------------------------------------- rendering */
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
            img.remove();
        };
        img.src = thumbURL(sha);
        return img;
    }
    function tile(row, ci) {
        var id = row[0], name = row[1], year = row[2];
        var a = el('a', 'card');
        a.href = '/event/' + id;
        var th = el('div', 'th');
        var entry = ci && ci[String(id)];
        if (entry) th.appendChild(thumbImg(entry[0], ''));
        else th.className += ' none';
        a.appendChild(th);
        var nm = el('span', name ? 'nm' : 'nm untitled', name || '(untitled)');
        nm.title = name || 'This event has no name in the archive';
        a.appendChild(nm);
        a.appendChild(el('span', 'yr', '#' + id + (year ? ' · ' + year : '')));
        return a;
    }
    function fmt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

    /* --------------------------------------------------------- home grid */
    /* Newest first: shard numbers descend, rows within a shard descend. The
       cursor is (shardNo, offset-from-end) so "Show more" is stateless. */
    var home = { shards: null, si: 0, off: 0, busy: false };
    function homeReset() {
        grid.textContent = '';
        home.si = 0; home.off = 0;
        more.hidden = true;
        return manifestP.then(function (m) {
            home.shards = m.shards.slice().reverse();
            $('count').textContent = fmt(m.events);
            fillYears(m.years);
            return homeMore();
        }, function (e) {
            status.textContent = 'The archive index did not load. ' + e.message;
        });
    }
    function homeMore() {
        if (home.busy || !home.shards || home.si >= home.shards.length) return;
        home.busy = true; more.disabled = true;
        var want = PAGE, frag = document.createDocumentFragment();
        function step() {
            if (want <= 0 || home.si >= home.shards.length) {
                grid.appendChild(frag);
                more.hidden = home.si >= home.shards.length;
                more.disabled = false; home.busy = false;
                return;
            }
            var n = home.shards[home.si];
            return Promise.all([shard(n), cindex(n).catch(function () { return null; })])
                .then(function (r) {
                    var rows = r[0], ci = r[1];
                    var end = rows.length - home.off;
                    var start = Math.max(0, end - want);
                    for (var i = end - 1; i >= start; i--) frag.appendChild(tile(rows[i], ci));
                    want -= (end - start);
                    home.off += (end - start);
                    if (start === 0) { home.si++; home.off = 0; }
                    return step();
                }, function (e) {
                    status.textContent = 'Could not load part of the archive. ' + e.message;
                    more.disabled = false; home.busy = false;
                });
        }
        return step();
    }
    function fillYears(hist) {
        /* Only years inside the plausible era get their own option; the junk
           years (985, 3463…) are real data but not a facet anyone wants. */
        var ys = Object.keys(hist).map(Number).filter(function (y) { return y >= 2018 && y <= 2026; }).sort(function (a, b) { return b - a; });
        ys.forEach(function (y) {
            var o = el('option', null, y + '  (' + fmt(hist[y]) + ')');
            o.value = y;
            yearSel.appendChild(o);
        });
    }

    /* --------------------------------------------------------- search */
    var searchTimer = null, lastQuery = '';
    function norm(s) { return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, ''); }
    function runSearch() {
        var text = q.value.trim(), year = yearSel.value;
        var key = text + ' ' + year;
        if (key === lastQuery) return;
        lastQuery = key;
        if (!text && !year) { status.textContent = ''; return homeReset(); }
        history.replaceState(null, '', text || year ? '/?q=' + encodeURIComponent(text) + (year ? '&y=' + year : '') : '/');
        searchIndex().then(function (rows) {
            var hits;
            if (/^\d+$/.test(text) && !year) {
                var id = Number(text);
                hits = rows.filter(function (r) { return r[0] === id; });
                if (!hits.length) hits = rows.filter(function (r) { return String(r[0]).indexOf(text) === 0; }).slice(0, 200);
            } else {
                var terms = norm(text).split(/\s+/).filter(Boolean);
                var y = year ? Number(year) : null;
                hits = [];
                for (var i = rows.length - 1; i >= 0 && hits.length < 600; i--) {
                    var r = rows[i];
                    if (y !== null && r[2] !== y) continue;
                    if (terms.length) {
                        var n = norm(r[1]);
                        var ok = true;
                        for (var t = 0; t < terms.length; t++) if (n.indexOf(terms[t]) === -1) { ok = false; break; }
                        if (!ok) continue;
                    }
                    hits.push(r);
                }
            }
            renderHits(hits, text, year);
        }).catch(function () { /* status already set */ });
    }
    function renderHits(hits, text, year) {
        grid.textContent = '';
        more.hidden = true;
        var what = text ? '"' + text + '"' : year;
        status.textContent = hits.length
            ? fmt(hits.length) + (hits.length >= 600 ? '+' : '') + (hits.length === 1 ? ' event matches ' : ' events match ') + what + (hits.length >= 600 ? ' - showing the newest 600' : '')
            : 'Nothing matches ' + what + '.';
        /* Group by shard so each cindex file is fetched once, then render in
           the original hit order. */
        var byShard = {};
        hits.forEach(function (r) { (byShard[Math.floor(r[0] / SHARD)] = byShard[Math.floor(r[0] / SHARD)] || []).push(r); });
        var ns = Object.keys(byShard);
        Promise.all(ns.map(function (n) { return cindex(n).catch(function () { return null; }); })).then(function (cis) {
            var ciBy = {};
            ns.forEach(function (n, i) { ciBy[n] = cis[i]; });
            var frag = document.createDocumentFragment();
            hits.forEach(function (r) { frag.appendChild(tile(r, ciBy[Math.floor(r[0] / SHARD)])); });
            grid.appendChild(frag);
        });
    }
    q.addEventListener('input', function () { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 180); });
    yearSel.addEventListener('change', runSearch);
    $('search').addEventListener('submit', function (e) { e.preventDefault(); clearTimeout(searchTimer); runSearch(); });
    more.addEventListener('click', homeMore);

    /* --------------------------------------------------------- event page */
    function showEvent(id) {
        $('home').hidden = true;
        $('about').hidden = true;
        $('mirror').hidden = true;
        $('event').hidden = false;
        document.title = 'Event #' + id + ' - EveryBadge';
        var img = $('ev-img');
        img.removeAttribute('src'); img.alt = '';
        ['ev-name', 'ev-id', 'ev-year', 'ev-dates', 'ev-place', 'ev-desc', 'ev-art', 'ev-links'].forEach(function (k) { $(k).textContent = ''; });
        $('ev-id').textContent = String(id);
        $('ev-name').textContent = 'Loading…';
        window.scrollTo(0, 0);

        var n = Math.floor(id / SHARD);
        var rowP = shard(n).then(function (rows) {
            for (var i = 0; i < rows.length; i++) if (rows[i][0] === id) return rows[i];
            return null;
        }, function () { return null; });
        var ciP = cindex(n).then(function (ci) { return ci[String(id)] || null; }, function () { return null; });

        Promise.all([rowP, ciP, getMeta(id).catch(function () { return undefined; })]).then(function (r) {
            var row = r[0], entry = r[1], meta = r[2];
            if (!row && meta === null) {
                $('ev-name').textContent = 'No event #' + id + ' in the archive';
                $('ev-desc').textContent = 'Either it never existed or POAP never stored anything for it. 42,423 ids in the range are gaps like this.';
                return;
            }
            var name = (meta && meta.name) || (row && row[1]) || '';
            $('ev-name').textContent = name || '(untitled)';
            if (!name) $('ev-name').className = 'untitled';
            document.title = (name || 'Event #' + id) + ' - EveryBadge';
            $('ev-year').textContent = (meta && meta.year) || (row && row[2]) || '';

            if (meta) {
                var attr = {};
                (meta.attributes || []).forEach(function (a) { attr[a.trait_type] = a.value; });
                var dates = [attr.startDate, attr.endDate].filter(Boolean);
                $('ev-dates').textContent = dates.length ? (dates[0] === dates[1] ? dates[0] : dates.join(' to ')) : '';
                var place = [attr.city, attr.country].filter(Boolean).join(', ');
                if (attr.virtualEvent === 'true' || attr.virtualEvent === true) place = place ? place + ' (virtual)' : 'Virtual';
                $('ev-place').textContent = place;
                $('ev-desc').textContent = meta.description || '';
                var links = $('ev-links');
                if (attr.eventURL) { var a1 = el('a', null, 'Event site'); a1.href = attr.eventURL; a1.rel = 'nofollow noopener'; links.appendChild(a1); }
                if (meta.home_url) { var a2 = el('a', null, 'POAP page (defunct)'); a2.href = meta.home_url; a2.rel = 'nofollow noopener'; links.appendChild(a2); }
                if (meta.image_url) { var a3 = el('a', null, 'Original image URL (defunct)'); a3.href = meta.image_url; a3.rel = 'nofollow noopener'; links.appendChild(a3); }
            } else if (meta === undefined) {
                $('ev-desc').textContent = 'The metadata file could not be reached right now - not from the archive host, not from the IPFS gateways. The name and year above come from the browse index.';
            }

            /* An empty row reads as a bug; hide the label with it. */
            ['ev-year', 'ev-dates', 'ev-place', 'ev-desc', 'ev-links'].forEach(function (k) {
                var dd = $(k), dt = dd.previousElementSibling;
                var empty = !dd.textContent && !dd.children.length;
                dd.hidden = empty; if (dt) dt.hidden = empty;
            });
            var art = $('ev-art');
            if (entry) {
                var sha = entry[0], ext = EXT[entry[1]] || 'bin';
                img.alt = name ? 'Artwork for ' + name : 'Event artwork';
                var step = 0;
                img.onerror = function () {
                    if (step < GATEWAYS.length) { img.src = thumbIPFS(sha, step++); return; }
                    img.onerror = null; img.alt = 'Artwork could not be loaded';
                };
                img.src = thumbURL(sha);
                var full = el('a', null, 'Original ' + ext.toUpperCase());
                full.href = GATEWAYS[0] + ROOTS.blob + '/' + sha.slice(0, 2) + '/' + sha + '.' + ext;
                full.rel = 'noopener';
                art.appendChild(full);
                art.appendChild(document.createTextNode(' · sha256 '));
                art.appendChild(el('code', null, sha));
                if (row && row[3]) {
                    art.appendChild(document.createTextNode(' · '));
                    var an = el('a', null, 'animated re-encode');
                    an.href = GATEWAYS[0] + 'bafybeibwodt254seymig7cbemxwgj4e5lztui3ccz6ypboafyl5i2ptn4a/' + id;
                    an.rel = 'noopener';
                    art.appendChild(an);
                }
            } else {
                art.textContent = 'No artwork in the archive for this event.';
            }
        });
    }
    function showHome() {
        $('event').hidden = true;
        $('home').hidden = false;
        $('about').hidden = false;
        $('mirror').hidden = false;
        document.title = 'EveryBadge - the POAP archive';
    }

    /* --------------------------------------------------------- routing */
    /* /event/<id> is a real path so links are shareable and archivable; the
       server rewrites it to this page (see _redirects / wrangler assets). */
    function route() {
        var m = location.pathname.match(/^\/event\/(\d{1,7})\/?$/);
        if (m) return showEvent(Number(m[1]));
        showHome();
        var p = new URLSearchParams(location.search);
        var qs = p.get('q') || '', ys = p.get('y') || '';
        if (qs || ys) { q.value = qs; yearSel.value = ys; lastQuery = ''; return runSearch(); }
        if (!grid.children.length) homeReset();
    }
    document.addEventListener('click', function (e) {
        var a = e.target.closest && e.target.closest('a');
        if (!a || a.origin !== location.origin || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
        if (/^\/event\/\d+/.test(a.pathname) || a.pathname === '/') {
            if (a.hash && a.pathname === '/' && !$('event').hidden === false) return; // in-page anchor on home
            e.preventDefault();
            history.pushState(null, '', a.pathname + a.search + a.hash);
            route();
            if (a.hash) { var t = document.querySelector(a.hash); if (t) t.scrollIntoView(); }
        }
    });
    window.addEventListener('popstate', route);
    route();
})();
