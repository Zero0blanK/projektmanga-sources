// ProjektManga Madara site preset: our catalogue, chapter and reader handling on top of
// madara.ts. Some request/selector conventions were informed by Keiyoushi (Apache-2.0);
// see THIRD_PARTY_NOTICES.md.
import { load } from "cheerio/slim";
import { HttpClient, NAV_HEADERS } from "./http.js";
import { TTLCache } from "./cache.js";
import { createMadaraSource } from "./madara.js";
import { attachHtmlCatalogue, htmlNext } from "./nativeCatalogue.js";
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

export interface MadaraSiteOptions {
  /**
   * How catalogues are listed: the title directory's `/page/N/` HTML (`"html"`, the
   * default), or the theme's `admin-ajax.php` `madara_load_more` listing (`"ajax"`) for
   * installs whose directory page is filled in by script and serves no cards itself.
   */
  browse?: "html" | "ajax";
}

/** Titles per `madara_load_more` page; a shorter page is the last. */
const AJAX_PAGE_SIZE = 25;

export function createMadaraSite(
  manifest: SourceManifest,
  filters: MangaFilter[],
  ajaxChapters: MadaraChapterMode = false,
  pageImages = ".reading-content img",
  directory = "manga",
  { browse = "html" }: MadaraSiteOptions = {},
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
  /**
   * One `madara_load_more` page for a catalogue URL built by `catalogueUrl`: the same
   * query (search term, order, status, genres) sent as the theme's archive query vars.
   */
  async function ajaxCatalogue(href: string): Promise<string> {
    const url = new URL(href);
    const page = Number(url.pathname.match(/\/page\/(\d+)\/$/)?.[1] ?? 1);
    const form = new URLSearchParams({
      action: "madara_load_more",
      page: String(page - 1),
      template: "madara-core/content/content-archive",
      "vars[paged]": "1",
      "vars[template]": "archive",
      "vars[posts_per_page]": String(AJAX_PAGE_SIZE),
      "vars[post_type]": "wp-manga",
      "vars[post_status]": "publish",
      "vars[manga_archives_item_layout]": "big_thumbnail",
    });
    const query = url.searchParams.get("s");
    if (query) form.set("vars[s]", query);
    const sortKey: Record<string, string> = {
      views: "_wp_manga_views",
      latest: "_latest_update",
      trending: "_wp_manga_week_views_value",
    };
    const order = url.searchParams.get("m_orderby") ?? "";
    if (sortKey[order]) {
      form.set("vars[orderby]", "meta_value_num");
      form.set("vars[meta_key]", sortKey[order]);
      form.set("vars[order]", "DESC");
    } else if (order === "alphabet") {
      form.set("vars[orderby]", "post_title");
      form.set("vars[order]", "ASC");
    } else if (order === "new-manga") {
      form.set("vars[orderby]", "date");
      form.set("vars[order]", "DESC");
    }
    const statuses = url.searchParams.getAll("status[]");
    if (statuses.length) {
      form.set("vars[meta_query][0][key]", "_wp_manga_status");
      form.set("vars[meta_query][0][compare]", "IN");
      statuses.forEach((value, index) =>
        form.set(`vars[meta_query][0][value][${index}]`, value),
      );
    }
    const genres = url.searchParams.getAll("genre[]");
    if (genres.length) {
      form.set("vars[tax_query][0][taxonomy]", "wp-manga-genre");
      form.set("vars[tax_query][0][field]", "slug");
      genres.forEach((value, index) =>
        form.set(`vars[tax_query][0][terms][${index}]`, value),
      );
    }
    const endpoint = `${base.origin}/wp-admin/admin-ajax.php`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          ...NAV_HEADERS,
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Requested-With": "XMLHttpRequest",
          Referer: `${base.origin}/${directory}/`,
        },
        body: form.toString(),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok)
        throw classifyHttpStatus(
          response.status,
          text.slice(0, 4000),
          manifest.source_key,
          manifest.name,
          endpoint,
        );
      return text;
    } catch (error) {
      if (error instanceof SourceError) throw error;
      throw classifyRequestError(
        error,
        manifest.source_key,
        manifest.name,
        endpoint,
      );
    } finally {
      clearTimeout(timer);
    }
  }
  /** A catalogue page's HTML, from the directory or the AJAX listing. */
  const catalogueText = (href: string) =>
    browse === "ajax" ? ajaxCatalogue(href) : http.getText(href);
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
    const genres = Array.isArray(active.genre) ? active.genre : [];
    const status = typeof active.status === "string" ? active.status : "";
    // Madara only filters through its search form: the title directory ignores status and
    // genre (and some installs 404 on it with them), so a filtered browse is an empty search.
    const searchForm = Boolean(query) || genres.length > 0 || Boolean(status);
    const url = new URL(
      searchForm ? `/page/${page}/` : `/${directory}/page/${page}/`,
      base,
    );
    if (searchForm) {
      url.searchParams.set("s", query);
      url.searchParams.set("post_type", "wp-manga");
    }
    // A search keeps the site's relevance order unless the reader picked one: some
    // installs (s2manga) drop the search term entirely when `m_orderby` comes with it.
    const order =
      typeof active.order === "string" && active.order
        ? active.order
        : query
          ? ""
          : category === "popular"
            ? "views"
            : "latest";
    if (order) url.searchParams.set("m_orderby", order);
    if (status) url.searchParams.append("status[]", status);
    for (const genre of genres) url.searchParams.append("genre[]", genre);
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
        parseCards(await catalogueText(catalogueUrl("", category, active, page))),
    );
  source.searchManga = async (query = "", pagination, active = {}) =>
    collectSequentialPages(
      resolvePagination(pagination, { limit: 30 }),
      manifest.source_key,
      async (page) =>
        parseCards(
          await catalogueText(catalogueUrl(query, undefined, active, page)),
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
    getText: async (path) => {
      try {
        return await catalogueText(new URL(path, base).href);
      } catch (error) {
        // A "Load more" listing gives no last-page evidence: a 404 past the first page is
        // its end, as in fetchManga.
        const page = Number(
          new URL(path, base).pathname.match(/\/page\/(\d+)\/$/)?.[1],
        );
        if (
          page > 1 &&
          error instanceof SourceError &&
          error.code === "NOT_FOUND"
        )
          return "";
        throw error;
      }
    },
    parse: parseCards,
    // Many installs page with an AJAX "Load more" button (#navigation-ajax) instead of a
    // next link; behind it is the same /page/N/ listing.
    next: (text, current) => {
      if (browse === "ajax") {
        // The AJAX listing has no next link: a full page means there may be another.
        if (parseCards(text).length < AJAX_PAGE_SIZE) return undefined;
        const next = new URL(current);
        next.pathname = next.pathname.replace(
          /\/page\/(\d+)\/$/,
          (_, page: string) => `/page/${Number(page) + 1}/`,
        );
        return next.pathname !== current.pathname ? next.href : undefined;
      }
      const link = htmlNext(text, current);
      if (!link && !load(text)("#navigation-ajax, .navigation-ajax").length)
        return undefined;
      // Only the page number is taken from the site's link. WordPress rewrites the query
      // in it (`genre[]` becomes `genre[0]`, `s=` becomes `s`), which the pager rightly
      // refuses as a different catalogue, so the request it continues is ours.
      const linked = link
        ? Number(new URL(link).pathname.match(/\/page\/(\d+)\/$/)?.[1])
        : NaN;
      const next = new URL(current);
      next.pathname = next.pathname.replace(
        /\/page\/(\d+)\/$/,
        (_, page: string) =>
          `/page/${linked > Number(page) ? linked : Number(page) + 1}/`,
      );
      if (next.pathname !== current.pathname) return next.href;
      return link;
    },
    path: ({ category, query, filters }) =>
      catalogueUrl(query ?? "", category, filters, 1),
    route: new RegExp(`^/(?:${directory}/(?:page/\\d+/)?|page/\\d+/)?$`),
    capabilities: { filters: filters.length > 0, languageFilter: false },
  });
}
