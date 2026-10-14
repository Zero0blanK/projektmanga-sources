import { attachHtmlCatalogue } from "../lib/nativeCatalogue.js";
import { load } from "cheerio/slim";
import type {
  Chapters,
  FilterValue,
  MangaFilter,
  Mangas,
  Source,
} from "../lib/types.js";
import { HttpClient, NAV_HEADERS } from "../lib/http.js";
import { TTLCache } from "../lib/cache.js";
import {
  normalizeText,
  parseDateToIso,
  resolvePagination,
} from "../lib/parse.js";
import { deriveIsNSFW } from "../lib/manifest.js";
import { collectSequentialPages } from "../lib/sequentialPagination.js";
import { SourceError } from "../lib/sourceError.js";
import manifest from "./manifest.json";

const http = new HttpClient({
  sourceId: manifest.source_key,
  sourceName: manifest.name,
  baseUrl: manifest.base_url,
  headers: NAV_HEADERS,
  rateLimitMs: 700,
});
const cache = new TTLCache<string, string>(120_000, 40),
  html = (url: string) => cache.getOrSet(url, () => http.getText(url));
const languages: Record<string, { name: string; parameter: string }> = {
  en: { name: "english", parameter: "en" },
  ja: { name: "japanese", parameter: "jp" },
  es: { name: "spanish", parameter: "es" },
  fr: { name: "french", parameter: "fr" },
  ko: { name: "korean", parameter: "kr" },
  de: { name: "german", parameter: "de" },
  ru: { name: "russian", parameter: "ru" },
};
function fail(message: string): never {
  throw new SourceError("PARSE_ERROR", message, manifest.source_key);
}
function galleryId(value: string): string {
  const id = value.startsWith("imhentai:gallery:")
    ? value.slice("imhentai:gallery:".length)
    : value;
  if (!/^\d+$/.test(id) || id.length > 20)
    return fail("Invalid IMHentai gallery identifier");
  return id;
}
function image(value: string): string {
  if (!value.trim()) return "";
  try {
    const url = new URL(value, manifest.base_url);
    if (
      url.protocol !== "https:" ||
      !(
        url.hostname === "imhentai.xxx" ||
        url.hostname.endsWith(".imhentai.xxx")
      )
    )
      return fail("IMHentai image host was not verified");
    return url.href;
  } catch (error) {
    if (error instanceof SourceError) throw error;
    return "";
  }
}
const imgValue = (attributes: Record<string, string>) =>
  attributes["data-src"] || attributes["data-lazy-src"] || attributes.src || "";
function info(text: string, id: string) {
  const $ = load(text),
    root = $(".gallery_first").first(),
    title = normalizeText(root.find("h1").first().text()),
    cover = image(imgValue(root.find(".left_cover img").first().attr() ?? {}));
  if (!title || !cover) return fail("IMHentai gallery metadata was not found");
  const value = (key: string) =>
    root
      .find(`li:has(.tags_text:contains(${key}:)) a.tag`)
      .toArray()
      .map((el) =>
        normalizeText($(el).clone().children().remove().end().text()),
      )
      .filter(Boolean);
  const rawCount = $("input#load_pages").attr("value") || "",
    count = Number(rawCount);
  if (
    !/^\d+$/.test(rawCount) ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > 10000
  )
    return fail("IMHentai gallery page count is invalid");
  const suppliedId = $("input#gallery_id").attr("value");
  if (suppliedId && suppliedId !== id)
    return fail("IMHentai gallery identity does not match the request");
  const language = value("Languages")[0]?.toLowerCase(),
    lang =
      Object.entries(languages).find(
        ([, entry]) => entry.name === language,
      )?.[0] ?? "all";
  return { $, root, title, cover, count, value, lang };
}
function metadataPages(text: string, id: string): Map<number, string> {
  const { $, cover, count } = info(text, id),
    script = $("script")
      .toArray()
      .map((el) => $(el).html() ?? "")
      .find((body) => body.includes("$.parseJSON("));
  if (!script) return new Map();
  const match = /\$\.parseJSON\(\s*'([^']+)'\s*\)/.exec(script);
  if (!match) return fail("IMHentai page metadata is malformed");
  let data: unknown;
  try {
    data = JSON.parse(match[1]);
  } catch {
    return fail("IMHentai page metadata is malformed");
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    return fail("IMHentai page metadata is malformed");
  const directory = $("input#load_dir").attr("value") || "",
    mediaId = $("input#load_id").attr("value") || "",
    server = $("input#load_server").attr("value") || "";
  if (
    !/^[a-zA-Z0-9_-]+$/.test(directory) ||
    !/^[a-zA-Z0-9_-]+$/.test(mediaId) ||
    (server && !/^\d{1,3}$/.test(server))
  )
    return fail("IMHentai image directory metadata is invalid");
  const host = server ? `m${server}.imhentai.xxx` : new URL(cover).host,
    formats: Record<string, string> = {
      j: "jpg",
      p: "png",
      w: "webp",
      g: "gif",
      b: "bmp",
    },
    pages = new Map<number, string>();
  for (const [index, raw] of Object.entries(data)) {
    const number = Number(index),
      format = typeof raw === "string" ? raw.split(",")[0] : "";
    if (
      !/^\d+$/.test(index) ||
      !Number.isSafeInteger(number) ||
      number < 1 ||
      number > count ||
      !formats[format]
    )
      return fail("IMHentai page metadata contains invalid entries");
    pages.set(
      number,
      image(
        `https://${host}/${directory}/${mediaId}/${number}.${formats[format]}`,
      ),
    );
  }
  return pages;
}
function catalogueUrl(
  category: string,
  query: string,
  filters: Record<string, FilterValue>,
  page: number,
) {
  const selected =
    typeof filters.language === "string" ? filters.language : "all";
  if (selected !== "all" && !languages[selected])
    return fail("Unsupported IMHentai language filter");
  let url: URL;
  if (query.trim()) {
    url = new URL("/search/", manifest.base_url);
    url.searchParams.set("key", query.trim());
    url.searchParams.set("pp", category === "popular" ? "1" : "0");
    url.searchParams.set("lt", category === "popular" ? "0" : "1");
    for (const [code, entry] of Object.entries(languages))
      url.searchParams.set(
        entry.parameter,
        selected === "all" || selected === code ? "1" : "0",
      );
  } else
    url = new URL(
      `${selected === "all" ? "/" : `/language/${languages[selected].name}/`}${category === "popular" ? "popular/" : ""}`,
      manifest.base_url,
    );
  url.searchParams.set("page", String(page));
  return url;
}
function parseCards(text: string): Mangas[] {
  if (text.includes("Overload... Please use the advanced search"))
    throw new SourceError(
      "RATE_LIMITED",
      "IMHentai search is overloaded; retry later",
      manifest.source_key,
    );
  const $ = load(text);
  return $("div.thumb")
    .toArray()
    .map((el) => {
      const card = $(el),
        href = card.find(".inner_thumb a").first().attr("href") || "",
        url = new URL(href, manifest.base_url),
        match = /^\/gallery\/(\d+)\/?$/.exec(url.pathname),
        title = normalizeText(card.find(".caption").text());
      if (url.origin !== manifest.base_url || !match || !title)
        return fail("IMHentai catalogue markup changed");
      const id = galleryId(match[1]);
      return {
        id,
        slug: id,
        title,
        source: manifest.source_key,
        thumbnail_url: image(
          imgValue(card.find(".inner_thumb img").first().attr() ?? {}),
        ),
      };
    });
}
async function browse(
  category: string,
  query: string,
  pagination: Parameters<Source["fetchManga"]>[1],
  filters: Record<string, FilterValue> = {},
): Promise<Mangas[]> {
  const selected =
    typeof filters.language === "string" ? filters.language : "all";
  if (selected !== "all" && !languages[selected])
    return fail("Unsupported IMHentai language filter");
  return collectSequentialPages(
    resolvePagination(pagination, { limit: 20 }),
    manifest.source_key,
    async (page) => {
      const url = catalogueUrl(category, query, filters, page);
      return parseCards(await html(url.href));
    },
  );
}
const source: Source = {
  id: manifest.source_key,
  name: manifest.name,
  lang: manifest.lang,
  base_url: manifest.base_url,
  isNSFW: deriveIsNSFW(manifest.content_rating),
  fetchManga: (category = "latest", pagination, filters) =>
    browse(category, "", pagination, filters),
  searchManga: (query = "", pagination, filters) =>
    browse("latest", query, pagination, filters),
  async fetchMangaDetails(value) {
    const id = galleryId(value),
      text = await html(`/gallery/${id}/`),
      data = info(text, id);
    return {
      id,
      slug: id,
      title: data.title,
      source: manifest.source_key,
      thumbnail_url: data.cover,
      author: data.value("Artists"),
      groups: data.value("Groups"),
      genres: data.value("Tags"),
      description: data.value("Languages").join(", "),
      status: "COMPLETED",
      chapters: await source.fetchChapters(id),
    };
  },
  async fetchChapters(value): Promise<Chapters[]> {
    const id = galleryId(value),
      data = info(await html(`/gallery/${id}/`), id);
    return [
      {
        id: `imhentai:gallery:${id}`,
        url: `${manifest.base_url}/gallery/${id}/`,
        name: "Gallery",
        chapter_number: 1,
        scanlator: data.value("Groups").join(", ") || "Unknown",
        language: data.lang,
        page_count: data.count,
        release_date: parseDateToIso(data.root.find(".uploaded").text()),
        last_page_read: 0,
        pages: [],
      },
    ];
  },
  async fetchChapterPages(value, _slug, pagination) {
    const id = galleryId(value),
      text = await html(`/gallery/${id}/`),
      data = info(text, id),
      known = metadataPages(text, id),
      { limit, offset } = resolvePagination(pagination, { limit: data.count }),
      items = [];
    for (
      let index = Math.floor(offset) + 1;
      index <= Math.min(data.count, Math.floor(offset) + Math.floor(limit));
      index++
    ) {
      let image_url = known.get(index);
      if (!image_url) {
        const $ = load(await html(`/view/${id}/${index}/`));
        image_url = image(
          imgValue($("img#gimg, img#fimg, img#readerImg").first().attr() ?? {}),
        );
        if (!image_url) return fail("IMHentai reader image was not found");
      }
      items.push({ index, image_url });
    }
    return { total: data.count, items };
  },
  async getFilters(): Promise<MangaFilter[]> {
    return [
      {
        label: "Language",
        value: "language",
        type: "select",
        options: [
          { label: "All languages", value: "all" },
          ...Object.entries(languages).map(([value, entry]) => ({
            label: entry.name,
            value,
          })),
        ],
      },
    ];
  },
  fetchMangaUpdates: (id) => source.fetchChapters(id),
};
export default attachHtmlCatalogue(source, {
  getText: html,
  parse: parseCards,
  path: ({ category, query, filters }) =>
    catalogueUrl(category || "latest", query || "", filters, 1).href,
  route:
    /^\/(?:|popular\/|search\/|language\/(?:english|japanese|spanish|french|korean|german|russian)\/(?:popular\/)?)$/,
  capabilities: { languageFilter: true },
});
