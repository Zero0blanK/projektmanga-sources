// Guya: the small-group reader behind guya.cubari.moe, danke.moe and hachirumi.com. One JSON
// call lists every series; another gives a series' chapters, groups and page files.
// Endpoints follow Keiyoushi's lib-multisrc/guya (Apache-2.0); see THIRD_PARTY_NOTICES.md.
import { load } from "cheerio/slim";
import { HttpClient, JSON_HEADERS } from "./http.js";
import { TTLCache } from "./cache.js";
import { deriveIsNSFW } from "./manifest.js";
import { MANGA_STATUS, normalizeText, resolvePagination } from "./parse.js";
import { SourceError } from "./sourceError.js";
import type { Chapters, Mangas, Source, SourceManifest } from "./types.js";

interface Series {
  slug: string;
  title?: string | null;
  author?: string | null;
  artist?: string | null;
  description?: string | null;
  cover?: string | null;
  last_updated?: number | null;
}
interface SeriesDetails extends Series {
  title: string;
  groups: Record<string, string>;
  chapters: Record<
    string,
    {
      title: string;
      folder: string;
      groups: Record<string, string[]>;
      release_date?: Record<string, number> | null;
      preferred_sort?: string[] | null;
    }
  >;
  preferred_sort?: string[] | null;
}

const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const NUMBER = /^\d{1,5}(?:\.\d{1,3})?$/;
const GROUP = /^[A-Za-z0-9_-]{1,40}$/;
// Page files may carry a cache-buster ("2.png?v3").
const FILE = /^[A-Za-z0-9._-]{1,200}(?:\?[A-Za-z0-9=&._-]{1,50})?$/;

export function createGuyaSite(manifest: SourceManifest): Source {
  const base = manifest.base_url;
  const http = new HttpClient({
    sourceId: manifest.source_key,
    sourceName: manifest.name,
    baseUrl: base,
    headers: { ...JSON_HEADERS, Referer: `${base}/` },
    rateLimitMs: 300,
  });
  const all = new TTLCache<string, Map<string, Series & { title: string }>>(60_000, 1);
  const details = new TTLCache<string, SeriesDetails>(30_000, 40);
  const fail = (message: string): never => {
    throw new SourceError("PARSE_ERROR", `${manifest.name}: ${message}`, manifest.source_key);
  };
  const cover = (value?: string | null) =>
    !value ? "" : /^https?:\/\//.test(value) ? value : `${base}/${value.replace(/^\/+/, "")}`;
  const clean = (value?: string | null) => {
    if (!value) return "";
    if (!value.includes("<")) return normalizeText(value);
    const $ = load(value);
    $("a").remove();
    return normalizeText($.text());
  };

  async function catalogue() {
    return all.getOrSet("all", async () => {
      const data = await http.getJson<Record<string, Series>>("/api/get_all_series/");
      const rows = new Map<string, Series & { title: string }>();
      for (const [title, series] of Object.entries(data ?? {}))
        if (series && SLUG.test(series.slug)) rows.set(series.slug, { ...series, title });
      return rows;
    });
  }
  const card = (series: Series & { title: string }): Mangas => ({
    id: series.slug,
    slug: series.slug,
    title: series.title,
    source: manifest.source_key,
    thumbnail_url: cover(series.cover),
  });
  async function seriesOf(slug: string) {
    if (!SLUG.test(slug)) return fail("Invalid title identifier");
    return details.getOrSet(slug, () => http.getJson<SeriesDetails>(`/api/series/${slug}/`));
  }
  /** The group a chapter is read from: the series' preferred order, else the first. */
  const groupFor = (groups: string[], sort?: string[] | null) =>
    (sort ?? []).find((group) => groups.includes(group)) ?? groups[0];

  async function chaptersOf(slug: string): Promise<Chapters[]> {
    const series = await seriesOf(slug);
    return Object.entries(series.chapters ?? {})
      .flatMap(([number, chapter]) => {
        const groups = Object.keys(chapter.groups ?? {}).filter((group) => GROUP.test(group));
        if (!NUMBER.test(number) || !groups.length) return [];
        const group = groupFor(groups, chapter.preferred_sort ?? series.preferred_sort);
        const released = chapter.release_date?.[group];
        const row: Chapters = {
          id: `${slug}/${number}/${group}`,
          name: `${number} - ${normalizeText(chapter.title ?? "")}`.replace(/ - $/, ""),
          url: `${base}/read/manga/${slug}/${number.replace(".", "-")}/1/`,
          chapter_number: Number(number),
          scanlator: series.groups?.[group] ?? group,
          release_date: released ? new Date(released * 1000).toISOString() : "",
          last_page_read: 0,
          pages: [],
        };
        return [row];
      })
      .sort((a, b) => b.chapter_number - a.chapter_number);
  }

  const page = (rows: Mangas[], pagination?: { limit: number; offset: number }) => {
    const { limit, offset } = resolvePagination(pagination, { limit: 50 });
    return rows.slice(offset, offset + limit);
  };

  const source: Source = {
    id: manifest.source_key,
    name: manifest.name,
    lang: manifest.lang,
    base_url: base,
    isNSFW: deriveIsNSFW(manifest.content_rating),
    async fetchManga(category, pagination) {
      const rows = [...(await catalogue()).values()];
      if (category === "latest") rows.sort((a, b) => (b.last_updated ?? 0) - (a.last_updated ?? 0));
      return page(rows.map(card), pagination);
    },
    async searchManga(query = "", pagination) {
      const needle = query.trim().toLowerCase();
      const rows = [...(await catalogue()).values()].filter((series) => series.title.toLowerCase().includes(needle));
      return page(rows.map(card), pagination);
    },
    async fetchMangaDetails(slug) {
      const series = await seriesOf(slug);
      const listed = (await catalogue().catch(() => new Map<string, Series & { title: string }>())).get(slug);
      return {
        id: slug,
        slug,
        title: listed?.title || series.title,
        source: manifest.source_key,
        thumbnail_url: cover(series.cover),
        url: `${base}/reader/series/${slug}/`,
        author: series.author ? [series.author] : [],
        artist: series.artist ? [series.artist] : [],
        genres: [],
        status: MANGA_STATUS.UNKNOWN,
        description: clean(series.description),
        chapters: await chaptersOf(slug),
      };
    },
    async fetchMangaThumbnail(slug) {
      try {
        return cover((await seriesOf(slug)).cover);
      } catch {
        return "";
      }
    },
    fetchChapters: chaptersOf,
    async fetchChapterPages(chapterId, _slug, pagination) {
      const [slug, number, group] = chapterId.split("/");
      if (!SLUG.test(slug ?? "") || !NUMBER.test(number ?? "") || !GROUP.test(group ?? ""))
        return fail("Invalid chapter identifier");
      const series = await seriesOf(slug);
      const chapter = series.chapters?.[number];
      const files = (chapter?.groups?.[group] ?? []).filter((file) => FILE.test(file));
      if (!chapter || !/^[A-Za-z0-9._-]{1,100}$/.test(chapter.folder) || !files.length)
        throw new SourceError("NOT_FOUND", `${manifest.name} no longer has this chapter`, manifest.source_key);
      const images = files.map((file) => `${base}/media/manga/${series.slug}/chapters/${chapter.folder}/${group}/${file}`);
      const { limit, offset } = resolvePagination(pagination, { limit: images.length });
      const start = Math.min(offset, images.length);
      return {
        items: images.slice(start, start + Math.max(1, limit)).map((image_url, index) => ({ index: start + index + 1, image_url })),
        total: images.length,
      };
    },
    async getFilters() {
      return [];
    },
    async fetchMangaUpdates(slug) {
      details.clear();
      return chaptersOf(slug);
    },
  };
  return source;
}
