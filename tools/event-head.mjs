// Runs tools/event-head-cases.json against the Worker in `wrangler dev`.
//
//   node tools/event-head.mjs
//
// Nothing here touches the network. The Worker is started with DATA pointing
// at a stand-in data host in this process, which answers v1/meta/<id>.json
// from tools/fixtures/ and can be told to be fast, slow, stalled or failing;
// each case names the behaviour it needs. Prints one line per failure and
// exits 1 if there is any; prints a count and exits 0 otherwise.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { generic, agents, data_modes: modes, cases } = JSON.parse(
    readFileSync(join(ROOT, "tools/event-head-cases.json"), "utf8"),
);
const WORKER_PORT = 8877;
const DATA_PORT = 8879;

// The stand-in data host. `mode` is set before each case; `finished` records
// every metadata read that was answered in full, which is how a case can tell
// a background read from an abandoned one.
let mode = modes.fast;
const finished = [];
const dataHost = createServer((req, res) => {
    const m = /^\/v1\/meta\/(\d+)\.json$/.exec(req.url);
    const file = m && join(ROOT, "tools/fixtures/v1/meta", `${m[1]}.json`);
    const { delay_ms: delay = 0, status } = mode;
    const timer = setTimeout(() => {
        if (status) res.writeHead(status).end("stand-in error");
        else if (!file || !existsSync(file)) res.writeHead(404, { "Content-Type": "text/html" }).end("not found");
        else res.writeHead(200, { "Content-Type": "application/json" }).end(readFileSync(file));
        if (m) finished.push(m[1]);
    }, delay);
    res.on("close", () => { if (!res.writableEnded) clearTimeout(timer); });
});

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s) =>
    s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, e) => {
        if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? match;
        return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    });

// Attribute values in this page are always double-quoted; the Worker must keep
// it that way, which is what the quote-escaping case checks.
const attr = (html, tagPattern, name) => {
    const tag = html.match(new RegExp(`<${tagPattern}[^>]*>`, "i"));
    const value = tag && tag[0].match(new RegExp(`\\s${name}="([^"]*)"`, "i"));
    return value ? decode(value[1]) : null;
};

function read(html) {
    const title = html.match(/<title>([\s\S]*?)<\/title>/i);
    const event = html.match(/<section id="event"[^>]*>/i);
    return {
        title: title ? decode(title[1]) : null,
        description: attr(html, 'meta name="description"', "content"),
        og_title: attr(html, 'meta property="og:title"', "content"),
        canonical: attr(html, 'link rel="canonical"', "href"),
        event_view_showing: event ? !/\shidden\b/i.test(event[0]) : null,
    };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runCase(c, base) {
    mode = modes[c.data];
    finished.length = 0;
    const agent = "agent" in c ? c.agent : agents[c.as];
    const started = Date.now();
    const res = await fetch(base + c.path, {
        headers: { "Sec-Fetch-Mode": "navigate", "User-Agent": agent },
        redirect: "manual",
    });
    const html = await res.text();
    const ms = Date.now() - started;
    const got = { status: res.status, ...read(html) };
    const problems = [];
    for (const key of ["status", "title", "description", "og_title", "canonical", "event_view_showing"]) {
        if (!(key in c)) continue;
        const want = c[key] === "generic" ? generic[key] : c[key];
        if (got[key] !== want) problems.push(`${key}: want ${JSON.stringify(want)}, got ${JSON.stringify(got[key])}`);
    }
    for (const s of c.raw_must_not_contain ?? []) {
        if (html.includes(s)) problems.push(`raw HTML contains ${JSON.stringify(s)}`);
    }
    if ("min_ms" in c && ms < c.min_ms) problems.push(`answered in ${ms} ms, want at least ${c.min_ms}`);
    if ("max_ms" in c && ms > c.max_ms) problems.push(`answered in ${ms} ms, want at most ${c.max_ms}`);
    if (c.vary_user_agent && !/user-agent/i.test(res.headers.get("vary") ?? "")) {
        problems.push(`Vary is ${JSON.stringify(res.headers.get("vary"))}, want it to name User-Agent`);
    }
    if (c.background_read_completes) {
        const id = c.path.match(/\d+/)[0];
        if (finished.includes(id)) problems.push("the read had already finished when the page was answered");
        await sleep(modes[c.data].delay_ms + 300);
        if (!finished.includes(id)) problems.push("the read never finished after the page was answered");
    }
    // A stalled read from this case must not answer into the next one.
    if (modes[c.data].delay_ms > 1000) await sleep(200);
    return problems;
}

async function waitFor(base) {
    for (let i = 0; i < 120; i++) {
        try {
            await fetch(base + "/robots.txt");
            return;
        } catch {
            await sleep(500);
        }
    }
    throw new Error(`${base} did not come up`);
}

await new Promise((r) => dataHost.listen(DATA_PORT, "127.0.0.1", r));
const args = [
    "dev", "--port", String(WORKER_PORT), "--ip", "127.0.0.1", "--inspector-port", String(WORKER_PORT + 1000),
    "--var", `DATA:http://127.0.0.1:${DATA_PORT}`,
];
const worker = spawn("wrangler", args, { cwd: ROOT, stdio: "ignore" });
const base = `http://127.0.0.1:${WORKER_PORT}`;

let failed = 0;
try {
    await waitFor(base);
    for (const c of cases) {
        const problems = await runCase(c, base);
        for (const p of problems) console.log(`FAIL ${c.name} (${c.path}): ${p}`);
        if (problems.length) failed++;
    }
} finally {
    worker.kill();
    dataHost.close();
    dataHost.closeAllConnections();
}
console.log(`${cases.length - failed} of ${cases.length} cases pass`);
process.exit(failed ? 1 : 0);
