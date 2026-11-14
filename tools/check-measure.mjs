// Line length and body size, measured the way a reader meets them: renders the
// site in headless Chrome and prints one line per problem, nothing when it
// holds. The Checks workflow runs it and fails on any output.
//
//   desktop (1440px): prose that wraps to 3+ lines is 16px or larger, a page's
//                     median line is at most 75 characters, no paragraph's
//                     average line passes 85;
//   phone (390px):    no prose is justified (this site is flush left at every width);
//   Safari (WebKit):  any justified prose keeps its word spaces even
//                     (webkit-gaps.mjs; nothing here is justified today);
//   both widths:      nothing moves after it appears: layout shift of 0.1 or
//                     less on the home page and an event page
//                     (layout-shift.mjs).
//
// For the layout-shift pass the pages need their data. Requests to the data
// host are answered from tools/fixtures/ (recorded copies of the manifest, two
// index shards and one event), 300ms late, and every image with a 1px PNG;
// nothing leaves the machine. /event/<id> is served the way worker.js serves
// it: the shell with the event view unhidden and the home views hidden.
//
// Prose is the lede and the about and mirror sections. Badge cards, filters
// and the status line are interface text and are not measured. The same rules
// guard thebenmeadows.com, its subdomains and benjaminmeadows.com.
//
// usage: node tools/check-measure.mjs [public]
// needs playwright-core (npm ci --prefix tools) and Chrome or Brave
// (CHROME_PATH, else the usual install paths).
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";

const require = createRequire(new URL("./package.json", import.meta.url));
const { chromium, webkit } = require("playwright-core");
const { checkWebkitGaps } = await import(new URL("./webkit-gaps.mjs", import.meta.url));
const { checkLayoutShift } = await import(new URL("./layout-shift.mjs", import.meta.url));
const FIXTURES = new URL("./fixtures/", import.meta.url);
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// What worker.js does to the shell for /event/<id>: the event view unhidden,
// the home views hidden. Throws if the shell's markup no longer matches.
function asEvent(html) {
    let n = 0;
    const out = html
        .replace(/<section id="(home|about|mirror)"/g, (m) => (n++, m + " hidden"))
        .replace('<section id="event" hidden>', () => (n++, '<section id="event">'));
    if (n !== 4) throw new Error(`asEvent: expected 4 section edits, made ${n}`);
    return out;
}
// Stands in for the data host and the IPFS gateways.
const stubData = (ctx) => ctx.route((url) => url.hostname !== "127.0.0.1", async (route) => {
    const url = new URL(route.request().url());
    await wait(300);
    if (route.request().resourceType() === "image") return route.fulfill({ contentType: "image/png", body: PIXEL });
    try {
        return route.fulfill({ contentType: "application/json", headers: { "access-control-allow-origin": "*" },
            body: readFileSync(new URL("." + url.pathname, FIXTURES)) });
    } catch { return route.fulfill({ status: 404, headers: { "access-control-allow-origin": "*" }, body: "" }); }
});

const SITE = process.argv[2] || "public";
const MEDIAN_MAX = 75, LINE_MAX = 85, BODY_MIN = 16;
const PROSE = ".lede, .prose p, .prose li";

const browserPath = [process.env.CHROME_PATH,
    "/Applications/Brave Origin Beta.app/Contents/MacOS/Brave Origin Beta",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => p && existsSync(p));
// Printed, not thrown: any output fails T1, and a missing browser is a missing input.
if (!browserPath) { console.log("no Chrome or Brave found; set CHROME_PATH"); process.exit(0); }

const sample = [""].filter((p) => existsSync(join(SITE, p, "index.html")));

const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json",
    ".svg": "image/svg+xml", ".woff2": "font/woff2" };
const server = createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const event = /^\/event\/\d{1,7}\/?$/.test(p);
    if (event) p = "/index.html";
    if (p.endsWith("/")) p += "index.html";
    // Media is not needed to measure type; answering 404 keeps the run fast.
    if (p.startsWith("/media/")) { res.writeHead(404); return res.end(); }
    let body;
    try { body = readFileSync(join(SITE, p)); } catch { res.writeHead(404); return res.end(); }
    if (event) body = asEvent(body.toString());
    // The script arrives after the first paint on a real connection; without
    // the wait the page is never seen in its before-script state.
    setTimeout(() => {
        res.writeHead(200, { "content-type": TYPES[extname(p)] || "application/octet-stream" });
        res.end(body);
    }, extname(p) === ".js" ? 300 : 0);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}/`;

const measure = (sel) => [...document.querySelectorAll(sel)].flatMap((el) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || el.getBoundingClientRect().width < 5) return [];
    const text = el.innerText.replace(/\s+/g, " ").trim();
    const range = document.createRange();
    range.selectNodeContents(el);
    const tops = new Set();
    for (const r of range.getClientRects()) if (r.width > 2) tops.add(Math.round(r.top / 4));
    return [{ text: text.slice(0, 40), lines: tops.size, cpl: text.length / Math.max(1, tops.size), size: parseFloat(cs.fontSize), align: cs.textAlign }];
});

const browser = await chromium.launch({ headless: true, executablePath: browserPath });
const problems = [];
try {
    for (const [width, height] of [[1440, 900], [390, 844]]) {
        const ctx = await browser.newContext({ viewport: { width, height } });
        const page = await ctx.newPage();
        for (const path of sample) {
            await page.goto(origin + path, { waitUntil: "load" });
            const blocks = (await page.evaluate(measure, PROSE)).filter((b) => b.lines >= 3);
            if (!blocks.length) continue;
            if (width === 1440) {
                const cpl = blocks.map((b) => b.cpl).sort((a, b) => a - b);
                const median = cpl[Math.floor(cpl.length / 2)];
                if (median > MEDIAN_MAX) problems.push(`/${path}: median ${Math.round(median)} characters a line at 1440px (max ${MEDIAN_MAX})`);
                for (const b of blocks) {
                    if (b.cpl > LINE_MAX) problems.push(`/${path}: "${b.text}" runs ${Math.round(b.cpl)} characters a line (max ${LINE_MAX})`);
                    if (b.size < BODY_MIN) problems.push(`/${path}: "${b.text}" is ${b.size}px prose (min ${BODY_MIN})`);
                }
            } else {
                for (const b of blocks) if (b.align === "justify") problems.push(`/${path}: "${b.text}" is justified at 390px`);
            }
        }
        await ctx.close();
    }
    problems.push(...await checkLayoutShift(browser, origin, ["", "event/1"], stubData));
    problems.push(...await checkWebkitGaps(webkit, origin, sample, PROSE));
} finally {
    await browser.close();
    server.close();
}
for (const p of problems) console.log(p);
