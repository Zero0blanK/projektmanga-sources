// HeanCMS: a scanlation-site platform with a JSON API on the site's `api.` subdomain
// (omegascans.org, luacomic.org). Endpoints and fields follow Keiyoushi's
// lib-multisrc/heancms (Apache-2.0); see THIRD_PARTY_NOTICES.md. Paid and not-yet-released
// chapters are left out: they can't be read without an account.
import { load } from "cheerio/slim";
import { HttpClient, JSON_HEADERS } from "./http.js";
import { TTLCache } from "./cache.js";
import { deriveIsNSFW } from "./manifest.js";
import { createNativePager } from "./nativeCatalogue.js";
import { MANGA_STATUS, normalizeText, resolvePagination } from "./parse.js";
import { SourceError } from "./sourceError.js";
import type {
  Chapters,
  FilterValue,
  MangaFilter,
  Mangas,
  Source,
  SourceManifest,
} from "./types.js";

export interface HeanCmsOptions {
  /** Sort direction for "latest": most sites list newest last (`"desc"` is newest first). */
  latestSortBy?: "asc" | "desc";
}

interface Series {
  id: number;
  series_slug: string;
  title: string;
  author?: string | null;
  studio?: string | null;
  description?: string | null;
  status?: string | null;
  thumbnail?: string | null;
  tags?: Array<{ name: string }> | null;
  alternative_names?: string | null;
}
interface ApiChapter {
  id: number;
  chapter_name: string;
  chapter_title?: string | null;
  chapter_slug: string;
  created_at?: string | null;
  price?: number | null;
}
interface Meta {
  current_page?: number;
  last_page?: number;
}

const PER_PAGE = 12;
const SLUG = /^[a-z0-9][a-z0-9_-]{0,199}$/i;
const STATUS: Record<string, string> = {
  Ongoing: MANGA_STATUS.ONGOING,
  Hiatus: MANGA_STATUS.HIATUS,
  Dropped: MANGA_STATUS.CANCELLED,
  Completed: MANGA_STATUS.COMPLETED,
  Finished: MANGA_STATUS.COMPLETED,
};
const STATIC_FILTERS: MangaFilter[] = [
  {
    label: "Status",
    value: "status",
    type: "select",
    options: [
      { label: "All", value: "" },
      { label: "Ongoing", value: "Ongoing" },
      { label: "On hiatus", value: "Hiatus" },
      { label: "Dropped", value: "Dropped" },
      { label: "Completed", value: "Completed" },
    ],
  },
  {
    label: "Sort",
    value: "orderBy",
    type: "select",
    options: [
      { label: "Views", value: "total_views" },
      { label: "Latest", value: "latest" },
      { label: "Created at", value: "created_at" },
      { label: "Title", value: "title" },
    ],
  },
];
const ORDER_BY = new Set(["total_views", "latest", "created_at", "title"]);
const STATUSES = new Set(["Ongoing", "Hiatus", "Dropped", "Completed"]);

const hasNext = (meta?: Meta | null) =>
  !!meta && Number(meta.current_page) < Number(meta.last_page);

export function createHeanCmsSite(manifest: SourceManifest, { latestSortBy = "desc" }: HeanCmsOptions = {}): Source {
  const base = manifest.base_url;
  const api = base.replace("https://", "https://api.");
  const http = new HttpClient({
    sourceId: manifest.source_key,
    sourceName: manifest.name,
    baseUrl: api,
    headers: { ...JSON_HEADERS, Referer: `${base}/`, Origin: base },
    rateLimitMs: 1000,
  });
  const seriesCache = new TTLCache<string, Series>(30_000, 40);
  let tagFilter: Promise<MangaFilter | null> | undefined;
  const fail = (message: string): never => {
    throw new SourceError("PARSE_ERROR", `${manifest.name}: ${message}`, manifest.source_key);
  };
  const absolute = (value?: string | null) =>
    !value ? "" : /^https?:\/\//.test(value) ? value : `${api}/${value.replace(/^\/+/, "")}`;
  const card = (series: Series): Mangas | null =>
    SLUG.test(series.series_slug) && series.title
      ? { id: series.series_slug, slug: series.series_slug, title: series.title, source: manifest.source_key, thumbnail_url: absolute(series.thumbnail) }
      : null;

  async function query(text: string, active: Record<string, FilterValue>, orderBy: string, order: string, page: number) {
    const url = new URL("/query", api);
    const status = typeof active.status === "string" && STATUSES.has(active.status) ? active.status : "All";
    const tags = (Array.isArray(active.tags) ? active.tags : []).filter((id) => /^\d{1,9}$/.test(id));
    url.searchParams.set("query_string", text);
    url.searchParams.set("status", status);
    url.searchParams.set("order", order);
    url.searchParams.set("orderBy", orderBy);
    url.searchParams.set("series_type", "Comic");
    url.searchParams.set("page", String(page));
    url.searchParams.set("perPage", String(PER_PAGE));
    url.searchParams.set("tags_ids", `[${tags.join(",")}]`);
    url.searchParams.set("adult", "true");
    const data = await http.getJson<{ data?: Series[]; meta?: Meta }>(url.href);
    return {
      items: (data.data ?? []).map(card).filter((row): row is Mangas => row !== null),
      more: hasNext(data.meta),
    };
  }

  const browseOrder = (category: string | undefined, active: Record<string, FilterValue>) => {
    if (typeof active.orderBy === "string" && ORDER_BY.has(active.orderBy)) return { orderBy: active.orderBy, order: "desc" };
    return category === "latest" ? { orderBy: "latest", order: latestSortBy } : { orderBy: "total_views", order: "desc" };
  };
  const pager = (text: string, orderBy: string, order: string, active: Record<string, FilterValue>) =>
    createNativePager(
      manifest.source_key,
      "1",
      (position) => /^\d{1,4}$/.test(position) && Number(position) >= 1,
      async (position) => {
        const page = Number(position);
        const { items, more } = await query(text, active, orderBy, order, page);
        return { items, ...(more ? { next: String(page + 1) } : {}) };
      },
      { query: text, category: `${orderBy}:${order}`, filters: active },
    );

  async function seriesOf(slug: string) {
    if (!SLUG.test(slug)) return fail("Invalid title identifier");
    return seriesCache.getOrSet(slug, async () => {
      const series = await http.getJson<Series>(`/series/${encodeURIComponent(slug)}`);
      if (!series?.title || !Number.isSafeInteger(series.id))
        throw new SourceError("NOT_FOUND", `${manifest.name} has no such title`, manifest.source_key);
      return series;
    });
  }

  async function chaptersOf(slug: string): Promise<Chapters[]> {
    const series = await seriesOf(slug);
    const rows: ApiChapter[] = [];
    for (let page = 1; page <= 100; page++) {
      const data = await http.getJson<{ data?: ApiChapter[]; meta?: Meta }>(
        `/chapter/query?page=${page}&perPage=30&series_id=${series.id}`,
      );
      rows.push(...(data.data ?? []));
      if (!hasNext(data.meta)) break;
    }
    const now = Date.now();
    return rows
      .filter((chapter) => !chapter.price && SLUG.test(chapter.chapter_slug))
      .flatMap((chapter) => {
        const date = chapter.created_at ? new Date(chapter.created_at) : null;
        if (date && date.getTime() > now) return [];
        const name = [normalizeText(chapter.chapter_name), normalizeText(chapter.chapter_title ?? "")]
          .filter(Boolean)
          .join(" - ");
        const number = Number(/(\d+(?:\.\d+)?)/.exec(chapter.chapter_name)?.[1] ?? -1);
        const row: Chapters = {
          id: `${slug}/${chapter.chapter_slug}`,
          name,
          url: `${base}/series/${slug}/${chapter.chapter_slug}`,
          chapter_number: number,
          release_date: date && !Number.isNaN(date.getTime()) ? date.toISOString() : "",
          last_page_read: 0,
          pages: [],
        };
        return [row];
      })
      .sort((a, b) => b.chapter_number - a.chapter_number);
  }

  const source: Source = {
    id: manifest.source_key,
    name: manifest.name,
    lang: manifest.lang,
    base_url: base,
    isNSFW: deriveIsNSFW(manifest.content_rating),
    fetchMangaPage: (category = "popular", request, active = {}) => {
      const { orderBy, order } = browseOrder(category, active);
      return pager("", orderBy, order, active)(request);
    },
    searchMangaPage: (text = "", request, active = {}) => {
      const { orderBy, order } = browseOrder("popular", active);
      return pager(text.trim(), orderBy, order, active)(request);
    },
    async getCapabilities() {
      return { latest: true, search: true, filters: true, languageFilter: false, urlSearch: false, nativePagination: true };
    },
    async fetchManga(category, pagination, active = {}) {
      const { limit, offset } = resolvePagination(pagination, { limit: PER_PAGE });
      const { orderBy, order } = browseOrder(category, active);
      const rows: Mangas[] = [];
      for (let page = Math.floor(offset / PER_PAGE) + 1; rows.length < (offset % PER_PAGE) + limit; page++) {
        const result = await query("", active, orderBy, order, page);
        rows.push(...result.items);
        if (!result.more) break;
      }
      return rows.slice(offset % PER_PAGE, (offset % PER_PAGE) + limit);
    },
    async searchManga(text = "", pagination, active = {}) {
      const { limit, offset } = resolvePagination(pagination, { limit: PER_PAGE });
      const { orderBy, order } = browseOrder("popular", active);
      const result = await query(text.trim(), active, orderBy, order, Math.floor(offset / PER_PAGE) + 1);
      return result.items.slice(offset % PER_PAGE, (offset % PER_PAGE) + limit);
    },
    async fetchMangaDetails(slug) {
      const series = await seriesOf(slug);
      const body = load(series.description ?? "");
      const paragraphs = body("p").toArray().map((element) => normalizeText(body(element).text())).filter(Boolean);
      const description = (paragraphs.length ? paragraphs.join("\n\n") : normalizeText(body.text())).replace(/^-$/, "");
      const alternative = (series.alternative_names ?? "")
        .split("|")
        .map((name) => name.trim())
        .filter((name) => name && name !== series.title);
      const credit = (value?: string | null) => (value?.trim() && value.trim() !== "-" ? [value.trim()] : []);
      return {
        id: slug,
        slug,
        title: series.title,
        source: manifest.source_key,
        thumbnail_url: absolute(series.thumbnail),
        url: `${base}/series/${slug}`,
        author: credit(series.author),
        artist: credit(series.studio),
        genres: (series.tags ?? []).map((tag) => tag.name).filter(Boolean).sort(),
        status: STATUS[series.status ?? ""] ?? MANGA_STATUS.UNKNOWN,
        description: [description, alternative.length ? `Alternative names: ${alternative.join(", ")}` : ""]
          .filter(Boolean)
          .join("\n\n"),
        chapters: await chaptersOf(slug),
      };
    },
    async fetchMangaThumbnail(slug) {
      try {
        return absolute((await seriesOf(slug)).thumbnail);
      } catch {
        return "";
      }
    },
    fetchChapters: chaptersOf,
    async fetchChapterPages(chapterId, _slug, pagination) {
      const match = /^([a-z0-9][a-z0-9_-]{0,199})\/([a-z0-9][a-z0-9_-]{0,199})$/i.exec(chapterId);
      if (!match) return fail("Invalid chapter identifier");
      const data = await http.getJson<{ chapter?: { chapter_data?: { images?: string[] } | null }; paywall?: boolean }>(
        `/chapter/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}`,
      );
      const images = (data.chapter?.chapter_data?.images ?? []).map(absolute).filter(Boolean);
      if (!images.length)
        throw new SourceError(
          "NOT_FOUND",
          data.paywall
            ? `${manifest.name} sells this chapter; it can only be read on the site.`
            : `${manifest.name} has no pages for this chapter.`,
          manifest.source_key,
        );
      const { limit, offset } = resolvePagination(pagination, { limit: images.length });
      const start = Math.min(offset, images.length);
      return {
        items: images.slice(start, start + Math.max(1, limit)).map((image_url, index) => ({ index: start + index + 1, image_url })),
        total: images.length,
      };
    },
    async getFilters() {
      tagFilter ??= http
        .getJson<Array<{ id: number; name: string }>>("/tags")
        .then((tags): MangaFilter | null => {
          const options = (Array.isArray(tags) ? tags : [])
            .filter((tag) => Number.isSafeInteger(tag.id) && tag.name)
            .map((tag) => ({ label: tag.name, value: String(tag.id) }))
            .sort((a, b) => a.label.localeCompare(b.label));
          return options.length ? { label: "Genres", value: "tags", type: "multi", options } : null;
        })
        .catch(() => {
          tagFilter = undefined;
          return null;
        });
      const tags = await tagFilter;
      return tags ? [...STATIC_FILTERS, tags] : STATIC_FILTERS;
    },
    async fetchMangaUpdates(slug) {
      seriesCache.clear();
      return chaptersOf(slug);
    },
  };
  return source;
}
