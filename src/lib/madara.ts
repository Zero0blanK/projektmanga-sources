import { load } from 'cheerio/slim';
import type { CheerioAPI, Cheerio } from 'cheerio/slim';
import type { AnyNode } from 'domhandler';

import type {
  Source,
  Mangas,
  Chapters,
  MangaFilter,
  Page,
  MangaDetails,
  FilterValue,
  Pagination,
  ChapterPagesResult,
} from './types.js';
import { HttpClient } from './http.js';
import { TTLCache } from './cache.js';
import { collectPaged } from './paginate.js';
import { mapMangaStatus, normalizeText, parseDateToIso, resolvePagination, toAbsoluteUrl } from './parse.js';
import { SourceError, classifyRequestError } from './sourceError.js';

/**
 * A source factory for sites built on the WordPress "Madara" manga theme — the same shape
 * as `apps/extensions/utils/madara.ts`, with the browser-automation fallback removed.
 *
 * That removal is the one behavioural difference worth knowing about: in the monorepo a
 * blocked request could fall back to Puppeteer with a stealth plugin. A sandboxed
 * extension has no browser and no real network of its own — every request is a proxied
 * `fetch` — so a Madara site behind an active Cloudflare challenge will return a
 * `BLOCKED` SourceError here rather than being solved. Sites that only sample
 * browser-shaped headers are fine; `NAV_HEADERS` sends what a browser sends.
 */

interface MadaraSelectors {
  browseCard: string;
  browseLink: string;
  browseTitle: string;
  browseImage: string;
  detailsTitle: string;
  detailsThumbnail: string;
  detailsAuthor: string;
  detailsGenres: string;
  detailsDescription: string;
  detailsStatus: string;
  chapterItem: string;
  chapterLink: string;
  chapterName: string;
  chapterDate: string;
  pageImage: string;
}

interface MadaraRuntimeConfig {
  sitePageSize: number;
  cacheTtlMs: number;
}

export interface MadaraSourceConfig {
  id: string;
  name: string;
  lang: string;
  baseUrl: string;
  isNSFW: boolean;
  http: HttpClient;
  selectors?: Partial<MadaraSelectors>;
  runtime?: Partial<MadaraRuntimeConfig>;
  buildBrowsePath?: (
    category: string | undefined,
    page: number,
    filters: Record<string, FilterValue>,
  ) => string;
  buildSearchPath?: (
    query: string | undefined,
    page: number,
    filters: Record<string, FilterValue>,
  ) => string;
  buildMangaPath?: (mangaId: string) => string;
  buildChapterPath?: (chapterKey: string, mangaSlug?: string) => string;
  getFilters?: () => Promise<MangaFilter[]> | MangaFilter[];
}

const DEFAULT_SELECTORS: MadaraSelectors = {
  browseCard: '.page-item-listing, .c-tabs-item__content',
  browseLink: 'a',
  browseTitle: '.item-summary h3 a, .post-title h3 a, .post-title a',
  browseImage: 'img',
  detailsTitle: '.post-title h1, h1',
  detailsThumbnail: '.summary_image img, .post-content_item .summary_image img',
  detailsAuthor:
    '.author-content a, .author-content, .post-content_item:contains("Author") .summary-content a',
  detailsGenres:
    '.genres-content a, .post-content_item:contains("Genre") .summary-content a',
  detailsDescription: '.description-summary, .summary__content p, .summary__content',
  detailsStatus:
    '.post-status .summary-content, .post-content_item:contains("Status") .summary-content',
  chapterItem: 'li.wp-manga-chapter, .listing-chapters_wrap li',
  chapterLink: 'a',
  chapterName: '.chapter-number, .chapter-manhwa-title, a',
  chapterDate: 'time, .chapter-release-date, .chapter-stats',
  pageImage: '.reading-content img',
};

const DEFAULT_RUNTIME: MadaraRuntimeConfig = {
  sitePageSize: 24,
  cacheTtlMs: 2 * 60 * 1000,
};

function extractMangaSlug(url: string, extraPrefixes: string[]): string {
  const noQuery = url.split('?')[0];
  const prefixes = ['manga', ...extraPrefixes];
  for (const prefix of prefixes) {
    const match = noQuery.match(new RegExp(`/${prefix}/([^/]+)/?`));
    if (match?.[1]) {
      return match[1];
    }
  }
  return '';
}

function extractChapterKey(url: string): string {
  const noQuery = url.split('?')[0].replace(/\/+$/, '');
  const readerMatch = noQuery.match(/\/reader\/[^/]+\/([^/]+)$/);
  if (readerMatch?.[1]) {
    return readerMatch[1];
  }

  const segments = noQuery.split('/').filter(Boolean);
  return segments[segments.length - 1] || '';
}

function parseChapterNumber(rawName: string, fallback: number): number {
  const parsed = Number.parseFloat(rawName.match(/[\d.]+/)?.[0] || '');
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function createMadaraSource(config: MadaraSourceConfig): Source {
  const selectors: MadaraSelectors = { ...DEFAULT_SELECTORS, ...(config.selectors || {}) };
  const runtime: MadaraRuntimeConfig = { ...DEFAULT_RUNTIME, ...(config.runtime || {}) };

  // Details and chapters are two calls against the same page; without this the second
  // one refetches what the first just downloaded.
  const htmlCache = new TTLCache<string, string>(runtime.cacheTtlMs, 60);

  // Some Madara installs mount titles under their own prefix rather than /manga/ — the
  // path builder knows which, so derive the slug prefixes to recognise from it.
  const slugPrefixes = Array.from(
    new Set(
      [config.buildMangaPath?.('__probe__') ?? '']
        .map((path) => path.match(/^\/([^/]+)\//)?.[1])
        .filter((prefix): prefix is string => Boolean(prefix)),
    ),
  );

  const buildBrowsePath =
    config.buildBrowsePath ||
    ((category, page) => `/manga/?m_orderby=${category === 'popular' ? 'popular' : 'latest'}&page=${page}`);
  const buildSearchPath =
    config.buildSearchPath ||
    ((query, page) => `/?s=${encodeURIComponent(query || '')}&post_type=wp-manga&page=${page}`);
  const buildMangaPath = config.buildMangaPath || ((mangaId: string) => `/manga/${mangaId}/`);
  const buildChapterPath =
    config.buildChapterPath ||
    ((chapterKey: string, mangaSlug?: string) => {
      const safeKey = chapterKey.replace(/^\/+|\/+$/g, '');
      return mangaSlug ? `/manga/${mangaSlug}/${safeKey}/` : `/${safeKey}/`;
    });

  async function fetchHtml(path: string): Promise<string> {
    try {
      return await htmlCache.getOrSet(path, () => config.http.getText(path));
    } catch (error) {
      throw classifyRequestError(error, config.id, config.name, path);
    }
  }

  function parseBrowseItems($: CheerioAPI): Mangas[] {
    return $(selectors.browseCard)
      .map((_, el) => {
        const node = $(el);
        const linkNode = node.find(selectors.browseLink).first();
        const titleNode = node.find(selectors.browseTitle).first();
        const imageNode = node.find(selectors.browseImage).first();

        const href = titleNode.attr('href') || linkNode.attr('href') || '';
        const id = extractMangaSlug(href, slugPrefixes);
        if (!id) {
          return null;
        }

        const imageSrc =
          imageNode.attr('data-src') ||
          imageNode.attr('data-lazy-src') ||
          imageNode.attr('src') ||
          '';

        return {
          source: config.id,
          id,
          slug: id,
          title: normalizeText(titleNode.text()) || 'No Title',
          thumbnail_url: toAbsoluteUrl(imageSrc.trim(), config.baseUrl),
        } as Mangas;
      })
      .get()
      .filter((item): item is Mangas => item !== null);
  }

  async function browse(
    buildPath: (page: number) => string,
    pagination: Pagination | undefined,
  ): Promise<Mangas[]> {
    const { limit, offset } = resolvePagination(pagination, { limit: runtime.sitePageSize });

    return collectPaged({ limit, offset, sitePageSize: runtime.sitePageSize }, async (page) => {
      const html = await fetchHtml(buildPath(page));
      return parseBrowseItems(load(html));
    });
  }

  function parseChapters($: CheerioAPI, mangaId: string): Chapters[] {
    return $(selectors.chapterItem)
      .map((index, el) => {
        const node = $(el);
        const linkNode = node.find(selectors.chapterLink).first();
        const href = linkNode.attr('href') || '';

        const chapterKey = extractChapterKey(href);
        if (!chapterKey) {
          return null;
        }

        const rawName =
          normalizeText(node.find(selectors.chapterName).first().text()) ||
          normalizeText(linkNode.text());
        const dateNode = node.find(selectors.chapterDate).first();
        const rawDate =
          dateNode.attr('datetime') || dateNode.attr('title') || normalizeText(dateNode.text()) || '';

        return {
          id: `${mangaId}-${chapterKey}`,
          name: rawName || `Chapter ${index + 1}`,
          url: toAbsoluteUrl(href, config.baseUrl),
          chapter_number: parseChapterNumber(rawName, index + 1),
          scanlator: 'Unknown',
          language: config.lang,
          last_page_read: 0,
          release_date: parseDateToIso(rawDate),
          page_count: 0,
          pages: [],
        } as Chapters;
      })
      .get()
      .filter((chapter): chapter is Chapters => chapter !== null);
  }

  const source: Source = {
    id: config.id,
    name: config.name,
    lang: config.lang,
    base_url: config.baseUrl,
    isNSFW: config.isNSFW,

    async fetchManga(category, pagination, filters): Promise<Mangas[]> {
      return browse((page) => buildBrowsePath(category, page, filters || {}), pagination);
    },

    async searchManga(query, pagination, filters): Promise<Mangas[]> {
      return browse((page) => buildSearchPath(query, page, filters || {}), pagination);
    },

    async fetchMangaDetails(mangaId: string): Promise<MangaDetails> {
      const $ = load(await fetchHtml(buildMangaPath(mangaId)));

      const thumbnailNode = $(selectors.detailsThumbnail).first();
      const thumbnailRaw =
        thumbnailNode.attr('data-src') ||
        thumbnailNode.attr('data-lazy-src') ||
        thumbnailNode.attr('src') ||
        '';

      return {
        source: config.id,
        id: mangaId,
        slug: mangaId,
        title: normalizeText($(selectors.detailsTitle).first().text()) || 'No Title',
        thumbnail_url: toAbsoluteUrl(thumbnailRaw.trim(), config.baseUrl),
        description: normalizeText($(selectors.detailsDescription).first().text()),
        author: $(selectors.detailsAuthor)
          .map((_, el) => normalizeText($(el).text()))
          .get()
          .filter(Boolean),
        genres: $(selectors.detailsGenres)
          .map((_, el) => normalizeText($(el).text()))
          .get()
          .filter(Boolean),
        status: mapMangaStatus(normalizeText($(selectors.detailsStatus).first().text())),
        chapters: parseChapters($, mangaId),
      };
    },

    async fetchMangaThumbnail(mangaId: string): Promise<string> {
      // Decorative — degrade gracefully rather than failing a whole detail view over a
      // missing cover.
      try {
        const $ = load(await fetchHtml(buildMangaPath(mangaId)));
        const node = $(selectors.detailsThumbnail).first();
        const raw = node.attr('data-src') || node.attr('data-lazy-src') || node.attr('src') || '';
        return toAbsoluteUrl(raw.trim(), config.baseUrl);
      } catch {
        return '';
      }
    },

    async fetchChapters(mangaId: string): Promise<Chapters[]> {
      const $ = load(await fetchHtml(buildMangaPath(mangaId)));
      return parseChapters($, mangaId);
    },

    async fetchChapterPages(
      chapterId: string,
      mangaSlug?: string,
      pagination?: Pagination,
    ): Promise<ChapterPagesResult<Page>> {
      const chapterKey = mangaSlug ? chapterId.replace(`${mangaSlug}-`, '') : chapterId;
      const rawPath = /^https?:\/\//i.test(chapterId) ? chapterId : buildChapterPath(chapterKey, mangaSlug);
      const path = /^https?:\/\//i.test(rawPath) ? rawPath.replace(config.baseUrl, '') : rawPath;

      const $ = load(await fetchHtml(path));

      const imageUrls = $(selectors.pageImage)
        .map((_, el) => {
          const node: Cheerio<AnyNode> = $(el);
          return (
            node.attr('data-src') ||
            node.attr('data-lazy-src') ||
            node.attr('data-original') ||
            node.attr('src') ||
            ''
          );
        })
        .get()
        .map((url) => toAbsoluteUrl(url.trim(), config.baseUrl))
        .filter((url) => {
          const lower = url.toLowerCase();
          return url.startsWith('http') && !lower.includes('credits') && !lower.includes('logo');
        });

      const uniqueImageUrls = Array.from(new Set(imageUrls));
      const total = uniqueImageUrls.length;

      if (total === 0) {
        // The page loaded but no page images matched — a reader with zero pages is not a
        // real state, so this is the site having changed its markup, not an empty chapter.
        throw new SourceError(
          'PARSE_ERROR',
          `${config.name} returned no readable pages for this chapter — it may have changed its layout.`,
          config.id,
        );
      }

      const { limit, offset } = resolvePagination(pagination, { limit: total });
      const start = Math.min(offset, total);
      const end = Math.min(start + Math.max(1, limit), total);

      return {
        items: uniqueImageUrls.slice(start, end).map((imageUrl, idx) => ({
          index: start + idx + 1,
          image_url: imageUrl,
        })),
        total,
      };
    },

    async getFilters(): Promise<MangaFilter[]> {
      return config.getFilters ? await config.getFilters() : [];
    },

    async fetchMangaUpdates(mangaSlug: string): Promise<Chapters[]> {
      return source.fetchChapters(mangaSlug);
    },
  };

  return source;
}
