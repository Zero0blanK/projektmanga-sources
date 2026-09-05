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
  FilterValue,
  Option,
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
  // `.bs` rather than `#content .bs`: the site injects PHP warnings into the markup on some
  // filtered pages, which breaks the nesting and leaves the result cards *outside*
  // `#content` — the scoped selector then matched nothing and the page read as empty. On a
  // well-formed page the two are identical (30 and 30), so nothing is lost by not scoping.
  return $('.bs')
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

/**
 * What /manga-list actually honours — which is far less than its filter form offers.
 *
 * The page renders dropdowns for genre, status and type, and the site accepts all of them
 * without complaint, but only the ordering changes the result set. Checked by comparing the
 * returned ids against an unfiltered request:
 *
 *   - `order`   — works (each value returns a different set).
 *   - `status`  — ignored; `status=completed` returns the unfiltered list.
 *   - `type`    — ignored; `type=manhwa` returns the unfiltered list.
 *   - `genre[]` — broken server-side. The response carries a PHP warning
 *     ("in_array() expects parameter 2 to be array, null given ... views/filter2.php") and
 *     falls back to the unfiltered list: Romance, Yaoi and Sports each returned exactly the
 *     same 30 titles as no filter at all.
 *
 * So only ordering is offered. A dropdown that silently does nothing is worse than an
 * absent one — the reader cannot tell the difference between "no matches" and "ignored",
 * and would reasonably conclude the app is broken. If the site fixes filter2.php, the
 * genre/status/type options can be added back here and in `buildListPath`.
 */
const ORDER_OPTIONS: Option[] = [
  { label: 'A–Z', value: 'title' },
  { label: 'Z–A', value: 'titlereverse' },
  { label: 'Recently updated', value: 'update' },
  { label: 'Recently added', value: 'latest' },
  { label: 'Popular', value: 'popular' },
];

/** `category` supplies the default ordering; an explicit `order` filter overrides it. */
function buildListPath(
  category: string | undefined,
  filters: Record<string, FilterValue> | undefined,
  page: number,
): string {
  const chosen = filters?.order;
  const order =
    typeof chosen === 'string' && chosen.length > 0
      ? chosen
      : category === 'popular'
        ? 'popular'
        : '';
  return `/manga-list?page=${page}${order ? `&order=${encodeURIComponent(order)}` : ''}`;
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

  async fetchManga(category, pagination, filters): Promise<Mangas[]> {
    return browse(
      (page) => buildListPath(category, filters as Record<string, FilterValue> | undefined, page),
      pagination,
    );
  },

  async searchManga(query, pagination): Promise<Mangas[]> {
    if (!query) {
      return [];
    }
    // Search is WordPress's own `?s=`, which takes none of the list page's parameters —
    // ordering included. Passing them would look like they applied when they did not.
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
    // Only what the site honours — see ORDER_OPTIONS for what was tested and dropped.
    return [{ label: 'Order by', value: 'order', type: 'select', options: ORDER_OPTIONS }];
  },

  async fetchMangaUpdates(manga_slug: string): Promise<Chapters[]> {
    return mangatx.fetchChapters(manga_slug);
  },
};

export default mangatx;
