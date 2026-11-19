/* everybadge.org edge script. Deliberately tiny.
 *
 * Static assets are served ahead of this script for any path that matches a
 * file. This runs only for misses, and does exactly one thing: /event/<id> is
 * a real, shareable, archivable URL that has no file behind it, so it gets
 * index.html (status 200, with the event view unhidden and the home views
 * hidden, so the event layout shows before the script runs) and app.js reads
 * the id from the path. Everything
 * else that misses is a real 404 - not_found_handling is "404-page", not
 * "single-page-application", because an archive that answers 200 to
 * /anything-at-all is lying about what it holds.
 *
 * When the versioned API for the iOS client arrives it mounts here under
 * /v1/*, listed in run_worker_first so it never competes with a static file.
 */
export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        if (/^\/event\/\d{1,7}\/?$/.test(url.pathname)) {
            // Rewrite, not redirect: the address bar keeps /event/<id>.
            const page = await env.ASSETS.fetch(new URL('/', url));
            // Send the shell with the event view already showing: the same
            // hidden attributes app.js sets in showEvent(), so the page does
            // not paint the home view first and then swap. Attributes, not a
            // class, because every cached copy of app.js and style.css
            // already understands them. No data is read here.
            // The shell's canonical and og:url name the home page; an event
            // page names itself, or search engines file every event as a copy
            // of the home page. Always the apex, without a trailing slash.
            const self = 'https://everybadge.org/event/' + url.pathname.match(/\d+/)[0];
            const shell = new HTMLRewriter()
                .on('#home, #about, #mirror', { element(el) { el.setAttribute('hidden', ''); } })
                .on('#event', { element(el) { el.removeAttribute('hidden'); } })
                .on('link[rel="canonical"]', { element(el) { el.setAttribute('href', self); } })
                .on('meta[property="og:url"]', { element(el) { el.setAttribute('content', self); } })
                .transform(page);
            return new Response(shell.body, {
                status: 200,
                headers: page.headers,
            });
        }
        return env.ASSETS.fetch(request);
    },
};
