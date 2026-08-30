import type { ZodType } from 'zod';

import type {
  Source,
  Mangas,
  Chapters,
  MangaFilter,
  Page,
  Pagination,
  MangaDetails,
  FilterValue,
  ChapterPagesResult,
  SourceManifest,
} from '../lib/types.js';
import { HttpClient, JSON_HEADERS } from '../lib/http.js';
import { TTLCache } from '../lib/cache.js';
import { UpdateQueue } from '../lib/updateQueue.js';
import { resolvePagination } from '../lib/parse.js';
import { classifyRequestError } from '../lib/sourceError.js';
import {
  MangaDexMangaListResponseSchema,
  MangaDexMangaDetailsResponseSchema,
  MangaDexChapterListResponseSchema,
  MangaDexAtHomeResponseSchema,
  MangaDexTagListResponseSchema,
  type MangaDexRelationship,
} from './schema.js';
import { buildMangaDexFilters } from './filters.js';
import { deriveIsNSFW } from '../lib/manifest.js';
import manifest from './manifest.json';

const { source_key: SOURCE_ID, name: SOURCE_NAME, lang: SOURCE_LANG } = manifest as SourceManifest;

const CDN_URL = 'https://uploads.mangadex.org';
const RATE_LIMIT_MS = 250; // MangaDex asks for at most 5 req/s; this stays under 4.
const CACHE_TTL_MS = 5 * 60 * 1000;
const CHAPTER_PAGE_SIZE = 100; // MangaDex's own maximum for /chapter.

const http = new HttpClient({
  sourceId: SOURCE_ID,
  sourceName: SOURCE_NAME,
  baseUrl: manifest.base_url,
  headers: JSON_HEADERS,
  rateLimitMs: RATE_LIMIT_MS,
});

const cache = new TTLCache<string, unknown>(CACHE_TTL_MS, 200);
const updateQueue = new UpdateQueue(RATE_LIMIT_MS);

function normalizeForCache(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForCache(item));
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return Object.fromEntries(entries.map(([key, item]) => [key, normalizeForCache(item)]));
  }
  return value;
}

/** MangaDex's query syntax is not what `URLSearchParams` produces on its own: arrays need
 * an `includes[]=` suffix and objects an `order[field]=` bracket. */
function serializeParams(params: Record<string, unknown>): string {
  const searchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => searchParams.append(`${key}[]`, String(item)));
    } else if (typeof value === 'object') {
      for (const [subKey, subValue] of Object.entries(value)) {
        searchParams.append(`${key}[${subKey}]`, String(subValue));
      }
    } else {
      searchParams.append(key, String(value));
    }
  }

  return searchParams.toString();
}

/** Fetches `endpoint` and validates the response against `schema` — a shape mismatch (the
 * API changed) throws a clear error instead of a wrong assumption propagating deep into
 * the caller. */
async function request<T>(
  endpoint: string,
  schema: ZodType<T>,
  params?: Record<string, unknown>,
): Promise<T> {
  const cacheKey = `${endpoint}::${JSON.stringify(normalizeForCache(params || {}))}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) {
    return cached as T;
  }

  const json = await http.getJson(endpoint, { params, paramsSerializer: serializeParams });
  const parsed = schema.parse(json);
  cache.set(cacheKey, parsed);
  return parsed;
}

function getTitle(titles: Record<string, string>): string {
  return titles.en || titles['ja-ro'] || Object.values(titles)[0] || 'Unknown';
}

function findRelationship(
  relationships: MangaDexRelationship[],
  type: string,
): MangaDexRelationship | undefined {
  return relationships.find((r) => r.type === type);
}

function coverUrl(mangaId: string, relationships: MangaDexRelationship[]): string {
  const fileName = (findRelationship(relationships, 'cover_art')?.attributes?.fileName ??
    '') as string;
  return fileName ? `${CDN_URL}/covers/${mangaId}/${fileName}.256.jpg` : '';
}

function toManga(data: {
  id: string;
  attributes: { title: Record<string, string> };
  relationships: MangaDexRelationship[];
}): Mangas {
  return {
    id: data.id,
    title: getTitle(data.attributes.title),
    slug: data.id,
    source: SOURCE_ID,
    thumbnail_url: coverUrl(data.id, data.relationships),
  };
}

function mergeTagFilters(
  filters: Record<string, FilterValue>,
  tagKeys: string[],
): { includedTags: string[]; excludedTags: string[] } {
  const included: string[] = [];
  const excluded: string[] = [];

  for (const key of tagKeys) {
    const filter = filters[key];
    if (filter && typeof filter === 'object' && !Array.isArray(filter)) {
      const tagFilter = filter as { include?: string[]; exclude?: string[] };
      if (tagFilter.include) {
        included.push(...tagFilter.include);
      }
      if (tagFilter.exclude) {
        excluded.push(...tagFilter.exclude);
      }
    }
  }

  return { includedTags: included, excludedTags: excluded };
}

/** The query parameters `fetchManga` and `searchManga` build identically. */
function buildListParams(
  pagination: Pagination | undefined,
  filters: Record<string, FilterValue>,
): Record<string, unknown> {
  const { limit, offset } = resolvePagination(pagination, { limit: 20 });

  const params: Record<string, unknown> = {
    limit,
    offset,
    includes: ['cover_art'],
    contentRating: Array.isArray(filters.contentRating)
      ? filters.contentRating
      : ['safe', 'suggestive', 'erotica'],
  };

  if (filters.status) {
    params.status = Array.isArray(filters.status) ? filters.status : [filters.status];
  }
  if (filters.includedTags) {
    params.includedTagsMode = filters.includedTags;
  }
  if (filters.excludedTags) {
    params.excludedTagsMode = filters.excludedTags;
  }
  if (filters.demographic) {
    params.publicationDemographic = filters.demographic;
  }
  if (filters.sortBy) {
    const [field, direction] = (filters.sortBy as string).split('.');
    params.order = { [field]: direction };
  }
  if (filters.publicationYear) {
    params.year = Number.parseInt(filters.publicationYear as string, 10);
  }

  const { includedTags, excludedTags } = mergeTagFilters(filters, [
    'genre',
    'format',
    'theme',
    'content',
  ]);
  if (includedTags.length > 0) {
    params.includedTags = includedTags;
  }
  if (excludedTags.length > 0) {
    params.excludedTags = excludedTags;
  }

  return params;
}

const mangadex: Source = {
  id: SOURCE_ID,
  name: SOURCE_NAME,
  lang: SOURCE_LANG,
  base_url: manifest.base_url,
  isNSFW: deriveIsNSFW(manifest.content_rating),

  async fetchManga(category, pagination, filters): Promise<Mangas[]> {
    try {
      const params = buildListParams(pagination, filters || {});

      if (category === 'latest') {
        params.order = { latestUploadedChapter: 'desc' };
      }
      if (category === 'popular') {
        params.order = { followedCount: 'desc' };
      }
      // A `sortBy` filter is the user's explicit choice, so it wins over the category's
      // implied ordering.
      if (filters?.sortBy) {
        const [field, direction] = (filters.sortBy as string).split('.');
        params.order = { [field]: direction };
      }

      const response = await request('/manga', MangaDexMangaListResponseSchema, params);
      return response.data.map(toManga);
    } catch (error) {
      throw classifyRequestError(error, SOURCE_ID, SOURCE_NAME);
    }
  },

  async searchManga(query, pagination, filters): Promise<Mangas[]> {
    try {
      const params = buildListParams(pagination, filters || {});
      params.title = query || '';

      const response = await request('/manga', MangaDexMangaListResponseSchema, params);
      return response.data.map(toManga);
    } catch (error) {
      throw classifyRequestError(error, SOURCE_ID, SOURCE_NAME);
    }
  },

  async fetchMangaDetails(manga_id): Promise<MangaDetails> {
    try {
      const response = await request(`/manga/${manga_id}`, MangaDexMangaDetailsResponseSchema, {
        includes: ['cover_art', 'author', 'artist'],
      });

      const manga = response.data;

      const authors = manga.relationships
        .filter((r) => r.type === 'author')
        .map((r) => (r.attributes?.name as string | undefined) || 'Unknown');

      const artists = manga.relationships
        .filter((r) => r.type === 'artist')
        .map((r) => (r.attributes?.name as string | undefined) || 'Unknown');

      const description =
        manga.attributes.description?.en ||
        Object.values(manga.attributes.description || {})[0] ||
        'No description available';

      const genres = manga.attributes.tags
        .filter((t) => t.attributes.group === 'genre')
        .map((t) => getTitle(t.attributes.name));

      return {
        id: manga.id,
        // The source *id*, not the display name — everything downstream keys off the id.
        source: SOURCE_ID,
        title: getTitle(manga.attributes.title),
        slug: manga.id,
        author: authors.length > 0 ? authors : ['Unknown'],
        artist: artists.length > 0 ? artists : ['Unknown'],
        thumbnail_url: coverUrl(manga.id, manga.relationships),
        description,
        genres,
        status: manga.attributes.status || 'unknown',
        chapters: await this.fetchChapters(manga_id),
      };
    } catch (error) {
      throw classifyRequestError(error, SOURCE_ID, SOURCE_NAME);
    }
  },

  async fetchMangaThumbnail(manga_id: string): Promise<string> {
    // Decorative — degrade gracefully rather than failing a whole detail view over a
    // missing cover.
    try {
      const response = await request(`/manga/${manga_id}`, MangaDexMangaDetailsResponseSchema, {
        includes: ['cover_art'],
      });
      return coverUrl(response.data.id, response.data.relationships);
    } catch {
      return '';
    }
  },

  async fetchChapters(manga_id): Promise<Chapters[]> {
    try {
      const allChapters: Chapters[] = [];
      let offset = 0;

      for (;;) {
        const response = await request('/chapter', MangaDexChapterListResponseSchema, {
          manga: manga_id,
          translatedLanguage: ['en'],
          order: { volume: 'asc', chapter: 'asc' },
          offset,
          limit: CHAPTER_PAGE_SIZE,
          includes: ['scanlation_group', 'user'],
          includeExternalUrl: 0,
        });

        allChapters.push(
          ...response.data.map((chapter): Chapters => {
            const scanlationGroup = findRelationship(chapter.relationships, 'scanlation_group');
            const uploader = findRelationship(chapter.relationships, 'user');

            return {
              id: chapter.id,
              chapter_number: Number.parseFloat(chapter.attributes.chapter || '0'),
              url: `https://mangadex.org/chapter/${chapter.id}`,
              scanlator:
                (scanlationGroup?.attributes?.name as string | undefined) ||
                (uploader?.attributes?.username as string | undefined) ||
                'Unknown',
              name: chapter.attributes.title || '',
              language: chapter.attributes.translatedLanguage,
              page_count: chapter.attributes.pages || 0,
              last_page_read: 0,
              release_date: chapter.attributes.publishAt || '',
              pages: [],
            };
          }),
        );

        if (
          response.data.length < CHAPTER_PAGE_SIZE ||
          offset + CHAPTER_PAGE_SIZE >= response.total
        ) {
          break;
        }
        offset += CHAPTER_PAGE_SIZE;
      }

      return allChapters;
    } catch (error) {
      throw classifyRequestError(error, SOURCE_ID, SOURCE_NAME);
    }
  },

  async fetchChapterPages(chapter_id, _manga_slug, pagination): Promise<ChapterPagesResult<Page>> {
    try {
      const response = await request(
        `/at-home/server/${chapter_id}`,
        MangaDexAtHomeResponseSchema,
      );

      const pageFiles = response.chapter.data;
      const total = pageFiles.length;

      const { limit, offset } = resolvePagination(pagination, { limit: 4 });
      const start = Math.min(offset, total);
      const end = Math.min(start + Math.max(1, limit), total);

      const pages: Page[] = [];
      for (let i = start; i < end; i++) {
        pages.push({
          index: i + 1,
          image_url: `${response.baseUrl}/data/${response.chapter.hash}/${pageFiles[i]}`,
        });
      }

      return { items: pages, total };
    } catch (error) {
      throw classifyRequestError(error, SOURCE_ID, SOURCE_NAME);
    }
  },

  async getFilters(): Promise<MangaFilter[]> {
    // A filter list the reader can't build is a degraded UI, not a failed request —
    // returning [] leaves browsing usable.
    try {
      const response = await request('/manga/tag', MangaDexTagListResponseSchema);
      return buildMangaDexFilters(response.data);
    } catch {
      return [];
    }
  },

  async fetchMangaUpdates(manga_slug: string): Promise<Chapters[]> {
    if (updateQueue.isQueued(manga_slug)) {
      return [];
    }
    return updateQueue.add(manga_slug, () => this.fetchChapters(manga_slug), []);
  },
};

export default mangadex;
