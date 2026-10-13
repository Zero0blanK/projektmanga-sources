import { load } from "cheerio/slim";
import type {
  Source,
  Mangas,
  Chapters,
  FilterValue,
  MangaFilter,
} from "../lib/types.js";
import { HttpClient, NAV_HEADERS } from "../lib/http.js";
import { TTLCache } from "../lib/cache.js";
import { collectPaged } from "../lib/paginate.js";
import {
  normalizeText,
  resolvePagination,
  toAbsoluteUrl,
  parseDateToIso,
  mapMangaStatus,
} from "../lib/parse.js";
import { SourceError } from "../lib/sourceError.js";
import { deriveIsNSFW } from "../lib/manifest.js";
import type { SourceManifest } from "../lib/types.js";
import manifest from "./manifest.json";
import staticFilters from "./filters.json";

const http = new HttpClient({
  sourceId: manifest.source_key,
  sourceName: manifest.name,
  baseUrl: manifest.base_url,
  headers: NAV_HEADERS,
  rateLimitMs: 700,
});
const cache = new TTLCache<string, string>(120_000, 40);
const html = (path: string) => cache.getOrSet(path, () => http.getText(path));
function seriesPath(id: string): string {
  if (!/^[a-z0-9]+\/[a-z0-9-]+$/.test(id))
    throw new SourceError(
      "PARSE_ERROR",
      "Invalid title identifier",
      manifest.source_key,
    );
  return `/manga/${id}/`;
}
function chapters(text: string): Chapters[] {
  const $ = load(text);
  const seen = new Set<string>();
  return $(".lc-chapter-row")
    .map((_, el) => {
      const node = $(el),
        path = node.attr("href") || "";
      if (
        !/^\/leer\/[a-z0-9]+\/[a-z0-9-]+\/[\d.]+\/$/.test(path) ||
        seen.has(path)
      )
        return null;
      seen.add(path);
      const number = Number(path.split("/").filter(Boolean).at(-1));
      if (!Number.isFinite(number)) return null;
      return {
        id: `leercapitulo:${path}`,
        url: toAbsoluteUrl(path, manifest.base_url),
        name: normalizeText(node.find(".n").text()),
        chapter_number: number,
        scanlator: "Unknown",
        language: "es",
        page_count: 0,
        last_page_read: 0,
        release_date: parseDateToIso(node.find(".d").text()),
        pages: [],
      } as Chapters;
    })
    .get()
    .filter((item): item is Chapters => item !== null);
}
const filterKeys = ["genre", "theme", "type", "status", "sort"];
async function browse(
  query: string,
  pagination: Parameters<Source["fetchManga"]>[1],
  filters: Record<string, FilterValue> = {},
): Promise<Mangas[]> {
  const { limit, offset } = resolvePagination(pagination, { limit: 30 });
  return collectPaged({ limit, offset, sitePageSize: 30 }, async (page) => {
    const params = new URLSearchParams({ q: query, page: String(page) });
    for (const key of filterKeys) {
      const raw = filters[key];
      if (typeof raw !== "string" || !raw) continue;
      const value = raw.startsWith("/manga/?")
        ? new URL(raw, manifest.base_url).searchParams.get(key)
        : raw;
      if (
        value &&
        staticFilters
          .find((filter) => filter.value === key)
          ?.options.some((option) => option.value === value)
      )
        params.set(key, value);
    }
    const $ = load(await html(`/manga/?${params}`));
    return $(".lc-card")
      .map((_, el) => {
        const card = $(el),
          link = card.find(".lc-card-name").first();
        const id = (link.attr("href") || "").match(
          /^\/manga\/([a-z0-9]+\/[a-z0-9-]+)\/$/,
        )?.[1];
        if (!id) return null;
        return {
          id,
          slug: id,
          source: manifest.source_key,
          title: normalizeText(link.text()),
          thumbnail_url: toAbsoluteUrl(
            card.find("img").attr("src") || "",
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
  fetchManga: (_category, pagination, filters) =>
    browse("", pagination, filters),
  searchManga: (query, pagination, filters) =>
    browse(query || "", pagination, filters),
  async fetchMangaDetails(id) {
    const text = await html(seriesPath(id)),
      $ = load(text);
    const title = normalizeText($("h1").first().text());
    if (!title)
      throw new SourceError(
        "PARSE_ERROR",
        "Title details were not found",
        manifest.source_key,
      );
    return {
      id,
      slug: id,
      source: manifest.source_key,
      title,
      thumbnail_url: toAbsoluteUrl(
        $('img[src*="/covers/"]').first().attr("src") || "",
        manifest.base_url,
      ),
      description: normalizeText($(".p-3.p-md-4 p.mb-0").first().text()),
      author: $(".lc-facts li")
        .filter((_, el) => normalizeText($(el).find(".k").text()) === "Autor")
        .map((_, el) => normalizeText($(el).children("span").last().text()))
        .get(),
      genres: $('a[href^="/manga/?genre="]')
        .map((_, el) => normalizeText($(el).text()))
        .get(),
      status: mapMangaStatus($('a[href^="/manga/?status="]').first().text()),
      chapters: chapters(text),
    };
  },
  async fetchMangaThumbnail(id) {
    return (await source.fetchMangaDetails(id)).thumbnail_url;
  },
  async fetchChapters(id) {
    return chapters(await html(seriesPath(id)));
  },
  async fetchChapterPages(id, _slug, pagination) {
    id = id.startsWith("leercapitulo:") ? id.slice("leercapitulo:".length) : id;
    if (!/^\/leer\/[a-z0-9]+\/[a-z0-9-]+\/[\d.]+\/$/.test(id))
      throw new SourceError(
        "PARSE_ERROR",
        "Invalid chapter identifier",
        manifest.source_key,
      );
    const $ = load(await html(id));
    const urls = $("img[data-index]")
      .map((_, el) =>
        toAbsoluteUrl(
          $(el).attr("data-src") || $(el).attr("src") || "",
          manifest.base_url,
        ),
      )
      .get()
      .filter(Boolean);
    if (!urls.length)
      throw new SourceError(
        "PARSE_ERROR",
        "No readable chapter pages were found",
        manifest.source_key,
      );
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
  async getFilters(): Promise<MangaFilter[]> {
    return structuredClone(staticFilters) as MangaFilter[];
  },
  fetchMangaUpdates: (id) => source.fetchChapters(id),
};
export default source;
