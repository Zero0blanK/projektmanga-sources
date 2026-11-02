// VineTheme: a Next.js scanlation-site platform (drakecomic.net, elftoon.net, witchtoons.net…).
// Catalogues come from its `/api/series` JSON; title, chapter and reader data from the
// React Server Component payload the site's pages fetch (`rsc: 1`). Endpoints, fields and
// filters follow Keiyoushi's lib-multisrc/vinetheme (Apache-2.0); see THIRD_PARTY_NOTICES.md.
// Locked (coin) chapters are left out: they can't be read without an account.
import { load } from "cheerio/slim";
import { HttpClient, JSON_HEADERS, NAV_HEADERS } from "./http.js";
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

interface Series {
  id: string;
  title: string;
  slug?: string;
  urlSlug?: string | null;
  coverImage?: string | null;
  status?: string;
  type?: string;
  origin?: string;
  isMature?: boolean;
  nsfw?: boolean;
  originalTitle?: string | null;
  aliases?: unknown;
  description?: unknown;
  genres?: Array<{ name?: string; slug?: string; genre?: { slug?: string } }>;
  tags?: Array<{ name?: string; slug?: string; genre?: { slug?: string } }>;
  team?: { name?: string | null } | null;
}
interface ApiChapter {
  id: string;
  number: number;
  title?: string | null;
  publishedAt?: string | null;
  isLocked?: boolean;
  coinPrice?: number;
  hasAccess?: boolean;
}

const PAGE_SIZE = 24;
const SLUG = /^[a-z0-9][a-z0-9-]{0,199}$/;
const STATUS: Record<string, string> = {
  ONGOING: MANGA_STATUS.ONGOING,
  UPCOMING: MANGA_STATUS.ONGOING,
  COMPLETED: MANGA_STATUS.COMPLETED,
  HIATUS: MANGA_STATUS.HIATUS,
  DROPPED: MANGA_STATUS.CANCELLED,
  CANCELLED: MANGA_STATUS.CANCELLED,
  DISCONTINUED: MANGA_STATUS.CANCELLED,
};

const options = (entries: Array<[string, string]>) =>
  entries.map(([label, value]) => ({ label, value }));
const STATIC_FILTERS: MangaFilter[] = [
  {
    label: "Sort",
    value: "sort",
    type: "select",
    options: options([
      ["Recently updated", "updated"],
      ["Most bookmarked", "popular"],
      ["Most viewed", "views"],
      ["Longest", "longest"],
      ["Trending", "trending"],
      ["Top rated", "rating"],
      ["Newest", "newest"],
    ]),
  },
  {
    label: "Type",
    value: "type",
    type: "multi",
    options: options([
      ["Manhwa", "Manhwa"],
      ["Manhua", "Manhua"],
      ["Manga", "Manga"],
      ["Webtoon", "Webtoon"],
    ]),
  },
  {
    label: "Status",
    value: "status",
    type: "multi",
    options: options([
      ["Ongoing", "Ongoing"],
      ["Completed", "Completed"],
      ["Hiatus", "Hiatus"],
      ["Dropped", "Dropped"],
      ["Discontinued", "Discontinued"],
      ["Upcoming", "Upcoming"],
    ]),
  },
  {
    label: "Origin",
    value: "origin",
    type: "multi",
    options: options([
      ["Korean", "KOREAN"],
      ["Japanese", "JAPANESE"],
      ["Chinese", "CHINESE"],
      ["Other", "OTHER"],
    ]),
  },
];
const SORTS = new Set(STATIC_FILTERS[0].options!.map((option) => option.value));
const LIST_VALUE = /^[A-Za-z0-9-]{1,60}$/;

/**
 * The first object in a React Server Component payload that `match` accepts. The payload
 * is one `<id>:<value>` row per line; rows holding JSON are searched depth-first. Nothing
 * in it is executed.
 */
export function findInRscPayload<T>(
  text: string,
  match: (value: Record<string, unknown>) => boolean,
): T | null {
  for (const line of text.split("\n")) {
    const row = /^[0-9a-f]{1,8}:([[{].*)$/s.exec(line);
    if (!row) continue;
    let value: unknown;
    try {
      value = JSON.parse(row[1]);
    } catch {
      continue;
    }
    const stack = [value];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== "object") continue;
      if (!Array.isArray(node) && match(node as Record<string, unknown>)) return node as T;
      for (const child of Object.values(node)) stack.push(child);
    }
  }
  return null;
}

export function createVineThemeSite(manifest: SourceManifest): Source {
  const base = manifest.base_url;
  const api = new HttpClient({
    sourceId: manifest.source_key,
    sourceName: manifest.name,
    baseUrl: base,
    headers: { ...JSON_HEADERS, Referer: `${base}/` },
    rateLimitMs: 300,
  });
  const pages = new HttpClient({
    sourceId: manifest.source_key,
    sourceName: manifest.name,
    baseUrl: base,
    headers: { ...NAV_HEADERS, Accept: "*/*", rsc: "1", Referer: `${base}/` },
    rateLimitMs: 300,
  });
  const details = new TTLCache<string, { series: Series; chapters: ApiChapter[] }>(30_000, 40);
  let genreFilters: Promise<MangaFilter[]> | undefined;
  const fail = (message: string): never => {
    throw new SourceError("PARSE_ERROR", `${manifest.name}: ${message}`, manifest.source_key);
  };
  const absolute = (value?: string | null) => {
    if (!value) return "";
    try {
      return new URL(value, base).href;
    } catch {
      return "";
    }
  };
  const slugOf = (series: Series) => series.urlSlug || series.slug || "";
  const card = (series: Series): Mangas | null => {
    const slug = slugOf(series);
    return slug && SLUG.test(slug) && series.title
      ? { id: slug, slug, title: series.title, source: manifest.source_key, thumbnail_url: absolute(series.coverImage) }
      : null;
  };

  async function list(query: string, sort: string, active: Record<string, FilterValue>, page: number) {
    const url = new URL("/api/series", base);
    url.searchParams.set("limit", String(PAGE_SIZE));
    url.searchParams.set("contentMode", "comics");
    if (query) url.searchParams.set("q", query);
    url.searchParams.set("sort", sort);
    for (const key of ["type", "status", "origin"]) {
      const values = (Array.isArray(active[key]) ? (active[key] as string[]) : []).filter((value) => LIST_VALUE.test(value));
      if (values.length) url.searchParams.set(key, values.join(","));
    }
    for (const key of ["genre", "tag"]) {
      const value = active[key];
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const include = (value.include ?? []).filter((slug) => LIST_VALUE.test(slug));
      const exclude = (value.exclude ?? []).filter((slug) => LIST_VALUE.test(slug));
      if (include.length) url.searchParams.set(key, include.join(","));
      if (exclude.length) url.searchParams.set(`ex${key}`, exclude.join(","));
    }
    url.searchParams.set("page", String(page));
    const data = await api.getJson<{ data?: Series[]; meta?: { hasMore?: boolean } }>(url.href);
    return {
      items: (data.data ?? []).map(card).filter((row): row is Mangas => row !== null),
      hasMore: data.meta?.hasMore === true,
    };
  }

  const sortOf = (active: Record<string, FilterValue>, fallback: string) =>
    typeof active.sort === "string" && SORTS.has(active.sort) ? active.sort : fallback;
  const pager = (query: string, sort: string, active: Record<string, FilterValue>) =>
    createNativePager(
      manifest.source_key,
      "1",
      (position) => /^\d{1,4}$/.test(position) && Number(position) >= 1,
      async (position) => {
        const page = Number(position);
        const { items, hasMore } = await list(query, sort, active, page);
        return { items, ...(hasMore ? { next: String(page + 1) } : {}) };
      },
      { query, category: sort, filters: active },
    );

  async function detailOf(slug: string) {
    if (!SLUG.test(slug)) return fail("Invalid title identifier");
    return details.getOrSet(slug, async () => {
      const path = `/series/comic/${slug}?sort=desc`;
      type Detail = { series: Series; chapters: ApiChapter[]; totalPages?: number };
      const isDetail = (value: Record<string, unknown>) => "series" in value && "chapters" in value;
      const first = findInRscPayload<Detail>(await pages.getText(path), isDetail);
      if (!first?.series?.title) throw new SourceError("NOT_FOUND", `${manifest.name} has no such title`, manifest.source_key);
      const chapters = [...(first.chapters ?? [])];
      const total = Math.min(Number(first.totalPages) || 1, 50);
      for (let page = 2; page <= total; page++) {
        const next = findInRscPayload<Detail>(await pages.getText(`${path}&page=${page}`), isDetail);
        if (!next?.chapters?.length) break;
        chapters.push(...next.chapters);
      }
      return { series: first.series, chapters };
    });
  }

  async function chaptersOf(slug: string): Promise<Chapters[]> {
    const { chapters } = await detailOf(slug);
    return [
      ...new Map(
        chapters
          .filter((chapter) => !chapter.isLocked && Number.isFinite(chapter.number))
          .map((chapter) => {
            const number = String(chapter.number).replace(/\.0$/, "");
            const title = normalizeText(chapter.title ?? "");
            const date = chapter.publishedAt ? new Date(chapter.publishedAt) : null;
            const row: Chapters = {
                id: `${slug}/${number}`,
                name: !title || title === number ? `Chapter ${number}` : title,
                url: `${base}/series/comic/${slug}/chapter/${number}`,
                chapter_number: chapter.number,
                release_date: date && !Number.isNaN(date.getTime()) ? date.toISOString() : "",
                last_page_read: 0,
                pages: [],
              };
            return [number, row] as const;
          }),
      ).values(),
    ].sort((a, b) => b.chapter_number - a.chapter_number);
  }

  const textOf = (value: unknown) =>
    typeof value === "string" && !value.startsWith("$") ? normalizeText(load(value.replace(/<\/p>/g, "</p>\n\n")).text()) : "";
  const names = (rows?: Series["genres"]) =>
    (rows ?? []).map((row) => row.name || row.genre?.slug || row.slug || "").filter(Boolean);

  const source: Source = {
    id: manifest.source_key,
    name: manifest.name,
    lang: manifest.lang,
    base_url: base,
    isNSFW: deriveIsNSFW(manifest.content_rating),
    fetchMangaPage: (category = "popular", request, active = {}) =>
      pager("", sortOf(active, category === "latest" ? "updated" : "popular"), active)(request),
    searchMangaPage: (query = "", request, active = {}) =>
      pager(query.trim(), sortOf(active, "popular"), active)(request),
    async getCapabilities() {
      return { latest: true, search: true, filters: true, languageFilter: false, urlSearch: false, nativePagination: true };
    },
    async fetchManga(category, pagination, active = {}) {
      const { limit, offset } = resolvePagination(pagination, { limit: PAGE_SIZE });
      const sort = sortOf(active, category === "latest" ? "updated" : "popular");
      const rows: Mangas[] = [];
      for (let page = Math.floor(offset / PAGE_SIZE) + 1; rows.length < (offset % PAGE_SIZE) + limit; page++) {
        const result = await list("", sort, active, page);
        rows.push(...result.items);
        if (!result.hasMore) break;
      }
      return rows.slice(offset % PAGE_SIZE, (offset % PAGE_SIZE) + limit);
    },
    async searchManga(query = "", pagination, active = {}) {
      const { limit, offset } = resolvePagination(pagination, { limit: PAGE_SIZE });
      const result = await list(query.trim(), sortOf(active, "popular"), active, Math.floor(offset / PAGE_SIZE) + 1);
      return result.items.slice(offset % PAGE_SIZE, (offset % PAGE_SIZE) + limit);
    },
    async fetchMangaDetails(slug) {
      const { series } = await detailOf(slug);
      const aliases = [series.originalTitle, ...(Array.isArray(series.aliases) ? series.aliases : [])]
        .filter((name): name is string => typeof name === "string" && !!name.trim() && name.trim().toLowerCase() !== series.title.toLowerCase());
      return {
        id: slug,
        slug,
        title: series.title,
        source: manifest.source_key,
        thumbnail_url: absolute(series.coverImage),
        url: `${base}/series/comic/${slug}`,
        author: series.team?.name ? [series.team.name] : [],
        genres: [
          ...new Set([
            ...(series.type ? [series.type[0] + series.type.slice(1).toLowerCase()] : []),
            ...(series.isMature ? ["Mature"] : []),
            ...names(series.genres),
            ...names(series.tags),
          ]),
        ],
        status: STATUS[series.status ?? ""] ?? MANGA_STATUS.UNKNOWN,
        description: [textOf(series.description), aliases.length ? `Alternative titles: ${aliases.join(", ")}` : ""]
          .filter(Boolean)
          .join("\n\n"),
        chapters: await chaptersOf(slug),
      };
    },
    async fetchMangaThumbnail(slug) {
      try {
        return absolute((await detailOf(slug)).series.coverImage);
      } catch {
        return "";
      }
    },
    fetchChapters: chaptersOf,
    async fetchChapterPages(chapterId, _slug, pagination) {
      const match = /^([a-z0-9][a-z0-9-]{0,199})\/(\d{1,5}(?:\.\d{1,3})?)$/.exec(chapterId);
      if (!match) return fail("Invalid chapter identifier");
      const [, slug, number] = match;
      const chapter = findInRscPayload<{ pages: Array<{ imageUrl?: string | null }> }>(
        await pages.getText(`/series/comic/${slug}/chapter/${number}`),
        (value) => Array.isArray(value.pages) && !("series" in value),
      );
      const images = (chapter?.pages ?? []).map((page) => absolute(page.imageUrl)).filter(Boolean);
      if (!images.length)
        throw new SourceError("NOT_FOUND", `${manifest.name} has no readable pages for this chapter (it may be locked).`, manifest.source_key);
      const { limit, offset } = resolvePagination(pagination, { limit: images.length });
      const start = Math.min(offset, images.length);
      return {
        items: images.slice(start, start + Math.max(1, limit)).map((image_url, index) => ({ index: start + index + 1, image_url })),
        total: images.length,
      };
    },
    async getFilters() {
      // Genres and tags are the site's own, listed on its /series page.
      genreFilters ??= pages
        .getText("/series")
        .then((text) => {
          type Entry = { name?: string; slug?: string; genre?: { slug?: string }; count?: number };
          const data = findInRscPayload<{ genres?: Entry[]; tags?: Entry[] }>(text, (value) => "tagTotal" in value);
          const group = (label: string, value: string, entries?: Entry[]): MangaFilter[] => {
            const list = (entries ?? [])
              .filter((entry) => entry.count !== 0)
              .map((entry) => ({ label: (entry.name || entry.genre?.slug || "").trim(), value: entry.slug || entry.genre?.slug || "" }))
              .filter((entry) => entry.label && LIST_VALUE.test(entry.value));
            return list.length ? [{ label, value, type: "tri-state", options: list }] : [];
          };
          return [...group("Genres", "genre", data?.genres), ...group("Tags", "tag", data?.tags)];
        })
        .catch(() => {
          genreFilters = undefined;
          return [];
        });
      return [...(await genreFilters), ...STATIC_FILTERS];
    },
    async fetchMangaUpdates(slug) {
      details.clear();
      return chaptersOf(slug);
    },
  };
  return source;
}
