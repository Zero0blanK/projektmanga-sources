// Builds scripts/keiyoushi/inventory.json: one row per upstream Keiyoushi extension (en and
// all by default) with what the generator needs — name, sources (lang + base URL), content
// warning, theme, the Kotlin overrides, and whether ProjektManga already has the site.
// Reads only the pinned files fetched by fetch.mjs.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UPSTREAM_SHA, upstreamFile, wantedFiles } from "./fetch.mjs";
import { discoverSourceDirectories } from "../source-layout.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");

const stringField = (block, field) =>
  new RegExp(`\\b${field}\\s*=\\s*"([^"]*)"`).exec(block)?.[1] ?? null;

/** The `source { ... }` blocks of a build file, by brace matching. */
function sourceBlocks(text) {
  const blocks = [];
  const pattern = /\bsource\s*\{/g;
  let match;
  while ((match = pattern.exec(text))) {
    let depth = 1;
    let index = match.index + match[0].length;
    while (depth > 0 && index < text.length) {
      if (text[index] === "{") depth++;
      else if (text[index] === "}") depth--;
      index++;
    }
    blocks.push(text.slice(match.index, index));
  }
  return blocks;
}

function parseBuild(text) {
  const blocks = sourceBlocks(text);
  const sources = blocks.map((block) => ({
    lang: stringField(block, "lang"),
    baseUrl: stringField(block, "baseUrl"),
    name: stringField(block, "name"),
  }));
  // Generated (forEach/listOf), mirrored or custom base URLs need a person to read them.
  const dynamic =
    /\bforEach\b|\blistOf\s*\(|\bmirrors\s*\(|\bcustom\s*\(/.test(text) ||
    sources.some((source) => !source.lang || !source.baseUrl);
  return {
    name: stringField(text.replace(/source\s*\{[\s\S]*?\}/g, ""), "name"),
    versionCode: Number(/\bversionCode\s*=\s*(\d+)/.exec(text)?.[1] ?? 0),
    contentWarning: /ContentWarning\.(\w+)/.exec(text)?.[1] ?? "SAFE",
    theme: stringField(text, "theme"),
    sources,
    dynamic,
  };
}

/** Kotlin overrides as name -> raw right-hand side (or "fun" for overridden functions). */
function parseOverrides(kotlin) {
  const overrides = {};
  for (const match of kotlin.matchAll(/override\s+(?:val|var)\s+(\w+)(?:\s*:\s*[\w<>?, .]+)?\s*(?:=|get\(\)\s*=)\s*([^\n]+)/g)) {
    overrides[match[1]] = match[2].trim();
  }
  for (const match of kotlin.matchAll(/override\s+fun\s+(\w+)/g)) overrides[match[1]] = "fun";
  // A multi-line `override val x = ...` whose value starts on the next line.
  for (const match of kotlin.matchAll(/override\s+(?:val|var)\s+(\w+)[^=\n]*\n/g)) {
    overrides[match[1]] ??= "complex";
  }
  return overrides;
}

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
};
const normaliseName = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

async function existingSources() {
  const rows = [];
  for (const { dir: directory, manifest } of await discoverSourceDirectories(repo)) {
    rows.push({ key: manifest.source_key, host: hostOf(manifest.base_url), name: normaliseName(manifest.name), directory });
  }
  return rows;
}

export async function buildInventory() {
  const files = await wantedFiles();
  const existing = await existingSources();
  const builds = files.filter((file) => /^src\/[^/]+\/[^/]+\/build\.gradle\.kts$/.test(file));
  const rows = [];
  for (const build of builds) {
    const [, lang, dir] = build.split("/");
    const parsed = parseBuild(await upstreamFile(build));
    const kotlinFiles = files.filter((file) => file.startsWith(`src/${lang}/${dir}/`) && file.endsWith(".kt"));
    const kotlin = (await Promise.all(kotlinFiles.map(upstreamFile))).join("\n");
    const hosts = parsed.sources.map((source) => hostOf(source.baseUrl)).filter(Boolean);
    const ported = existing.find(
      (row) => hosts.includes(row.host) || row.name === normaliseName(parsed.name ?? dir),
    );
    rows.push({
      upstream: `src/${lang}/${dir}`,
      folder: lang,
      dir,
      name: parsed.name ?? dir,
      versionCode: parsed.versionCode,
      contentWarning: parsed.contentWarning,
      theme: parsed.theme,
      sources: parsed.sources,
      dynamic: parsed.dynamic,
      kotlinFiles: kotlinFiles.length,
      kotlinLines: kotlin.split("\n").length,
      overrides: parseOverrides(kotlin),
      ported: ported ? ported.key : null,
    });
  }
  return rows;
}

if (process.argv[1]?.endsWith("inventory.mjs")) {
  const rows = await buildInventory();
  const out = { upstream: "keiyoushi/extensions-source", revision: UPSTREAM_SHA, extensions: rows };
  await fs.writeFile(path.join(here, "inventory.json"), `${JSON.stringify(out, null, 2)}\n`);
  const byTheme = {};
  for (const row of rows) {
    const key = row.theme ?? "(standalone)";
    byTheme[key] ??= { total: 0, ported: 0 };
    byTheme[key].total++;
    if (row.ported) byTheme[key].ported++;
  }
  console.log(`${rows.length} extensions; ${rows.filter((row) => row.ported).length} already ported`);
  console.table(Object.entries(byTheme).sort((a, b) => b[1].total - a[1].total).slice(0, 15).map(([theme, v]) => ({ theme, ...v })));
}
