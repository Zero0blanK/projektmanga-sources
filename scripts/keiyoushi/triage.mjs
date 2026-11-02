// One polite request to each not-yet-ported extension's base URL, classifying the site as
// alive, moved (redirected to another host), challenge (Cloudflare/DDoS-Guard), or dead.
// Writes scripts/keiyoushi/triage.json. No retries, no challenge solving.
//   node scripts/keiyoushi/triage.mjs [theme ...]
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLOUDFLARE_PATTERNS } from "../../src/lib/detectionPatterns.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const inventory = JSON.parse(await fs.readFile(path.join(here, "inventory.json"), "utf8"));
const themes = process.argv.slice(2);
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const outFile = path.join(here, "triage.json");
const previous = await fs
  .readFile(outFile, "utf8")
  .then(JSON.parse)
  .catch(() => ({}));

const PARKED = /domain (?:is )?for sale|buy this domain|parked free|sedoparking|hugedomains|dan\.com/i;

async function probe(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9" },
      redirect: "follow",
      signal: controller.signal,
    });
    const body = (await response.text()).slice(0, 200_000);
    const finalHost = new URL(response.url).hostname.replace(/^www\./, "");
    const startHost = new URL(url).hostname.replace(/^www\./, "");
    if (
      response.headers.get("cf-mitigated") === "challenge" ||
      ((response.status === 403 || response.status === 503) &&
        CLOUDFLARE_PATTERNS.some((pattern) => pattern.test(body)))
    )
      return { status: "challenge", http: response.status };
    if (response.status >= 400) return { status: "dead", http: response.status };
    if (PARKED.test(body) || body.length < 500) return { status: "dead", http: response.status, why: "parked or empty" };
    if (finalHost !== startHost) return { status: "moved", http: response.status, url: new URL("/", response.url).href.replace(/\/$/, "") };
    return { status: "alive", http: response.status };
  } catch (error) {
    return { status: "dead", why: error.name === "AbortError" ? "timeout" : String(error.cause?.code ?? error.message) };
  } finally {
    clearTimeout(timer);
  }
}

const rows = inventory.extensions.filter(
  (row) => !row.ported && !row.dynamic && (themes.length === 0 || themes.includes(row.theme ?? "standalone")),
);
const results = { ...previous };
const queue = rows.flatMap((row) => row.sources.map((source) => ({ row, source })));
let done = 0;
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const { row, source } = queue.shift();
      const key = `${row.upstream}|${source.baseUrl}`;
      results[key] = { ...(await probe(source.baseUrl)), at: new Date().toISOString() };
      if (++done % 10 === 0) console.log(`${done} probed`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }),
);
await fs.writeFile(outFile, `${JSON.stringify(results, null, 2)}\n`);
const tally = {};
for (const row of rows)
  for (const source of row.sources) {
    const status = results[`${row.upstream}|${source.baseUrl}`]?.status;
    tally[status] = (tally[status] ?? 0) + 1;
  }
console.log(tally);
