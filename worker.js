/* everybadge.org edge script. Deliberately tiny.
 *
 * Static assets are served ahead of this script for any path that matches a
 * file. This runs only for misses, and does exactly one thing: /event/<id> is
 * a real, shareable, archivable URL that has no file behind it, so it gets
 * index.html (status 200) and app.js reads the id from the path. Everything
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
            return new Response(page.body, {
                status: 200,
                headers: page.headers,
            });
        }
        return env.ASSETS.fetch(request);
    },
};
