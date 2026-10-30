// Rawkuma (Japanese raws), a NatsuId-theme WordPress site. Titles come from WordPress's
// own REST API (`/wp-json/wp/v2/manga`, which lists, orders and searches without the
// theme's nonce-protected search form); chapters and pages from the theme's endpoints, as
// in the Keiyoushi "natsuid" library (Apache-2.0); see THIRD_PARTY_NOTICES.md.
import { load } from "cheerio/slim";
import { HttpClient, NAV_HEADERS } from "../../lib/http.js";
import { TTLCache } from "../../lib/cache.js";
import { deriveIsNSFW } from "../../lib/manifest.js";
import {
  MANGA_STATUS,
  chapterNumberFromName,
  normalizeText,
  resolvePagination,
} from "../../lib/parse.js";
import { collectSequentialPages } from "../../lib/sequentialPagination.js";
import { SourceError } from "../../lib/sourceError.js";
import type { Chapters, Mangas, Source, SourceManifest } from "../../lib/types.js";
import manifest from "./manifest.json";

const SOURCE = manifest as SourceManifest;
const BASE = SOURCE.base_url;
const PER_PAGE = 20;
const SLUG = /^[a-z0-9][a-z0-9-]{0,199}$/i;
const PREFIX = `${SOURCE.source_key}:`;

interface Term {
  name: string;
  taxonomy: string;
}
interface WpManga {
  id: number;
  slug: string;
  title: { rendered: string };
  content: { rendered: string };
  meta?: { meta?: { alternative_title?: string } } | null;
  _embedded?: {
    "wp:featuredmedia"?: Array<{ source_url?: string }>;
    "wp:term"?: Term[][];
  };
  yoast_head_json?: { og_image?: Array<{ url: string }> };
}

const http = new HttpClient({
  sourceId: SOURCE.source_key,
  sourceName: SOURCE.name,
  baseUrl: BASE,
  headers: { ...NAV_HEADERS, Referer: `${BASE}/` },
  rateLimitMs: 400,
});
const cache = new TTLCache<string, WpManga>(60_000, 60);

const fail = (message: string): never => {
  throw new SourceError("PARSE_ERROR", `${SOURCE.name}: ${message}`, SOURCE.source_key);
};
const text = (html: string) => normalizeText(load(`<div>${html}</div>`)("div").text());
const terms = (manga: WpManga, taxonomy: string) =>
  (manga._embedded?.["wp:term"] ?? []).find((group) => group[0]?.taxonomy === taxonomy)?.map((term) => term.name) ??
  [];
const isNovel = (manga: WpManga) => terms(manga, "type").includes("Novel");
const cover = (manga: WpManga) =>
  manga._embedded?.["wp:featuredmedia"]?.[0]?.source_url ?? manga.yoast_head_json?.og_image?.[0]?.url ?? "";

function card(manga: WpManga): Mangas {
  return {
    id: manga.slug,
    slug: manga.slug,
    title: text(manga.title.rendered),
    source: SOURCE.source_key,
    thumbnail_url: cover(manga),
  };
}

async function list(page: number, params: Record<string, string>): Promise<Mangas[]> {
  const url = new URL("/wp-json/wp/v2/manga", BASE);
  url.searchParams.set("per_page", String(PER_PAGE));
  url.searchParams.set("page", String(page));
  url.searchParams.set("_embed", "");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  let rows: WpManga[];
  try {
    rows = await http.getJson<WpManga[]>(url.href);
  } catch (error) {
    // Past the last page WordPress answers 400 "rest_post_invalid_page_number".
    if (page > 1 && error instanceof SourceError) return [];
    throw error;
  }
  return rows.filter((manga) => !isNovel(manga) && SLUG.test(manga.slug)).map((manga) => {
    cache.set(manga.slug, manga);
    return card(manga);
  });
}

async function mangaOf(slug: string): Promise<WpManga> {
  if (!SLUG.test(slug)) return fail("Invalid title identifier");
  const cached = cache.get(slug);
  if (cached) return cached;
  const url = new URL("/wp-json/wp/v2/manga", BASE);
  url.searchParams.append("slug[]", slug);
  url.searchParams.set("_embed", "");
  const [manga] = await http.getJson<WpManga[]>(url.href);
  if (!manga) throw new SourceError("NOT_FOUND", `Not found on ${SOURCE.name}.`, SOURCE.source_key);
  cache.set(slug, manga);
  return manga;
}

async function chaptersOf(slug: string): Promise<Chapters[]> {
  const manga = await mangaOf(slug);
  const url = new URL("/wp-admin/admin-ajax.php", BASE);
  url.searchParams.set("manga_id", String(manga.id));
  // A high page number makes the theme list every chapter, hidden ones included.
  url.searchParams.set("page", "9999");
  url.searchParams.set("action", "chapter_list");
  const $ = load(await http.getText(url.href));
  return $("div a:has(time)")
    .toArray()
    .flatMap((el) => {
      const href = $(el).attr("href") ?? "";
      const path = (() => {
        try {
          const target = new URL(href, BASE);
          return target.origin === new URL(BASE).origin ? target.pathname : "";
        } catch {
          return "";
        }
      })();
      if (!path || !/^\/[^?#]+$/.test(path)) return [];
      const name = normalizeText($(el).find("span").first().contents().filter((_, node) => node.type === "text").text() || $(el).find("span").first().text());
      const datetime = $(el).find("time").attr("datetime");
      const date = datetime ? new Date(datetime) : null;
      return [
        {
          id: `${PREFIX}${path}`,
          name,
          url: `${BASE}${path}`,
          chapter_number: chapterNumberFromName(name, 0),
          release_date: date && !Number.isNaN(date.getTime()) ? date.toISOString() : "",
          language: SOURCE.lang,
          last_page_read: 0,
          pages: [],
        },
      ];
    })
    .sort((a, b) => b.chapter_number - a.chapter_number);
}

const STATUS: Array<[string, string]> = [
  ["Ongoing", MANGA_STATUS.ONGOING],
  ["Completed", MANGA_STATUS.COMPLETED],
  ["Cancelled", MANGA_STATUS.CANCELLED],
  ["On Hiatus", MANGA_STATUS.HIATUS],
];

const source: Source = {
  id: SOURCE.source_key,
  name: SOURCE.name,
  lang: SOURCE.lang,
  base_url: BASE,
  isNSFW: deriveIsNSFW(SOURCE.content_rating),
  async fetchManga(category, pagination) {
    return collectSequentialPages(
      resolvePagination(pagination, { limit: PER_PAGE }),
      SOURCE.source_key,
      // The REST API has no view counts: "popular" is newest additions, "latest" the most
      // recently updated.
      (page) => list(page, { orderby: category === "latest" ? "modified" : "date" }),
    );
  },
  async searchManga(query = "", pagination) {
    if (!query.trim()) return source.fetchManga("popular", pagination);
    return collectSequentialPages(
      resolvePagination(pagination, { limit: PER_PAGE }),
      SOURCE.source_key,
      (page) => list(page, { search: query.trim() }),
    );
  },
  async fetchMangaDetails(slug) {
    const manga = await mangaOf(slug);
    const status = terms(manga, "status");
    const alt = (manga.meta?.meta?.alternative_title ?? "")
      .split(",")
      .map((name) => text(name))
      .filter((name) => name && name !== text(manga.title.rendered));
    return {
      ...card(manga),
      url: `${BASE}/manga/${manga.slug}/`,
      author: terms(manga, "series-author"),
      artist: terms(manga, "artist"),
      genres: [...new Set([...terms(manga, "genre"), ...terms(manga, "type")])],
      status: STATUS.find(([word]) => status.includes(word))?.[1] ?? MANGA_STATUS.UNKNOWN,
      description: [text(manga.content.rendered), alt.length ? `Alternative names:\n${alt.map((name) => `- ${name}`).join("\n")}` : ""]
        .filter(Boolean)
        .join("\n\n"),
      chapters: await chaptersOf(slug),
    };
  },
  async fetchMangaThumbnail(slug) {
    try {
      return cover(await mangaOf(slug));
    } catch {
      return "";
    }
  },
  fetchChapters: chaptersOf,
  async fetchChapterPages(chapterId, _slug, pagination) {
    if (!chapterId.startsWith(PREFIX)) return fail("Invalid chapter identifier");
    const path = chapterId.slice(PREFIX.length);
    if (!/^\/[^?#]+$/.test(path) || path.includes("..")) return fail("Invalid chapter identifier");
    const $ = load(await http.getText(`${BASE}${path}`));
    const images = $("section[data-image-data] img")
      .map((_, el) => $(el).attr("src") ?? "")
      .get()
      .filter(Boolean)
      .map((src) => new URL(src, BASE).href);
    if (images.length === 0)
      throw new SourceError(
        "PARSE_ERROR",
        `${SOURCE.name} returned no readable pages for this chapter — it may have changed its layout.`,
        SOURCE.source_key,
      );
    const { limit, offset } = resolvePagination(pagination, { limit: images.length });
    const start = Math.min(offset, images.length);
    return {
      items: images
        .slice(start, start + Math.max(1, limit))
        .map((image_url, index) => ({ index: start + index + 1, image_url })),
      total: images.length,
    };
  },
  async getFilters() {
    return [];
  },
  async fetchMangaUpdates(slug) {
    cache.clear();
    return chaptersOf(slug);
  },
};

export default source;
