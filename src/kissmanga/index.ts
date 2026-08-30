import type { FilterValue, MangaFilter, Source, SourceManifest } from '../lib/types.js';
import { HttpClient } from '../lib/http.js';
import { createMadaraSource } from '../lib/madara.js';
import { deriveIsNSFW } from '../lib/manifest.js';
import manifest from './manifest.json';

const { source_key: SOURCE_ID, name: SOURCE_NAME, lang: SOURCE_LANG } = manifest as SourceManifest;

const http = new HttpClient({
  sourceId: SOURCE_ID,
  sourceName: SOURCE_NAME,
  baseUrl: manifest.base_url,
  rateLimitMs: 300,
});

function buildFilterQuery(filters: Record<string, FilterValue>): string {
  const queryParams: string[] = [];

  for (const [key, filter] of Object.entries(filters)) {
    if (!filter) {
      continue;
    }
    if (Array.isArray(filter)) {
      filter.forEach((item) => {
        queryParams.push(`${encodeURIComponent(key)}[]=${encodeURIComponent(String(item))}`);
      });
      continue;
    }
    queryParams.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(filter))}`);
  }

  return queryParams.join('&');
}

/**
 * Kissmanga runs the Madara WordPress theme, so the shared factory does the work; only
 * the URL shapes and a few selectors are site-specific. Titles live under /kissmanga/
 * rather than Madara's usual /manga/.
 */
const kissmanga: Source = createMadaraSource({
  id: SOURCE_ID,
  name: SOURCE_NAME,
  lang: SOURCE_LANG,
  baseUrl: manifest.base_url,
  isNSFW: deriveIsNSFW(manifest.content_rating),
  http,
  runtime: {
    sitePageSize: 24,
    cacheTtlMs: 2 * 60 * 1000,
  },
  selectors: {
    browseCard: '.page-content-listing .page-item-listing',
    browseTitle: '.item-summary h3 a',
    browseImage: 'img',
    detailsTitle: '.post-title h1, h1',
    detailsThumbnail: '.summary_image img',
    detailsAuthor: '.author-content a, .author-content',
    detailsGenres: '.genres-content a',
    detailsDescription: '.description-summary, .summary__content',
    detailsStatus:
      '.post-status .summary-content, .post-content_item:contains("Status") .summary-content',
    chapterItem: 'li.wp-manga-chapter, .listing-chapters_wrap li',
    chapterLink: 'a',
    chapterName: 'a',
    chapterDate: 'time, .chapter-release-date',
    pageImage: '.reading-content img',
  },
  buildBrowsePath: (category, page, filters) => {
    const listType =
      category && ['latest', 'popular', 'newest', 'trending'].includes(category)
        ? category
        : 'latest';
    const filterQuery = buildFilterQuery(filters);

    if (filterQuery.length > 0) {
      return `/page/${page}/?s=&post_type=wp-manga&${filterQuery}`;
    }
    return `/mangalist/page/${page}/?m_orderby=${listType}`;
  },
  buildSearchPath: (query, page, filters) => {
    const filterQuery = buildFilterQuery(filters);
    const suffix = filterQuery ? `&${filterQuery}` : '';
    return `/page/${page}/?s=${encodeURIComponent(query || '')}&post_type=wp-manga${suffix}`;
  },
  buildMangaPath: (mangaId) => `/kissmanga/${mangaId}/`,
  buildChapterPath: (chapterKey, mangaSlug) =>
    mangaSlug ? `/kissmanga/${mangaSlug}/${chapterKey}/` : `/${chapterKey}/`,
  getFilters: async (): Promise<MangaFilter[]> => [],
});

export default kissmanga;
