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
  ChapterPagesResult,
  SourceManifest,
} from '../lib/types.js';
import { HttpClient, JSON_HEADERS, NAV_HEADERS } from '../lib/http.js';
import { TTLCache } from '../lib/cache.js';
import { fetchJsonHtmlBrowse } from '../lib/jsonHtmlBrowse.js';
import { mapMangaStatus, normalizeText, parseDateToIso, resolvePagination, toAbsoluteUrl } from '../lib/parse.js';
import { SourceError, classifyRequestError } from '../lib/sourceError.js';
import { deriveIsNSFW } from '../lib/manifest.js';
import manifest from './manifest.json';

const { source_key: SOURCE_ID, name: SOURCE_NAME, lang: SOURCE_LANG } = manifest as SourceManifest;
const BASE_URL = manifest.base_url;
const CACHE_TTL_MS = 2 * 60 * 1000;

/** Browsing goes through an endpoint that answers with JSON, reading goes through
 * ordinary pages — two clients so each sends the right Accept header. */
const pageHttp = new HttpClient({
  sourceId: SOURCE_ID,
  sourceName: SOURCE_NAME,
  baseUrl: BASE_URL,
  headers: NAV_HEADERS,
  rateLimitMs: 240,
});

const jsonHttp = new HttpClient({
  sourceId: SOURCE_ID,
  sourceName: SOURCE_NAME,
  baseUrl: BASE_URL,
  headers: { ...JSON_HEADERS, 'X-Requested-With': 'XMLHttpRequest' },
  rateLimitMs: 240,
});

const htmlCache = new TTLCache<string, string>(CACHE_TTL_MS, 60);

async function fetchHtml(path: string): Promise<string> {
  try {
    return await htmlCache.getOrSet(path, () => pageHttp.getText(path));
  } catch (error) {
    throw classifyRequestError(error, SOURCE_ID, SOURCE_NAME, path);
  }
}

function parseBrowseCard(node: Cheerio<AnyNode>): Mangas | null {
  const titleLink = node.find('.comic-card__title a').first();
  const coverImage = node.find('.comic-card__cover img').first();
  const href = titleLink.attr('href') || node.find('a').first().attr('href') || '';
  const id = href.match(/(?<=\/manga\/)[^/]+/)?.[0] || '';

  if (!id) {
    return null;
  }

  const imageSrc = coverImage.attr('src') || coverImage.attr('data-src') || '';

  return {
    source: SOURCE_ID,
    id,
    slug: id,
    title: normalizeText(titleLink.text()) || 'No Title',
    thumbnail_url: toAbsoluteUrl(imageSrc.trim(), BASE_URL),
  };
}

/** Chapter URLs look like /reader/en/<slug>/ — the slug alone is the chapter's identity. */
function extractChapterSlug(url: string): string {
  if (!url) {
    return '';
  }
  return url.match(/\/reader\/en\/([^/]+)\/?/)?.[1] || '';
}

function parseChapters($: CheerioAPI): Chapters[] {
  return $('ul.chapter-list li')
    .map((_, el) => {
      const node = $(el);
      const href = node.find('a').first().attr('href') || '';
      const chapterSlug = extractChapterSlug(href);
      if (!chapterSlug) {
        return null;
      }

      const chapterNumber = node.find('.chapter-title').first().text().match(/[\d.]+/)?.[0] || '';

      return {
        id: chapterSlug,
        name: '',
        url: toAbsoluteUrl(href, BASE_URL),
        chapter_number: Number(chapterNumber) || 0,
        scanlator: 'Unknown',
        language: SOURCE_LANG,
        last_page_read: 0,
        release_date: parseDateToIso(node.find('.chapter-update').attr('datetime') || ''),
        page_count: 0,
        pages: [],
      } as Chapters;
    })
    .get()
    .filter((chapter): chapter is Chapters => chapter !== null);
}

const mangageko: Source = {
  id: SOURCE_ID,
  name: SOURCE_NAME,
  lang: SOURCE_LANG,
  base_url: BASE_URL,
  isNSFW: deriveIsNSFW(manifest.content_rating),

  async fetchManga(category, pagination, filters): Promise<Mangas[]> {
    try {
      const { limit, offset } = resolvePagination(pagination, { limit: 24 });
      const sort = category === 'popular' ? 'popular_all_time' : 'latest';
      const safeMode = (filters as Record<string, FilterValue> | undefined)?.nsfw === 'off' ? 0 : 1;

      return await fetchJsonHtmlBrowse<Mangas>(
        {
          cacheKeyPrefix: SOURCE_ID,
          http: jsonHttp,
          endpoint: '/browse-comics/data/',
          itemSelector: 'article.comic-card',
          sitePageSize: 24,
          maxPrefetchPages: 2,
          cacheTtlMs: CACHE_TTL_MS,
          buildParams: (page) => ({ sort, safe_mode: safeMode, page }),
          mapItem: (node) => parseBrowseCard(node),
        },
        { limit, offset },
      );
    } catch (error) {
      throw classifyRequestError(error, SOURCE_ID, SOURCE_NAME);
    }
  },

  async searchManga(query, pagination, filters): Promise<Mangas[]> {
    try {
      const { limit, offset } = resolvePagination(pagination, { limit: 24 });
      const safeMode = (filters as Record<string, FilterValue> | undefined)?.nsfw === 'off' ? 0 : 1;

      return await fetchJsonHtmlBrowse<Mangas>(
        {
          cacheKeyPrefix: `${SOURCE_ID}:search`,
          http: jsonHttp,
          endpoint: '/browse-comics/data/',
          itemSelector: 'article.comic-card',
          sitePageSize: 24,
          maxPrefetchPages: 2,
          cacheTtlMs: CACHE_TTL_MS,
          buildParams: (page) => ({ sort: 'latest', safe_mode: safeMode, page, q: query || '' }),
          mapItem: (node) => parseBrowseCard(node),
        },
        { limit, offset },
      );
    } catch (error) {
      throw classifyRequestError(error, SOURCE_ID, SOURCE_NAME);
    }
  },

  async fetchMangaDetails(manga_id: string): Promise<MangaDetails> {
    const $ = load(await fetchHtml(`/manga/${manga_id}/`));

    const cover = $('header.novel-header .cover img').first();
    const thumbnailRaw = cover.attr('data-src') || cover.attr('src') || '';

    const statusRaw = normalizeText(
      $('small:contains("Status")').closest('span').find('strong').first().text(),
    );

    return {
      source: SOURCE_ID,
      id: manga_id,
      slug: manga_id,
      title: normalizeText($('h1.novel-title').first().text()) || 'No Title',
      author: $('span[itemprop="author"]')
        .map((_, el) => normalizeText($(el).text()))
        .get()
        .filter(Boolean),
      thumbnail_url: toAbsoluteUrl(thumbnailRaw.trim(), BASE_URL),
      description: normalizeText($('p.description').first().text()),
      genres: $('.categories li a')
        .map((_, el) => normalizeText($(el).text()))
        .get()
        .filter(Boolean),
      status: mapMangaStatus(statusRaw),
      chapters: await mangageko.fetchChapters(manga_id),
    };
  },

  async fetchMangaThumbnail(manga_id: string): Promise<string> {
    // Decorative — degrade gracefully rather than failing a whole detail view over a
    // missing cover.
    try {
      const $ = load(await fetchHtml(`/manga/${manga_id}/`));
      const cover = $('header.novel-header .cover img').first();
      return toAbsoluteUrl((cover.attr('data-src') || cover.attr('src') || '').trim(), BASE_URL);
    } catch {
      return '';
    }
  },

  async fetchChapters(manga_id: string): Promise<Chapters[]> {
    return parseChapters(load(await fetchHtml(`/manga/${manga_id}/all-chapters/`)));
  },

  async fetchChapterPages(chapter_id, _manga_slug, pagination): Promise<ChapterPagesResult<Page>> {
    const chapterSlug = extractChapterSlug(chapter_id) || chapter_id.replace(/^\/+|\/+$/g, '');
    if (!chapterSlug) {
      throw new SourceError(
        'NOT_FOUND',
        `Could not resolve a chapter identifier from "${chapter_id}".`,
        SOURCE_ID,
      );
    }

    const $ = load(await fetchHtml(`/reader/en/${chapterSlug}/`));

    const imageUrls = $('img[id^="image-"]')
      .map((_, el) => $(el).attr('src') || $(el).attr('data-src') || '')
      .get()
      .map((url) => toAbsoluteUrl(url.trim(), BASE_URL))
      .filter((url) => url.startsWith('http') && !url.includes('credits-mgeko.png'));

    const uniqueImageUrls = Array.from(new Set(imageUrls));
    const total = uniqueImageUrls.length;

    if (total === 0) {
      // The page loaded but no page images matched — a reader with zero pages is not a
      // real state, so this is the site having changed its markup.
      throw new SourceError(
        'PARSE_ERROR',
        `${SOURCE_NAME} returned no readable pages for this chapter — it may have changed its layout.`,
        SOURCE_ID,
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
    return [
      {
        label: 'NSFW',
        value: 'nsfw',
        type: 'select',
        options: [
          { label: 'Show NSFW', value: 'on' },
          { label: 'Hide NSFW', value: 'off' },
        ],
      },
    ];
  },

  async fetchMangaUpdates(manga_slug: string): Promise<Chapters[]> {
    return mangageko.fetchChapters(manga_slug);
  },
};

export default mangageko;
