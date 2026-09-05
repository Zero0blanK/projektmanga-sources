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
  TriStateFilterValue,
  Option,
  ChapterPagesResult,
  SourceManifest,
} from '../lib/types.js';
import { HttpClient, JSON_HEADERS, NAV_HEADERS } from '../lib/http.js';
import { TTLCache } from '../lib/cache.js';
import { fetchJsonHtmlBrowse } from '../lib/jsonHtmlBrowse.js';
import {
  mapMangaStatus,
  normalizeText,
  parseDateToIso,
  resolvePagination,
  toAbsoluteUrl,
} from '../lib/parse.js';
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

/**
 * The site's own browse filters, taken from the controls on /browse-comics/.
 *
 * Values are the ones the endpoint accepts, not the labels — each was checked against
 * /browse-comics/data/ and moves `total_results`, so none of them is decorative.
 *
 * No "Any" entry anywhere: the app's filter panel prepends its own empty option to every
 * `select`, so including the site's would render two.
 */
const SORT_OPTIONS: Option[] = [
  { label: 'Latest update', value: 'latest' },
  { label: 'Recently added', value: 'recently_added' },
  { label: 'Popular daily', value: 'popular_daily' },
  { label: 'Popular weekly', value: 'popular_weekly' },
  { label: 'Popular monthly', value: 'popular_monthly' },
  { label: 'Popular all time', value: 'popular_all_time' },
  { label: 'Top rated', value: 'rating' },
  { label: 'Title A–Z', value: 'az' },
  { label: 'Title Z–A', value: 'za' },
];

const STATUS_OPTIONS: Option[] = [
  { label: 'Ongoing', value: 'ongoing' },
  { label: 'Completed', value: 'completed' },
  { label: 'Hiatus', value: 'hiatus' },
];

const TYPE_OPTIONS: Option[] = [
  { label: 'Manga', value: 'manga' },
  { label: 'Manhwa', value: 'manhwa' },
  { label: 'Manhua', value: 'manhua' },
  { label: 'Webtoon', value: 'webtoon' },
];

/** The genre chips the browse page offers for both include and exclude. Sent
 * comma-separated; the site treats multiple includes as "matches at least one". */
const GENRE_OPTIONS: Option[] = [
  'Action',
  'Adventure',
  'Comedy',
  'Cooking',
  'Drama',
  'Fantasy',
  'Gender bender',
  'Harem',
  'Historical',
  'Horror',
  'Isekai',
  'Josei',
  'Manhua',
  'Manhwa',
  'Martial arts',
  'Mature',
  'Mecha',
  'Medical',
  'Mystery',
  'One shot',
  'Psychological',
  'Romance',
  'School life',
  'Sci fi',
  'Seinen',
  'Shoujo',
  'Shounen',
  'Slice of life',
  'Sports',
  'Supernatural',
  'Tragedy',
  'Webtoons',
].map((name) => ({ label: name, value: name }));

/**
 * The site's own switch is "Hide NSFW" and is on by default, so `safe_mode=1` *hides*
 * adult titles and 0 shows them — confirmed against the endpoint, where dropping safe_mode
 * to 0 returns more results than the default. Offering the toggle the other way round
 * (as "Show NSFW") keeps every entry here additive: ticking one only ever widens or
 * narrows in the direction its label says.
 */
const OPTION_FLAGS: Option[] = [
  { label: 'Show NSFW', value: 'show_nsfw' },
  { label: 'Only completed series', value: 'only_completed' },
  { label: 'At least 50+ chapters translated', value: 'only_translated' },
  { label: 'Hide long hiatus (> 6 months)', value: 'hide_on_break' },
];

function asString(value: FilterValue | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asStringArray(value: FilterValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function asTriState(value: FilterValue | undefined): TriStateFilterValue {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as TriStateFilterValue)
    : {};
}

/**
 * A whole non-negative number typed into a text box, or undefined.
 *
 * The site drives its chapter-count bounds with sliders, so the values are always clean
 * integers there. Here they are whatever someone typed — "abc", "12.5", "-3", an empty
 * box — and an unparseable one has to be dropped rather than sent, since the endpoint
 * treats a junk bound as no bound and would silently return an unfiltered list that looks
 * like the filter was applied.
 */
function asCount(value: FilterValue | undefined): number | undefined {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * A star rating typed as 0–5, converted to the tenths the endpoint actually wants.
 *
 * The site's slider is `min="0" max="50" step="1"` — its wire value is the rating times
 * ten, so `min_rating=40` means four stars and `min_rating=4` means *0.4*. Confirmed
 * against the endpoint, where the totals fall monotonically as 4 → 40 → 45 → 50 returns
 * 3926 → 1863 → 926 → 505. Asking readers for that internal scale would guarantee the
 * mistake: typing the "4" they see on a card would quietly widen the filter to almost
 * everything instead of narrowing it, and nothing about the results would look wrong.
 *
 * So the filter takes stars, and this does the conversion. Anything outside 0–5 is dropped
 * rather than clamped — a 45 typed by someone who guessed the internal scale is more
 * likely a misunderstanding than a request for "at least 45 stars", and silently treating
 * it as 4.5 would be inventing intent.
 */
function asRating(value: FilterValue | undefined): number | undefined {
  const raw = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '';
  const trimmed = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    return undefined;
  }
  const stars = Number(trimmed);
  if (!Number.isFinite(stars) || stars < 0 || stars > 5) {
    return undefined;
  }
  return Math.round(stars * 10);
}

/**
 * Translates the app's filter values into the query the browse endpoint expects.
 *
 * `category` only supplies the *default* sort — an explicit sort filter wins, otherwise
 * asking for "popular" and then picking "Title A–Z" would silently keep sorting by
 * popularity.
 */
function buildBrowseParams(
  category: string | undefined,
  filters: Record<string, FilterValue> | undefined,
  page: number,
): Record<string, string | number> {
  const active = filters ?? {};
  const flags = asStringArray(active.options);
  const genres = asTriState(active.genres);

  const params: Record<string, string | number> = {
    page,
    sort: asString(active.sort) ?? (category === 'popular' ? 'popular_all_time' : 'latest'),
    safe_mode: flags.includes('show_nsfw') ? 0 : 1,
  };

  const status = asString(active.status);
  if (status) params.status = status;

  const type = asString(active.type);
  if (type) params.type = type;

  const include = (genres.include ?? []).join(',');
  if (include) params.include_genres = include;

  const exclude = (genres.exclude ?? []).join(',');
  if (exclude) params.exclude_genres = exclude;

  // The site uses sliders for these; here they are plain number boxes, which is the only
  // sensible mapping — the app's filter panel has no range control, so a slider-shaped
  // filter would render as a text box anyway, just without saying so in its label.
  const minChapters = asCount(active.min_chapters);
  if (minChapters !== undefined) params.min_chapters = minChapters;

  const maxChapters = asCount(active.max_chapters);
  if (maxChapters !== undefined) params.max_chapters = maxChapters;

  // Sent in tenths — see asRating.
  const minRating = asRating(active.min_rating);
  if (minRating !== undefined) params.min_rating = minRating;

  for (const flag of ['only_completed', 'only_translated', 'hide_on_break'] as const) {
    if (flags.includes(flag)) params[flag] = 1;
  }

  return params;
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

      const chapterNumber =
        node
          .find('.chapter-title')
          .first()
          .text()
          .match(/[\d.]+/)?.[0] || '';

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
      const active = filters as Record<string, FilterValue> | undefined;

      return await fetchJsonHtmlBrowse<Mangas>(
        {
          cacheKeyPrefix: SOURCE_ID,
          http: jsonHttp,
          endpoint: '/browse-comics/data/',
          itemSelector: 'article.comic-card',
          sitePageSize: 24,
          maxPrefetchPages: 2,
          cacheTtlMs: CACHE_TTL_MS,
          buildParams: (page) => buildBrowseParams(category, active, page),
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
      const active = filters as Record<string, FilterValue> | undefined;

      return await fetchJsonHtmlBrowse<Mangas>(
        {
          cacheKeyPrefix: `${SOURCE_ID}:search`,
          http: jsonHttp,
          endpoint: '/browse-comics/data/',
          itemSelector: 'article.comic-card',
          sitePageSize: 24,
          maxPrefetchPages: 2,
          cacheTtlMs: CACHE_TTL_MS,
          // Search is the same endpoint with `q` added, so every browse filter narrows a
          // search too rather than being silently dropped the moment someone types.
          buildParams: (page) => ({
            ...buildBrowseParams(undefined, active, page),
            q: query || '',
          }),
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
      { label: 'Sort by', value: 'sort', type: 'select', options: SORT_OPTIONS },
      { label: 'Status', value: 'status', type: 'select', options: STATUS_OPTIONS },
      { label: 'Type', value: 'type', type: 'select', options: TYPE_OPTIONS },
      { label: 'Genres', value: 'genres', type: 'tri-state', options: GENRE_OPTIONS },
      { label: 'Minimum chapters', value: 'min_chapters', type: 'input' },
      { label: 'Maximum chapters', value: 'max_chapters', type: 'input' },
      // Labelled with the scale, because the number on a card ("⭐ 4.5") is the one people
      // will type and it is not the one the endpoint takes.
      { label: 'Minimum rating (0–5, e.g. 4.5)', value: 'min_rating', type: 'input' },
      { label: 'Options', value: 'options', type: 'multi', options: OPTION_FLAGS },
    ];
  },

  async fetchMangaUpdates(manga_slug: string): Promise<Chapters[]> {
    return mangageko.fetchChapters(manga_slug);
  },
};

export default mangageko;
