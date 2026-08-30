import { load } from 'cheerio/slim';
import type { CheerioAPI } from 'cheerio/slim';

import type {
  Source,
  Mangas,
  Chapters,
  MangaFilter,
  Page,
  MangaDetails,
  Pagination,
  ChapterPagesResult,
  SourceManifest,
} from '../lib/types.js';
import { HttpClient } from '../lib/http.js';
import { TTLCache } from '../lib/cache.js';
import { collectPaged } from '../lib/paginate.js';
import { MANGA_STATUS, normalizeText, resolvePagination, toAbsoluteUrl } from '../lib/parse.js';
import { SourceError, classifyRequestError } from '../lib/sourceError.js';
import { deriveIsNSFW } from '../lib/manifest.js';
import manifest from './manifest.json';

const { source_key: SOURCE_ID, name: SOURCE_NAME, lang: SOURCE_LANG } = manifest as SourceManifest;
const BASE_URL = manifest.base_url;
const SITE_PAGE_SIZE = 30;
const CACHE_TTL_MS = 2 * 60 * 1000;

const http = new HttpClient({
  sourceId: SOURCE_ID,
  sourceName: SOURCE_NAME,
  baseUrl: BASE_URL,
  rateLimitMs: 240,
});

// Details, chapters and thumbnail are three calls against the same page.
const htmlCache = new TTLCache<string, string>(CACHE_TTL_MS, 60);

async function fetchHtml(path: string): Promise<string> {
  try {
    return await htmlCache.getOrSet(path, () => http.getText(path));
  } catch (error) {
    throw classifyRequestError(error, SOURCE_ID, SOURCE_NAME, path);
  }
}

/** The browse grid and the search results use the same card markup. */
function parseCards($: CheerioAPI): Mangas[] {
  return $('#content .bs')
    .map((_, el) => {
      const link = $(el).find('a').first();
      const href = link.attr('href') || '';
      const id = href.match(/(?<=\/manga\/)[^/]+/)?.[0] || '';
      if (!id) {
        return null;
      }

      const image = link.find('img').first();

      return {
        source: SOURCE_ID,
        id,
        slug: id,
        title: normalizeText(link.attr('title') || link.find('.tt').text()) || 'No Title',
        thumbnail_url: toAbsoluteUrl(
          (image.attr('src') || image.attr('data-src') || '').trim(),
          BASE_URL,
        ),
      } as Mangas;
    })
    .get()
    .filter((item): item is Mangas => item !== null);
}

function parseChapters($: CheerioAPI): Chapters[] {
  return $('#chapterlist li')
    .map((_, el) => {
      const link = $(el).find('div.eph-num a').first();
      const href = link.attr('href') || '';
      if (!href) {
        return null;
      }

      const chapterNumber = Number.parseFloat(
        link.find('span.chapternum').text().match(/[\d.]+/)?.[0] || '0',
      );

      // The site's chapter URLs end in "<manga-slug>/<chapter-slug>"; that pair is the
      // chapter's identity, flattened with a dash so it survives being used as a path
      // segment. fetchChapterPages puts the slash back.
      const chapterId = href.match(/([^/]+\/[^/]+)$/)?.[0].replace('/', '-') || '';
      if (!chapterId) {
        return null;
      }

      // Dates render as DD-MM-YYYY, which Date() would read as MM-DD-YYYY.
      const dateText = link.find('span.chapterdate').text().trim();
      const isoLike = dateText.includes('-') ? dateText.split('-').reverse().join('-') : dateText;
      const parsedDate = isoLike ? new Date(isoLike) : null;

      return {
        id: chapterId,
        chapter_number: Number.isFinite(chapterNumber) ? chapterNumber : 0,
        url: toAbsoluteUrl(href, BASE_URL),
        name: '',
        scanlator: 'Unknown',
        language: SOURCE_LANG,
        page_count: 0,
        last_page_read: 0,
        release_date: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : '',
        pages: [],
      } as Chapters;
    })
    .get()
    .filter((chapter): chapter is Chapters => chapter !== null);
}

async function browse(
  buildPath: (page: number) => string,
  pagination: Pagination | undefined,
): Promise<Mangas[]> {
  const { limit, offset } = resolvePagination(pagination, { limit: SITE_PAGE_SIZE });

  return collectPaged({ limit, offset, sitePageSize: SITE_PAGE_SIZE }, async (page) =>
    parseCards(load(await fetchHtml(buildPath(page)))),
  );
}

const mangatx: Source = {
  id: SOURCE_ID,
  name: SOURCE_NAME,
  lang: SOURCE_LANG,
  base_url: BASE_URL,
  isNSFW: deriveIsNSFW(manifest.content_rating),

  async fetchManga(category, pagination): Promise<Mangas[]> {
    const order = category === 'popular' ? 'popular' : '';
    return browse(
      (page) => `/manga-list?page=${page}${order ? `&order=${order}` : ''}`,
      pagination,
    );
  },

  async searchManga(query, pagination): Promise<Mangas[]> {
    if (!query) {
      return [];
    }
    return browse((page) => `/page/${page}/?s=${encodeURIComponent(query)}`, pagination);
  },

  async fetchMangaDetails(mangaId: string): Promise<MangaDetails> {
    const $ = load(await fetchHtml(`/manga/${mangaId}/`));

    const alternativeTitle = normalizeText($('span.alternative').text());
    const summary = normalizeText($('div.entry-content p').text());

    const description = [
      alternativeTitle ? `Alternative Title:\n${alternativeTitle}` : '',
      summary ? `Summary:\n${summary}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    const artist = $("div.imptdt:contains('Artist') a")
      .map((_, el) => normalizeText($(el).text()))
      .get()
      .filter(Boolean);

    const author = $("div.imptdt:contains('Author') a")
      .map((_, el) => normalizeText($(el).text()))
      .get()
      .filter(Boolean);

    // MangaTX's detail pages carry no genre list at all — verified against a live page,
    // not assumed. Left empty rather than guessed at from the title's tags elsewhere.
    const genres: string[] = [];

    return {
      source: SOURCE_ID,
      id: mangaId,
      slug: mangaId,
      title: normalizeText($('h1.entry-title').text()) || 'No title',
      thumbnail_url: toAbsoluteUrl(($('div.thumb img').attr('src') || '').trim(), BASE_URL),
      description,
      author,
      artist,
      genres,
      status: normalizeText($("div.imptdt:contains('Status') i").text()).toUpperCase() || MANGA_STATUS.UNKNOWN,
      chapters: parseChapters($),
    };
  },

  async fetchMangaThumbnail(mangaId: string): Promise<string> {
    // Decorative — degrade gracefully rather than failing a whole detail view over a
    // missing cover.
    try {
      const $ = load(await fetchHtml(`/manga/${mangaId}/`));
      return toAbsoluteUrl(($('div.thumb img').attr('src') || '').trim(), BASE_URL);
    } catch {
      return '';
    }
  },

  async fetchChapters(mangaId: string): Promise<Chapters[]> {
    return parseChapters(load(await fetchHtml(`/manga/${mangaId}/`)));
  },

  async fetchChapterPages(chapter_id, _manga_slug, pagination): Promise<ChapterPagesResult<Page>> {
    // Undo the dash-flattening parseChapters applied to "<manga-slug>/<chapter-slug>".
    const chapterPath = chapter_id.replace(/-(chapter-[\d.]+)$/, '/$1');
    const $ = load(await fetchHtml(`/manga/${chapterPath}/`));

    const imageUrls = $('div.chapterbody div#readerarea img')
      .map((_, el) => {
        const node = $(el);
        return (node.attr('data-src') || node.attr('src') || '').trim();
      })
      .get()
      .map((url) => toAbsoluteUrl(url, BASE_URL))
      .filter((url) => url.startsWith('http'));

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
    return [];
  },

  async fetchMangaUpdates(manga_slug: string): Promise<Chapters[]> {
    return mangatx.fetchChapters(manga_slug);
  },
};

export default mangatx;
