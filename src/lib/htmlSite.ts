// A whole `Source` for a site read from plain HTML pages, from a short per-site spec: how
// to build its catalogue, search, title and chapter URLs, and how to read each page. The
// HTTP client, rate limit, caching, pagination window, identifier checks and error
// reporting are the same for every such site, so a port says only what is particular to
// its site. Several ports follow Keiyoushi extensions (Apache-2.0); see
// THIRD_PARTY_NOTICES.md and each port's header.
import { load, type CheerioAPI } from "cheerio/slim";
import { HttpClient, NAV_HEADERS } from "./http.js";
import { TTLCache } from "./cache.js";
import { collectSequentialPages } from "./sequentialPagination.js";
import { deriveIsNSFW } from "./manifest.js";
import { resolvePagination } from "./parse.js";
import { SourceError } from "./sourceError.js";
import type {
  ChapterPagesResult,
  Chapters,
  FilterValue,
  MangaDetails,
  MangaFilter,
  Mangas,
  Page,
  Source,
  SourceManifest,
} from "./types.js";

/** A title as a site's page describes it; `id`, `slug`, `source` and `chapters` are filled
 * in by the helper. */
export type ParsedDetails = Omit<
  MangaDetails,
  "id" | "slug" | "source" | "chapters"
>;

/** A chapter as a site lists it; the helper fills in the bookkeeping fields. */
export interface ParsedChapter {
  /** The site's own stable key for the chapter: what `chapterPath` turns back into a URL. */
  key: string;
  name: string;
  number: number;
  date?: string;
  scanlator?: string;
}

export interface HtmlSiteSpec {
  /** Catalogue page `page` (1-based) for "popular"/"latest" and the active filters, or null
   * past the last page of a listing the site doesn't paginate. */
  catalogueUrl(
    category: string | undefined,
    page: number,
    filters: Record<string, FilterValue>,
  ): string | null;
  /** Search results page `page` for `query`, or null when there is no such page. */
  searchUrl(
    query: string,
    page: number,
    filters: Record<string, FilterValue>,
  ): string | null;
  /** The site has no search: search filters its (small, unpaginated) catalogue by title. */
  localSearch?: boolean;
  /** The search page lists every title and the browser filters it: keep only the titles
   * containing the query. */
  searchFiltersTitles?: boolean;
  parseCards($: CheerioAPI, base: URL): Array<Omit<Mangas, "source">>;
  /** The title's page from its id (the id is the site's own slug or path key). */
  titleUrl(id: string): string;
  parseDetails($: CheerioAPI, id: string, base: URL): ParsedDetails;
  parseChapters($: CheerioAPI, id: string, base: URL): ParsedChapter[];
  /** Where the chapters come from when it isn't the title page (a JSON API), and how to
   * read that response. Used instead of `parseChapters`. */
  chapterList?: {
    url(id: string): string;
    parse(body: string, id: string): ParsedChapter[];
  };
  /** Extra chapter-list pages to fetch when the title page holds only the first. */
  moreChapterPages?($: CheerioAPI, id: string, base: URL): string[];
  /** The reader page for a chapter key, and its page images. */
  chapterUrl(key: string, mangaId?: string): string;
  /** The reader's page images. `fetchText` makes the site's follow-up requests (one
   * reader page per image, a script endpoint), through the same rate-limited client. */
  parsePages(
    $: CheerioAPI,
    html: string,
    base: URL,
    fetchText: (url: string, headers?: Record<string, string>) => Promise<string>,
    chapterUrl: string,
  ): string[] | Promise<string[]>;
  /** What a valid title id looks like; anything else is refused before a request. */
  idPattern?: RegExp;
  /** What a valid chapter key looks like. */
  chapterKeyPattern?: RegExp;
  filters?: MangaFilter[];
  /** Extra headers for every request (e.g. a Referer the site expects). */
  headers?: Record<string, string>;
  rateLimitMs?: number;
}

const DEFAULT_ID = /^[A-Za-z0-9][A-Za-z0-9._~%-]{0,299}$/;
const DEFAULT_CHAPTER_KEY = /^[A-Za-z0-9][A-Za-z0-9._~%/-]{0,499}$/;

export function createHtmlSite(
  manifest: SourceManifest,
  spec: HtmlSiteSpec,
): Source {
  const base = new URL(manifest.base_url);
  const idPattern = spec.idPattern ?? DEFAULT_ID;
  const keyPattern = spec.chapterKeyPattern ?? DEFAULT_CHAPTER_KEY;
  const http = new HttpClient({
    sourceId: manifest.source_key,
    sourceName: manifest.name,
    baseUrl: manifest.base_url,
    headers: {
      ...NAV_HEADERS,
      Referer: `${base.origin}/`,
      ...(spec.headers ?? {}),
    },
    rateLimitMs: spec.rateLimitMs ?? 500,
  });
  // Details and chapters read the same title page; this keeps that to one request.
  const pages = new TTLCache<string, string>(30_000, 40);
  const fail = (message: string): never => {
    throw new SourceError(
      "PARSE_ERROR",
      `${manifest.name}: ${message}`,
      manifest.source_key,
    );
  };
  const text = (url: string) => pages.getOrSet(url, () => http.getText(url));
  /** A cover the page gave as a relative path, made absolute ("" stays ""). */
  const absolute = (src: string) => {
    if (!src) return "";
    try {
      return new URL(src, base).href;
    } catch {
      return "";
    }
  };
  const checkId = (id: string) =>
    idPattern.test(id) ? id : fail("Invalid title identifier");
  const chapterPrefix = `${manifest.source_key}:`;

  function cards(html: string): Mangas[] {
    const $ = load(html);
    return spec
      .parseCards($, base)
      .filter((row) => row.id && row.title && idPattern.test(row.id))
      .map((row) => ({
        ...row,
        source: manifest.source_key,
        thumbnail_url: absolute(row.thumbnail_url),
      }));
  }

  async function chaptersOf($: CheerioAPI, id: string): Promise<Chapters[]> {
    const rows = spec.chapterList
      ? spec.chapterList.parse(await http.getText(spec.chapterList.url(id)), id)
      : [...spec.parseChapters($, id, base)];
    for (const url of spec.moreChapterPages?.($, id, base) ?? [])
      rows.push(...spec.parseChapters(load(await text(url)), id, base));
    const seen = new Set<string>();
    return rows
      .filter(
        (row) =>
          keyPattern.test(row.key) && !seen.has(row.key) && seen.add(row.key),
      )
      .map((row) => ({
        id: `${chapterPrefix}${row.key}`,
        name: row.name,
        url: new URL(spec.chapterUrl(row.key, id), base).href,
        chapter_number: Number.isFinite(row.number) ? row.number : 0,
        scanlator: row.scanlator,
        release_date: row.date ?? "",
        language: manifest.lang,
        last_page_read: 0,
        pages: [],
      }))
      .sort((a, b) => b.chapter_number - a.chapter_number);
  }

  async function details(value: string): Promise<MangaDetails> {
    const id = checkId(value);
    const $ = load(await text(spec.titleUrl(id)));
    const parsed = spec.parseDetails($, id, base);
    if (!parsed.title) return fail("Missing title metadata");
    return {
      ...parsed,
      thumbnail_url: absolute(parsed.thumbnail_url),
      id,
      slug: id,
      source: manifest.source_key,
      url: parsed.url ?? new URL(spec.titleUrl(id), base).href,
      chapters: await chaptersOf($, id),
    };
  }

  const source: Source = {
    id: manifest.source_key,
    name: manifest.name,
    lang: manifest.lang,
    base_url: manifest.base_url,
    isNSFW: deriveIsNSFW(manifest.content_rating),
    async fetchManga(category, pagination, filters = {}) {
      return collectSequentialPages(
        resolvePagination(pagination, { limit: 30 }),
        manifest.source_key,
        async (page) => {
          const url = spec.catalogueUrl(category, page, filters);
          return url ? cards(await text(url)) : [];
        },
      );
    },
    async searchManga(query = "", pagination, filters = {}) {
      if (!query.trim())
        return source.fetchManga("popular", pagination, filters);
      if (spec.localSearch) {
        const needle = query.trim().toLowerCase();
        const all = await source.fetchManga(
          "popular",
          { limit: 1000, offset: 0 },
          filters,
        );
        const { limit, offset } = resolvePagination(pagination, { limit: 30 });
        return all
          .filter((row) => row.title.toLowerCase().includes(needle))
          .slice(offset, offset + limit);
      }
      return collectSequentialPages(
        resolvePagination(pagination, { limit: 30 }),
        manifest.source_key,
        async (page) => {
          const url = spec.searchUrl(query.trim(), page, filters);
          const rows = url ? cards(await text(url)) : [];
          const needle = query.trim().toLowerCase();
          return spec.searchFiltersTitles
            ? rows.filter((row) => row.title.toLowerCase().includes(needle))
            : rows;
        },
      );
    },
    fetchMangaDetails: details,
    async fetchMangaThumbnail(id) {
      try {
        return (await details(id)).thumbnail_url;
      } catch {
        return "";
      }
    },
    async fetchChapters(value) {
      const id = checkId(value);
      return chaptersOf(load(await text(spec.titleUrl(id))), id);
    },
    async fetchChapterPages(
      chapterId,
      mangaSlug,
      pagination,
    ): Promise<ChapterPagesResult<Page>> {
      if (!chapterId.startsWith(chapterPrefix))
        return fail("Invalid chapter identifier");
      const key = chapterId.slice(chapterPrefix.length);
      if (!keyPattern.test(key) || key.includes(".."))
        return fail("Invalid chapter identifier");
      const url = spec.chapterUrl(
        key,
        mangaSlug ? checkId(mangaSlug) : undefined,
      );
      const html = await http.getText(url);
      const images = [
        ...new Set(
          (
            await spec.parsePages(
              load(html),
              html,
              base,
              (next, headers) => http.getText(next, headers ? { headers } : {}),
              new URL(url, base).href,
            )
          )
            .map((src) => src.trim())
            .filter(Boolean)
            .map((src) => new URL(src, base).href)
            .filter(
              (src) => src.startsWith("https://") || src.startsWith("http://"),
            ),
        ),
      ];
      if (images.length === 0)
        throw new SourceError(
          "PARSE_ERROR",
          `${manifest.name} returned no readable pages for this chapter — it may have changed its layout.`,
          manifest.source_key,
        );
      const { limit, offset } = resolvePagination(pagination, {
        limit: images.length,
      });
      const start = Math.min(offset, images.length);
      return {
        items: images
          .slice(start, start + Math.max(1, limit))
          .map((image_url, index) => ({ index: start + index + 1, image_url })),
        total: images.length,
      };
    },
    async getFilters() {
      return spec.filters ?? [];
    },
    async fetchMangaUpdates(value) {
      pages.clear();
      return source.fetchChapters(value);
    },
  };
  return source;
}

/** The image a lazily loaded `<img>` will show: its data-* source, else its `src`. */
export function lazyImage(node: {
  attr(name: string): string | undefined;
}): string {
  return (
    node.attr("data-src") ||
    node.attr("data-lazy-src") ||
    node.attr("data-original") ||
    node.attr("data-cfsrc") ||
    node.attr("src") ||
    ""
  ).trim();
}
