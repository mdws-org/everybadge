// Runs tools/event-head-cases.json against the Worker in `wrangler dev`.
//
//   node tools/event-head.mjs            start two local Workers and run every case
//   node tools/event-head.mjs <base>     run the cases that need a live data host
//                                        against an address that is already up
//
// Two Workers because one case needs the data host to be unreachable: the
// second is started with DATA pointing at a closed local port. The first reads
// the real data host, so this needs the network. Prints one line per failure
// and exits 1 if there is any; prints a count and exits 0 otherwise.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { generic, cases } = JSON.parse(readFileSync(join(ROOT, "tools/event-head-cases.json"), "utf8"));

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s) =>
    s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
        if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m;
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

async function runCase(c, base) {
    const res = await fetch(base + c.path, { headers: { "Sec-Fetch-Mode": "navigate" }, redirect: "manual" });
    const html = await res.text();
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
    return problems;
}

function startWorker(port, extra) {
    // Each Worker gets its own inspector port: two on the default one and the second never starts.
    const args = ["dev", "--port", String(port), "--ip", "127.0.0.1", "--inspector-port", String(port + 1000), ...extra];
    const child = spawn("wrangler", args, {
        cwd: ROOT,
        stdio: "ignore",
    });
    return { child, base: `http://127.0.0.1:${port}` };
}

async function waitFor(base) {
    for (let i = 0; i < 60; i++) {
        try {
            await fetch(base + "/robots.txt");
            return;
        } catch {
            await new Promise((r) => setTimeout(r, 500));
        }
    }
    throw new Error(`${base} did not come up`);
}

const given = process.argv[2];
const workers = [];
let up = given;
let down = null;
let failed = 0;
let ran = 0;
try {
    if (!given) {
        // One after the other: started together, one of the two sometimes never listens.
        for (const [port, extra] of [[8877, []], [8878, ["--var", "DATA:http://127.0.0.1:9"]]]) {
            workers.push(startWorker(port, extra));
            await waitFor(workers.at(-1).base);
        }
        [up, down] = workers.map((w) => w.base);
    }
    for (const c of cases) {
        const base = c.data === "down" ? down : up;
        if (!base) continue;
        ran++;
        const problems = await runCase(c, base);
        for (const p of problems) console.log(`FAIL ${c.name} (${c.path}): ${p}`);
        if (problems.length) failed++;
    }
} finally {
    for (const w of workers) w.child.kill();
}
console.log(`${ran - failed} of ${ran} cases pass`);
process.exit(failed ? 1 : 0);
