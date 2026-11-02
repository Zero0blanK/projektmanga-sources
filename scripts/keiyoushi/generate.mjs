// Generates ProjektManga sources for Keiyoushi extensions built on a theme this repository
// already has an engine for, when every upstream override maps onto that engine's options.
// Anything else is listed as a hand port, never generated half-right.
//   node scripts/keiyoushi/generate.mjs [--write] [--only key,key]
// Without --write it only prints what it would do. Reads inventory.json and triage.json;
// --write fetches each site's search form once for its genre list.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "cheerio";
import { UPSTREAM_SHA, upstreamFile, wantedFiles } from "./fetch.mjs";
import { discoverSourceDirectories } from "../source-layout.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const write = process.argv.includes("--write");
const onlyArg = process.argv[process.argv.indexOf("--only") + 1];
const only = process.argv.includes("--only") ? new Set(onlyArg.split(",")) : null;
const inventory = JSON.parse(await fs.readFile(path.join(here, "inventory.json"), "utf8"));
const triage = JSON.parse(await fs.readFile(path.join(here, "triage.json"), "utf8"));
// Per-site engine options found while accepting generated sources (e.g. a Madara install
// whose directory page is script-filled and needs the AJAX listing).
const siteOptions = JSON.parse(
  await fs.readFile(path.join(here, "site-options.json"), "utf8").catch(() => "{}"),
);
// Sources this script wrote can be rewritten; any other existing key is a hand port.
const existingKeys = new Set();
for (const source of await discoverSourceDirectories(repo)) {
  const entry = await fs.readFile(source.entryPoint, "utf8");
  if (!entry.includes("Generated from the Keiyoushi extension")) existingKeys.add(source.key);
}
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Overrides that either map onto an engine option or don't change what is parsed (a
 * rate limit, a date format the shared parser already reads, filter plumbing replaced by
 * the site's own form). Any other override makes the extension a hand port. */
const HARMLESS = ["OkHttpClient", "client"];
const SUPPORTED = {
  madara: [
    ...HARMLESS,
    "chapterMode",
    "mangaSubString",
    "chapterDateFormat",
    "filterNonMangaItems",
    "supportsPostId",
    "genreDirectory",
    "sendViewCount",
    "getFilterList",
    "orderByFilterOptions",
    "statusFilterOptions",
    "genreConditionFilterOptions",
    "adultFilterOptions",
    "supportsFilterFetching",
    "pageSize",
    "useLoadMoreRequest",
    "fetchGenres",
  ],
  mangathemesia: [...HARMLESS, "datePattern", "dateFormat", "mangaUrlDirectory"],
  keyoapp: HARMLESS,
  iken: HARMLESS,
  mangabox: HARMLESS,
  // The title list, and the older card layout's details, chapter table and page images;
  // `catalogueOptions` turns those into engine options or a hand-port reason.
  yiimanga: [...HARMLESS, "mangaPath", "searchParam", "popularPath", "supportsFilterFetching"],
  vinetheme: HARMLESS,
  guya: HARMLESS,
  // enableLogin/fetchBadge only add an account sign-in and a format badge.
  heancms: [...HARMLESS, "latestSortBy", "enableLogin", "fetchBadge"],
  mangacatalog: [
    ...HARMLESS,
    "sourceList",
    "mangaDetailsParse",
    "chapterListSelector",
    "chapterFromElement",
    "pageListParse",
  ],
};

const THEME_LABEL = {
  madara: "Madara",
  mangathemesia: "MangaThemesia",
  keyoapp: "Keyoapp",
  iken: "Iken",
  mangabox: "MangaBox",
  mangacatalog: "MangaCatalog",
  yiimanga: "Yiimanga",
  vinetheme: "VineTheme",
  heancms: "HeanCMS",
  guya: "Guya",
};

const upstreamFiles = await wantedFiles();
async function kotlinOf(row) {
  const files = upstreamFiles.filter((file) => file.startsWith(`${row.upstream}/`) && file.endsWith(".kt"));
  return (await Promise.all(files.map(upstreamFile))).join("\n");
}

/** A MangaCatalog site's titles and layout from its Kotlin, or why it can't be generated. */
async function catalogueOptions(row) {
  // Commented-out entries are titles upstream dropped (a video, a PDF).
  const kotlin = (await kotlinOf(row)).replace(/^\s*\/\/.*$/gm, "");
  const titles = [...kotlin.matchAll(/Pair\(\s*"([^"]+)",\s*"\$baseUrl\/manga\/([a-z0-9-]+)\/"\s*\)/g)].map(
    ([, title, slug]) => ({ title, slug }),
  );
  if (!titles.length) return { hand: "title list not in the $baseUrl/manga/<slug>/ form" };
  const card = /card-img-right/.test(kotlin) && /tbody > tr/.test(kotlin);
  if (row.overrides.mangaDetailsParse && !card) return { hand: "custom details layout" };
  if (row.overrides.pageListParse && !/pages__img/.test(kotlin)) return { hand: "custom page images" };
  return { titles, ...(card ? { layout: "card" } : {}) };
}

/** Hosts every site on a theme reaches besides its own (a shared API). */
const THEME_HOSTS = {};

const unquote = (value) => /^"([^"]*)"$/.exec(value ?? "")?.[1];
const RATING = { SAFE: "safe", MIXED: "mixed", NSFW: "nsfw" };

function sitesOf(row) {
  return row.sources.map((source) => {
    const probe = triage[`${row.upstream}|${source.baseUrl}`];
    const baseUrl = probe?.status === "moved" ? probe.url : source.baseUrl.replace(/\/+$/, "");
    return { ...source, baseUrl, status: probe?.status ?? "unprobed" };
  });
}

/** What the engine call needs, or a reason the extension can't be generated. */
async function plan(row) {
  const supported = SUPPORTED[row.theme];
  if (!supported) return { skip: "theme without an engine" };
  if (row.ported) return { skip: `already ported as ${row.ported}` };
  if (row.dynamic) return { skip: "generated or mirrored base URLs" };
  const extra = Object.keys(row.overrides).filter((name) => !supported.includes(name));
  if (extra.length) return { hand: `overrides ${extra.join(", ")}` };
  const sites = sitesOf(row);
  const unusable = sites.filter((site) => site.status !== "alive" && site.status !== "moved");
  if (unusable.length) return { skip: `site ${unusable.map((site) => site.status).join("/")}` };
  if (sites.length !== 1) return { hand: "several sources in one extension" };
  const site = sites[0];
  if (!site.baseUrl.startsWith("https://")) return { skip: "not served over https" };
  const key = row.dir.toLowerCase();
  if (existingKeys.has(key)) return { skip: `key ${key} is a hand port` };
  const options = {};
  if (row.theme === "madara") {
    const mode = row.overrides.chapterMode ?? "";
    options.ajaxChapters = /MangaAjaxPaginated/.test(mode)
      ? "paginated"
      : /MangaAjax|AdminAjax/.test(mode)
        ? true
        : false;
    options.directory = unquote(row.overrides.mangaSubString) ?? "manga";
    // A Madara novel site serves chapters as text, which the reader can't show.
    if (options.directory === "novel") return { skip: "text novels" };
    if (row.overrides.mangaSubString && !unquote(row.overrides.mangaSubString))
      return { hand: "computed mangaSubString" };
  }
  if (row.theme === "mangathemesia") {
    const directory = unquote(row.overrides.mangaUrlDirectory) ?? "/manga";
    if (row.overrides.mangaUrlDirectory && !unquote(row.overrides.mangaUrlDirectory))
      return { hand: "computed mangaUrlDirectory" };
    options.cataloguePath = `/${directory.replace(/^\/+|\/+$/g, "")}/`;
  }
  if (row.theme === "yiimanga") {
    for (const name of ["mangaPath", "searchParam", "popularPath"]) {
      if (!row.overrides[name]) continue;
      const value = unquote(row.overrides[name]);
      if (!value) return { hand: `${name} not a literal` };
      options[name] = value;
    }
    if (!options.mangaPath) return { hand: "no mangaPath" };
  }
  if (row.theme === "heancms" && row.overrides.latestSortBy) {
    const value = unquote(row.overrides.latestSortBy);
    if (value !== "asc" && value !== "desc") return { hand: "latestSortBy not asc/desc" };
    options.latestSortBy = value;
  }
  if (row.theme === "mangacatalog") {
    const catalogue = await catalogueOptions(row);
    if (catalogue.hand) return catalogue;
    Object.assign(options, catalogue);
  }
  return { key, site, options: { ...options, ...siteOptions[key] } };
}

async function getHtml(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html,*/*;q=0.8" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`${response.status}`);
  return response.text();
}

/** The genre checkboxes of a site's own filter form. */
function genresFrom(html) {
  const $ = load(html);
  const seen = new Set();
  const options = [];
  $('input[name="genre[]"]').each((_, element) => {
    const value = $(element).attr("value")?.trim();
    const id = $(element).attr("id");
    const label = (
      (id && $(`label[for="${id}"]`).first().text()) ||
      $(element).parent("label").text() ||
      $(element).next("label").text() ||
      value ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim();
    if (!value || !label || seen.has(value)) return;
    seen.add(value);
    options.push({ label, value });
  });
  return options;
}

async function filtersFor(theme, site, options) {
  if (theme === "madara") {
    const template = JSON.parse(await fs.readFile(path.join(repo, "src/en/lilymanga/filters.json"), "utf8"));
    const genres = genresFrom(await getHtml(`${site.baseUrl}/?s=&post_type=wp-manga`).catch(() => ""));
    return template
      .filter((filter) => filter.value !== "genre")
      .concat(genres.length ? [{ label: "Genres", value: "genre", type: "multi", options: genres }] : []);
  }
  if (theme === "mangathemesia") {
    const template = JSON.parse(await fs.readFile(path.join(repo, "src/en/arenascans/filters.json"), "utf8"));
    const genres = genresFrom(await getHtml(`${site.baseUrl}${options.cataloguePath}`).catch(() => ""));
    return template
      .filter((filter) => filter.value !== "genre")
      .concat(genres.length ? [{ label: "Genres", value: "genre", type: "multi", options: genres }] : []);
  }
  if (theme === "yiimanga") {
    const $ = load(await getHtml(site.baseUrl).catch(() => ""));
    const seen = new Set();
    const genres = [];
    $(".genre-list a, a.item-nav[href*='/genre/'], a.item-nav-mb[href*='/genre/']").each((_, element) => {
      const href = $(element).attr("href") ?? "";
      const slug = /\/genre\/([a-z0-9-]+)/.exec(href)?.[1];
      const label = $(element).text().replace(/\s+/g, " ").trim();
      if (!slug || !label || seen.has(slug)) return;
      seen.add(slug);
      genres.push({ label, value: slug });
    });
    genres.sort((a, b) => a.label.localeCompare(b.label));
    return genres.length
      ? [{ label: "Genre (ignored with a text search)", value: "genre", type: "select", options: [{ label: "All", value: "" }, ...genres] }]
      : [];
  }
  return null;
}

function entryPoint(row, options, hasFilters) {
  const label = THEME_LABEL[row.theme];
  const header = `// ${row.name}: ${label} theme. Generated from the Keiyoushi extension
// ${row.upstream} @ ${UPSTREAM_SHA.slice(0, 10)} (Apache-2.0); see THIRD_PARTY_NOTICES.md.
`;
  const manifestImport = `import manifest from "./manifest.json";\n`;
  const filtersImport = hasFilters ? `import filters from "./filters.json";\n` : "";
  switch (row.theme) {
    case "madara": {
      const args = ["manifest as SourceManifest", "filters as MangaFilter[]", JSON.stringify(options.ajaxChapters)];
      if (options.directory !== "manga" || options.browse)
        args.push('".reading-content img"', JSON.stringify(options.directory));
      if (options.browse) args.push(JSON.stringify({ browse: options.browse }));
      return `${header}import { createMadaraSite } from "../../lib/madaraSite.js";
import type { MangaFilter, SourceManifest } from "../../lib/types.js";
${manifestImport}${filtersImport}export default createMadaraSite(${args.join(", ")});
`;
    }
    case "mangathemesia":
      return `${header}import { createThemesiaSite } from "../../lib/themesiaSite.js";
import type { MangaFilter, SourceManifest } from "../../lib/types.js";
${manifestImport}${filtersImport}export default createThemesiaSite(manifest as SourceManifest, filters as MangaFilter[], ${JSON.stringify(options.cataloguePath)});
`;
    case "keyoapp":
      return `${header}import { createKeyoappSite } from "../../lib/keyoapp.js";
import type { SourceManifest } from "../../lib/types.js";
${manifestImport}export default createKeyoappSite(manifest as SourceManifest, {});
`;
    case "iken":
      return `${header}import { createIkenSite } from "../../lib/iken.js";
import type { SourceManifest } from "../../lib/types.js";
${manifestImport}export default createIkenSite(manifest as SourceManifest, {});
`;
    case "yiimanga":
      return `${header}import { createYiimangaSite } from "../../lib/yiimanga.js";
import type { MangaFilter, SourceManifest } from "../../lib/types.js";
${manifestImport}${filtersImport}export default createYiimangaSite(manifest as SourceManifest, ${hasFilters ? "filters as MangaFilter[]" : "[]"}, ${JSON.stringify(options)});
`;
    case "guya":
      return `${header}import { createGuyaSite } from "../../lib/guya.js";
import type { SourceManifest } from "../../lib/types.js";
${manifestImport}export default createGuyaSite(manifest as SourceManifest);
`;
    case "heancms":
      return `${header}import { createHeanCmsSite } from "../../lib/heanCms.js";
import type { SourceManifest } from "../../lib/types.js";
${manifestImport}export default createHeanCmsSite(manifest as SourceManifest, ${JSON.stringify(options)});
`;
    case "vinetheme":
      return `${header}import { createVineThemeSite } from "../../lib/vineTheme.js";
import type { SourceManifest } from "../../lib/types.js";
${manifestImport}export default createVineThemeSite(manifest as SourceManifest);
`;
    case "mangacatalog":
      return `${header}import { createMangaCatalogSite } from "../../lib/mangaCatalog.js";
import type { SourceManifest } from "../../lib/types.js";
${manifestImport}export default createMangaCatalogSite(manifest as SourceManifest, ${JSON.stringify(options, null, 2)});
`;
    case "mangabox":
      return `${header}import { createMangaBoxSite } from "../../lib/mangaBox.js";
import type { SourceManifest } from "../../lib/types.js";
${manifestImport}export default createMangaBoxSite(manifest as SourceManifest);
`;
  }
}

const generated = [];
const hand = [];
const skipped = [];
for (const row of inventory.extensions) {
  const result = await plan(row);
  if (only && !only.has(result.key ?? row.dir.toLowerCase())) continue;
  if (result.hand) hand.push({ upstream: row.upstream, theme: row.theme, why: result.hand });
  else if (result.skip) {
    if (SUPPORTED[row.theme]) skipped.push({ upstream: row.upstream, why: result.skip });
  } else generated.push({ row, ...result });
}

for (const { row, key, site, options } of generated) {
  const folder = row.folder;
  const dir = path.join(repo, "src", folder, key);
  const host = new URL(site.baseUrl).hostname;
  const manifest = {
    $schema: "../../../schema/manifest.schema.json",
    source_key: key,
    name: row.name,
    lang: site.lang,
    version: "1.0.0",
    description:
      row.theme === "mangacatalog"
        ? `${row.name}: one franchise's manga (${options.titles.map((title) => title.title).slice(0, 4).join(", ")}${options.titles.length > 4 ? "…" : ""}).`
        : `${row.name}: a ${THEME_LABEL[row.theme]}-theme manga site.`,
    base_url: site.baseUrl,
    allowed_hosts: [host.replace(/^www\./, ""), ...(THEME_HOSTS[row.theme] ?? [])],
    content_rating: RATING[row.contentWarning] ?? "mixed",
  };
  console.log(`${write ? "write" : "would write"} src/${folder}/${key} (${row.theme} ${JSON.stringify(options)})`);
  if (!write) continue;
  const filters = await filtersFor(row.theme, site, options);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  if (filters) await fs.writeFile(path.join(dir, "filters.json"), `${JSON.stringify(filters, null, 2)}\n`);
  await fs.writeFile(path.join(dir, "index.ts"), entryPoint(row, options, Boolean(filters)));
}

if (!only) await fs.writeFile(
  path.join(here, "generate-report.json"),
  `${JSON.stringify({ revision: UPSTREAM_SHA, generated: generated.map((item) => ({ key: item.key, upstream: item.row.upstream, theme: item.row.theme, options: item.options })), hand, skipped }, null, 2)}\n`,
);
console.log(`generated ${generated.length}, hand ports ${hand.length}, skipped ${skipped.length}`);
