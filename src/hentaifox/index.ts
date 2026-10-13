import { load } from "cheerio/slim";
import type { Source, Chapters, Mangas } from "../lib/types.js";
import { HttpClient, NAV_HEADERS } from "../lib/http.js";
import { TTLCache } from "../lib/cache.js";
import { collectPaged } from "../lib/paginate.js";
import {
  normalizeText,
  resolvePagination,
  toAbsoluteUrl,
} from "../lib/parse.js";
import { SourceError } from "../lib/sourceError.js";
import { deriveIsNSFW } from "../lib/manifest.js";
import type { SourceManifest } from "../lib/types.js";
import manifest from "./manifest.json";
const http = new HttpClient({
  sourceId: manifest.source_key,
  sourceName: manifest.name,
  baseUrl: manifest.base_url,
  headers: NAV_HEADERS,
  rateLimitMs: 700,
});
const cache = new TTLCache<string, string>(120_000, 40);
const html = (path: string) => cache.getOrSet(path, () => http.getText(path));
function galleryPath(id: string) {
  if (!/^\d+$/.test(id))
    throw new SourceError(
      "PARSE_ERROR",
      "Invalid gallery identifier",
      manifest.source_key,
    );
  return `/gallery/${id}/`;
}
function gallery(text: string) {
  const $ = load(text),
    raw = text.match(/var\s+g_th\s*=\s*\$\.parseJSON\('([^']+)'\)/)?.[1];
  if (!raw)
    throw new SourceError(
      "PARSE_ERROR",
      "Gallery page metadata was not found",
      manifest.source_key,
    );
  let sizes: unknown;
  try {
    sizes = JSON.parse(raw);
  } catch {
    throw new SourceError(
      "PARSE_ERROR",
      "Invalid gallery page metadata",
      manifest.source_key,
    );
  }
  if (!sizes || typeof sizes !== "object" || Array.isArray(sizes))
    throw new SourceError(
      "PARSE_ERROR",
      "Invalid gallery page metadata",
      manifest.source_key,
    );
  const cover = $(".cover img").attr("src") || "";
  const base = cover.replace(/\/cover\.[a-z]+(?:\?.*)?$/, "/");
  if (base === cover || !/^https:\/\/[a-z0-9.-]+\.hentaifox\.com\//.test(base))
    throw new SourceError(
      "PARSE_ERROR",
      "Invalid gallery image host",
      manifest.source_key,
    );
  const formats: Record<string, string> = { w: "webp", j: "jpg", p: "png" };
  const urls = Object.entries(sizes)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([n, value], index) => {
      const ext =
        typeof value === "string" ? formats[value.split(",")[0]] : undefined;
      if (Number(n) !== index + 1 || !ext)
        throw new SourceError(
          "PARSE_ERROR",
          "Unsupported gallery page metadata",
          manifest.source_key,
        );
      return `${base}${n}.${ext}`;
    });
  if (!urls.length)
    throw new SourceError(
      "PARSE_ERROR",
      "Gallery has no readable pages",
      manifest.source_key,
    );
  return { $, cover, urls };
}
async function browse(
  query: string | null,
  pagination: Parameters<Source["fetchManga"]>[1],
): Promise<Mangas[]> {
  const { limit, offset } = resolvePagination(pagination, { limit: 30 });
  return collectPaged({ limit, offset, sitePageSize: 30 }, async (page) => {
    const path =
      query === null
        ? page === 1
          ? "/"
          : `/page/${page}/`
        : `/search/?q=${encodeURIComponent(query)}&page=${page}`;
    const $ = load(await html(path));
    return $(".thumb")
      .map((_, el) => {
        const node = $(el),
          link = node.find(".g_title a").first(),
          id = (link.attr("href") || "").match(/^\/gallery\/(\d+)\/$/)?.[1];
        if (!id) return null;
        const img = node.find("img").first();
        return {
          id,
          slug: id,
          source: manifest.source_key,
          title: normalizeText(link.text()) || `Untitled gallery ${id}`,
          thumbnail_url: toAbsoluteUrl(
            img.attr("data-src") || img.attr("src") || "",
            manifest.base_url,
          ),
        } satisfies Mangas;
      })
      .get()
      .filter((item): item is Mangas => item !== null);
  });
}
const source: Source = {
  id: manifest.source_key,
  name: manifest.name,
  lang: manifest.lang,
  base_url: manifest.base_url,
  isNSFW: deriveIsNSFW((manifest as SourceManifest).content_rating),
  fetchManga: (_category, pagination) => browse(null, pagination),
  searchManga: (query, pagination) => browse(query || "", pagination),
  async fetchMangaDetails(id) {
    const { $, cover } = gallery(await html(galleryPath(id)));
    return {
      id,
      slug: id,
      source: manifest.source_key,
      title: normalizeText($("h1").text()) || `Untitled gallery ${id}`,
      thumbnail_url: cover,
      description: "",
      status: "completed",
      author: $('a[href^="/artist/"]')
        .map((_, el) =>
          normalizeText($(el).clone().children().remove().end().text()),
        )
        .get(),
      genres: $('a[href^="/tag/"]')
        .map((_, el) =>
          normalizeText($(el).clone().children().remove().end().text()),
        )
        .get(),
      chapters: await source.fetchChapters(id),
    };
  },
  async fetchMangaThumbnail(id) {
    return gallery(await html(galleryPath(id))).cover;
  },
  async fetchChapters(id): Promise<Chapters[]> {
    const { urls, $ } = gallery(await html(galleryPath(id)));
    const language = normalizeText(
      $('a[href^="/language/"]')
        .first()
        .clone()
        .children()
        .remove()
        .end()
        .text(),
    ).toLowerCase();
    return [
      {
        id: `hentaifox:gallery:${id}`,
        url: `${manifest.base_url}/g/${id}/1/`,
        name: "Gallery",
        chapter_number: 1,
        scanlator: "Unknown",
        language:
          language === "english"
            ? "en"
            : language === "japanese"
              ? "ja"
              : language === "chinese"
                ? "zh"
                : "all",
        page_count: urls.length,
        last_page_read: 0,
        release_date: "",
        pages: [],
      },
    ];
  },
  async fetchChapterPages(id, _slug, pagination) {
    id = id.startsWith("hentaifox:gallery:")
      ? id.slice("hentaifox:gallery:".length)
      : id;
    const { urls } = gallery(await html(galleryPath(id)));
    const { limit, offset } = resolvePagination(pagination, {
      limit: urls.length,
    });
    return {
      total: urls.length,
      items: urls
        .slice(offset, offset + limit)
        .map((image_url, i) => ({ index: offset + i + 1, image_url })),
    };
  },
  async getFilters() {
    return [];
  },
  fetchMangaUpdates: (id) => source.fetchChapters(id),
};
export default source;
