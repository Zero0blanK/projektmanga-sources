// ProjektManga Madara site preset: our catalogue, chapter and reader handling on top of
// madara.ts. Some request/selector conventions were informed by Keiyoushi (Apache-2.0);
// see THIRD_PARTY_NOTICES.md.
import { load } from "cheerio/slim";
import { HttpClient, NAV_HEADERS } from "./http.js";
import { TTLCache } from "./cache.js";
import { createMadaraSource } from "./madara.js";
import { attachHtmlCatalogue } from "./nativeCatalogue.js";
import { collectSequentialPages } from "./sequentialPagination.js";
import { normalizeText, resolvePagination } from "./parse.js";
import {
  SourceError,
  classifyHttpStatus,
  classifyRequestError,
} from "./sourceError.js";
import type {
  SourceManifest,
  MangaFilter,
  Mangas,
  Chapters,
  FilterValue,
} from "./types.js";

/**
 * How a title's chapters are listed: on its own page, through one POST to its
 * `ajax/chapters/` endpoint (`true`), or through that endpoint a page at a time
 * (`"paginated"`, `?t=1`, `?t=2`… until a page is empty or repeats).
 */
export type MadaraChapterMode = boolean | "paginated";

export function createMadaraSite(
  manifest: SourceManifest,
  filters: MangaFilter[],
  ajaxChapters: MadaraChapterMode = false,
  pageImages = ".reading-content img",
  directory = "manga",
) {
  if (!/^[A-Za-z0-9_-]+$/.test(directory))
    throw new Error(`Invalid Madara directory: ${directory}`);
  // Titles live under one directory per site ("manga", "series", "webtoon"…); a URL under
  // any other is not one of this site's titles.
  const titlePath = new RegExp(`^/${directory}/[A-Za-z0-9_-]+/$`);
  const chapterPathPattern = new RegExp(
    `^/${directory}/[A-Za-z0-9_-]+(?:/(?!\\.{1,2}/)[A-Za-z0-9._-]+)*/$`,
  );
  const base = new URL(manifest.base_url);
  const cache = new TTLCache<string, string>(30_000, 40);
  const fail = (message: string): never => {
    throw new SourceError(
      "PARSE_ERROR",
      `${manifest.name}: ${message}`,
      manifest.source_key,
    );
  };
  const id = (value: string) =>
    /^[A-Za-z0-9_-]+$/.test(value) && value.length <= 300
      ? value
      : fail("Invalid title identifier");
  const safePath = (value: string) => {
    const url = new URL(value, base);
    if (
      url.origin !== base.origin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      // Chapter segments may carry decimals ("chapter-64.20"); never "." or "..".
      !chapterPathPattern.test(url.pathname)
    )
      return fail("Invalid chapter URL");
    return url.pathname;
  };
  async function postChapters(path: string, page?: number): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const url = `${base.origin}${path}ajax/chapters/${page ? `?t=${page}` : ""}`;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          ...NAV_HEADERS,
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Requested-With": "XMLHttpRequest",
          Referer: `${base.origin}${path}`,
        },
        body: "",
        signal: controller.signal,
      });
      const text = await response.text();
      // Paginated listings end with a 404 past the last page.
      if (page && response.status === 404) return "";
      if (!response.ok)
        throw classifyHttpStatus(
          response.status,
          text.slice(0, 4000),
          manifest.source_key,
          manifest.name,
          url,
        );
      return text;
    } catch (error) {
      if (error instanceof SourceError) throw error;
      throw classifyRequestError(
        error,
        manifest.source_key,
        manifest.name,
        url,
      );
    } finally {
      clearTimeout(timer);
    }
  }
  /** Every page of a paginated chapter listing, until one is empty or repeats the last. */
  async function paginatedChapters(path: string): Promise<string> {
    const pages: string[] = [];
    let previousLast = "";
    for (let page = 1; page <= 100; page++) {
      const fragment = await postChapters(path, page);
      const $ = load(fragment);
      const links = $("li.wp-manga-chapter a")
        .map((_, el) => $(el).attr("href") ?? "")
        .get();
      const last = links[links.length - 1] ?? "";
      if (links.length === 0 || last === previousLast) break;
      pages.push(fragment);
      previousLast = last;
    }
    return pages.join("");
  }
  class MadaraHttp extends HttpClient {
    override async getText(path: string) {
      return cache.getOrSet(path, async () => {
        const html = await super.getText(path);
        const url = new URL(path, base);
        if (!ajaxChapters || !titlePath.test(url.pathname) || url.search)
          return html;
        const fragment =
          ajaxChapters === "paginated"
            ? await paginatedChapters(url.pathname)
            : await postChapters(url.pathname);
        const $ = load(html);
        $("li.wp-manga-chapter").remove();
        if (!$("body").length) return html + fragment;
        $("body").append(fragment);
        return $.html();
      });
    }
  }
  const http = new MadaraHttp({
    sourceId: manifest.source_key,
    sourceName: manifest.name,
    baseUrl: manifest.base_url,
    headers: NAV_HEADERS,
    rateLimitMs: 550,
  });
  const catalogueUrl = (
    query: string,
    category: string | undefined,
    active: Record<string, FilterValue>,
    page: number,
  ) => {
    const url = new URL(
      query ? `/page/${page}/` : `/${directory}/page/${page}/`,
      base,
    );
    if (query) {
      url.searchParams.set("s", query);
      url.searchParams.set("post_type", "wp-manga");
    }
    url.searchParams.set(
      "m_orderby",
      typeof active.order === "string" && active.order
        ? active.order
        : category === "popular"
          ? "views"
          : "latest",
    );
    for (const key of ["status", "type"])
      if (typeof active[key] === "string" && active[key])
        url.searchParams.set(`manga_${key}`, active[key]);
    if (Array.isArray(active.genre))
      for (const genre of active.genre)
        url.searchParams.append("genre[]", genre);
    return url.href;
  };
  function parseCards(text: string): Mangas[] {
    const $ = load(text);
    const rows: Mangas[] = [];
    const cards = $(".page-item-detail, .c-tabs-item__content").toArray();
    let untitled = 0;
    for (const element of cards) {
      const card = $(element),
        link = card.find(".post-title a, .item-summary h3 a, h3 a").first();
      const href = link.attr("href");
      if (!href) continue;
      const url = new URL(href, base);
      // Some installs link titles without WordPress's trailing slash; same title.
      url.pathname = url.pathname.replace(/\/?$/, "/");
      if (url.origin !== base.origin || !titlePath.test(url.pathname)) continue;
      const key = url.pathname.split("/")[2],
        title = normalizeText(link.text());
      // An untitled card is skipped; only a page of nothing but untitled cards fails.
      if (!title) {
        untitled++;
        continue;
      }
      const image = card.find("img").first();
      const raw =
        image.attr("data-src") ||
        image.attr("data-lazy-src") ||
        image.attr("src") ||
        "";
      rows.push({
        id: key,
        slug: key,
        source: manifest.source_key,
        title,
        thumbnail_url: raw ? new URL(raw.trim(), base).href : "",
      });
    }
    if (rows.length === 0 && untitled > 0) return fail("Missing catalogue title");
    return [...new Map(rows.map((row) => [row.id, row])).values()];
  }
  const source = createMadaraSource({
    id: manifest.source_key,
    name: manifest.name,
    lang: manifest.lang,
    baseUrl: manifest.base_url,
    isNSFW: manifest.content_rating === "nsfw",
    http,
    runtime: { cacheTtlMs: 0 },
    buildMangaPath: (value) => `/${directory}/${value}/`,
    selectors: { pageImage: pageImages },
    getFilters: () => filters,
  });
  const originals = {
    details: source.fetchMangaDetails,
    chapters: source.fetchChapters,
    pages: source.fetchChapterPages,
  };
  const chapterPath = (value: string) => {
    // Some installs link chapters without the trailing slash WordPress normally adds:
    // the same chapter, so it is read as one rather than dropped.
    for (const candidate of [value, value.replace(/\/?$/, "/")]) {
      try {
        return safePath(candidate);
      } catch {
        // Try the next spelling.
      }
    }
    return undefined;
  };
  // Volume headings ("javascript:void(0)") and locked "#" links are not chapters:
  // skip them instead of failing the whole list.
  const prefixChapters = (rows: Chapters[]) =>
    [
      ...new Map(
        rows.flatMap((row) => {
          const path = chapterPath(row.url);
          return path
            ? [[path, { ...row, id: `${manifest.source_key}:${path}` }] as const]
            : [];
        }),
      ).values(),
    ].sort((a, b) => b.chapter_number - a.chapter_number);
  source.fetchMangaDetails = async (value) => {
    const result = await originals.details(id(value));
    if (!result.title || result.title === "No Title")
      return fail("Missing title metadata");
    return { ...result, chapters: prefixChapters(result.chapters) };
  };
  source.fetchChapters = async (value) =>
    prefixChapters(await originals.chapters(id(value)));
  source.fetchMangaUpdates = async (value) => {
    cache.clear();
    return source.fetchChapters(value);
  };
  source.fetchMangaThumbnail = async (value) =>
    (await source.fetchMangaDetails(value)).thumbnail_url;
  source.fetchChapterPages = async (value, slug, pagination) => {
    const prefix = `${manifest.source_key}:`;
    if (!value.startsWith(prefix)) return fail("Invalid chapter identifier");
    const path = safePath(value.slice(prefix.length));
    if (slug && path.split("/")[2] !== id(slug))
      return fail("Chapter belongs to another title");
    return originals.pages(`${base.origin}${path}`, undefined, pagination);
  };
  source.fetchManga = async (category, pagination, active = {}) =>
    collectSequentialPages(
      resolvePagination(pagination, { limit: 30 }),
      manifest.source_key,
      async (page) =>
        parseCards(
          await http.getText(catalogueUrl("", category, active, page)),
        ),
    );
  source.searchManga = async (query = "", pagination, active = {}) =>
    collectSequentialPages(
      resolvePagination(pagination, { limit: 30 }),
      manifest.source_key,
      async (page) =>
        parseCards(
          await http.getText(catalogueUrl(query, undefined, active, page)),
        ),
    );
  source.resolveMangaUrl = async (value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    if (
      url.origin !== base.origin ||
      url.username ||
      url.password ||
      !titlePath.test(url.pathname)
    )
      return null;
    return source.fetchMangaDetails(url.pathname.split("/")[2]);
  };
  return attachHtmlCatalogue(source, {
    getText: (path) => http.getText(path),
    parse: parseCards,
    path: ({ category, query, filters }) =>
      catalogueUrl(query ?? "", category, filters, 1),
    route: new RegExp(`^/(?:${directory}/(?:page/\\d+/)?|page/\\d+/)?$`),
    capabilities: { filters: filters.length > 0, languageFilter: false },
  });
}
