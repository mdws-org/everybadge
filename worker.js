/* everybadge.org edge script. Deliberately small.
 *
 * Static assets are served ahead of this script for any path that matches a
 * file. This runs only for misses, and does exactly one thing: /event/<id> is
 * a real, shareable, archivable URL that has no file behind it, so it gets
 * index.html with the event view unhidden and the home views hidden (the event
 * layout shows before the script runs), and with a head that names the event:
 * its own canonical address, and the event's name in the title, description
 * and share tags. app.js reads the id from the path and fills in the rest.
 *
 * The name comes from one read of the event's own metadata file on the data
 * host (v1/meta/<id>.json, about 1 KB). That read also says whether the
 * archive holds the event at all, so an id it does not hold is answered 404
 * with the same page. If the data host does not answer in time, the page goes
 * out as the plain shell with status 200: a visitor must never get an error
 * here because a lookup was slow.
 *
 * Everything else that misses is a real 404 - not_found_handling is
 * "404-page", not "single-page-application", because an archive that answers
 * 200 to /anything-at-all is lying about what it holds.
 *
 * When the versioned API for the iOS client arrives it mounts here under
 * /v1/*, listed in run_worker_first so it never competes with a static file.
 */
const DATA = 'https://data.everybadge.org';
const ORIGIN = 'https://everybadge.org';
// Longer than a cold read of the data host takes, short enough that a visitor
// does not notice when it never comes.
const META_TIMEOUT_MS = 1500;

/* What the archive says about one event: { name, year, city, country } when it
   holds it, { missing: true } when it does not, null when the data host did
   not give an answer (down, slow, or a status that is neither). */
async function eventFacts(id, env) {
    try {
        const res = await fetch(`${env.DATA || DATA}/v1/meta/${id}.json`, {
            signal: AbortSignal.timeout(META_TIMEOUT_MS),
        });
        if (res.status === 404) return { missing: true };
        if (!res.ok) return null;
        const meta = await res.json();
        const trait = {};
        for (const a of Array.isArray(meta.attributes) ? meta.attributes : []) {
            if (a && typeof a.trait_type === 'string') trait[a.trait_type] = a.value;
        }
        const text = (v) => (typeof v === 'string' ? v.trim() : '');
        return {
            name: text(meta.name),
            year: Number.isInteger(meta.year) ? meta.year : null,
            city: text(trait.city),
            country: text(trait.country),
        };
    } catch {
        return null;
    }
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const escapeAttr = (s) => s.replace(/[&<>"]/g, (c) => ESCAPES[c]);

/* The title and description for an event page. Built from the archive's own
   fields only: the organizer's description is shown on the page by app.js and
   is never promoted into a tag a search engine prints. */
function eventHead(id, facts) {
    if (facts.missing) return { title: `No event #${id} - EveryBadge`, description: null };
    const year = facts.year === null ? '' : `${facts.year} `;
    const place = [facts.city, facts.country].filter(Boolean).join(', ');
    const what = facts.name
        ? `${facts.name}, a ${year}POAP event${place ? ` in ${place}` : ''}.`
        : `An untitled ${year}POAP event${place ? ` in ${place}` : ''}.`;
    return {
        // The same title app.js sets once it has the event.
        title: `${facts.name || `Event #${id}`} - EveryBadge`,
        description: `${what} Event #${id} in the EveryBadge archive.`,
    };
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const match = /^\/event\/(\d{1,7})\/?$/.exec(url.pathname);
        if (!match) return env.ASSETS.fetch(request);

        const id = match[1];
        // Rewrite, not redirect: the address bar keeps /event/<id>.
        const [page, facts] = await Promise.all([env.ASSETS.fetch(new URL('/', url)), eventFacts(id, env)]);
        // Always the apex, without a trailing slash.
        const self = `${ORIGIN}/event/${id}`;
        // Send the shell with the event view already showing: the same hidden
        // attributes app.js sets in showEvent(), so the page does not paint the
        // home view first and then swap. Attributes, not a class, because every
        // cached copy of app.js and style.css already understands them.
        let shell = new HTMLRewriter()
            .on('#home, #about, #mirror', { element(el) { el.setAttribute('hidden', ''); } })
            .on('#event', { element(el) { el.removeAttribute('hidden'); } })
            // The shell's canonical and og:url name the home page; an event
            // page names itself, or search engines file every event as a copy
            // of the home page.
            .on('link[rel="canonical"]', { element(el) { el.setAttribute('href', self); } })
            .on('meta[property="og:url"]', { element(el) { el.setAttribute('content', self); } });
        if (facts) {
            // A name is text wherever it lands. setInnerContent escapes it for
            // the title. setAttribute escapes quotes and ampersands but leaves
            // < and > as they are, so each meta tag is written whole, with
            // every one of the four escaped.
            const head = eventHead(id, facts);
            const meta = (key, name, value) => ({
                element(el) { el.replace(`<meta ${key}="${name}" content="${escapeAttr(value)}">`, { html: true }); },
            });
            shell = shell
                .on('title', { element(el) { el.setInnerContent(head.title); } })
                .on('meta[property="og:title"]', meta('property', 'og:title', head.title));
            if (head.description) {
                shell = shell
                    .on('meta[name="description"]', meta('name', 'description', head.description))
                    .on('meta[property="og:description"]', meta('property', 'og:description', head.description));
            }
        }
        return new Response(shell.transform(page).body, {
            status: facts && facts.missing ? 404 : 200,
            headers: page.headers,
        });
    },
};
