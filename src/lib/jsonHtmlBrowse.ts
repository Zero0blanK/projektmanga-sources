import { load } from 'cheerio/slim';
import type { CheerioAPI, Cheerio } from 'cheerio/slim';
import type { AnyNode } from 'domhandler';

import { HttpClient } from './http.js';
import { TTLCache } from './cache.js';

/**
 * Some sites serve their browse grid as JSON with an HTML fragment inside it, rather than
 * as a full page. This fetches those pages, parses the fragment, and maps the site's
 * fixed page size onto the app's `{ limit, offset }` window — the same job
 * `apps/extensions/utils/jsonHtmlBrowse.ts` does.
 */
export interface JsonHtmlBrowseResponse {
  results_html: string;
  pagination_html?: string;
  total_results?: number;
  page: number;
  num_pages: number;
}

export interface FetchJsonHtmlBrowseConfig<T> {
  cacheKeyPrefix: string;
  http: HttpClient;
  endpoint: string;
  itemSelector: string;
  sitePageSize: number;
  buildParams: (page: number) => Record<string, string | number | boolean>;
  mapItem: (node: Cheerio<AnyNode>, $: CheerioAPI) => T | null;
  cacheTtlMs?: number;
  /** How many pages may be fetched concurrently once the first page is in. */
  maxPrefetchPages?: number;
}

export interface FetchJsonHtmlBrowseOptions {
  limit: number;
  offset: number;
}

const browseCache = new TTLCache<string, JsonHtmlBrowseResponse>(2 * 60 * 1000, 120);

function buildCacheKey(
  prefix: string,
  endpoint: string,
  params: Record<string, string | number | boolean>,
): string {
  const normalized = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('&');

  return `${prefix}:${endpoint}?${normalized}`;
}

async function fetchPage<T>(
  page: number,
  config: FetchJsonHtmlBrowseConfig<T>,
): Promise<{ items: T[]; numPages: number }> {
  const params = config.buildParams(page);
  const cacheKey = buildCacheKey(config.cacheKeyPrefix, config.endpoint, params);

  const payload = await browseCache.getOrSet(
    cacheKey,
    () => config.http.getJson<JsonHtmlBrowseResponse>(config.endpoint, { params }),
    config.cacheTtlMs,
  );

  const $ = load(payload.results_html || '');
  const items: T[] = [];

  $(config.itemSelector).each((_, el) => {
    const item = config.mapItem($(el), $);
    if (item) {
      items.push(item);
    }
  });

  const numPages =
    Number.isFinite(payload.num_pages) && payload.num_pages > 0 ? payload.num_pages : page;

  return { items, numPages };
}

export async function fetchJsonHtmlBrowse<T>(
  config: FetchJsonHtmlBrowseConfig<T>,
  options: FetchJsonHtmlBrowseOptions,
): Promise<T[]> {
  const limit = Math.max(0, options.limit);
  if (limit === 0) {
    return [];
  }

  const offset = Math.max(0, options.offset);
  const sitePageSize = Math.max(1, config.sitePageSize);
  const maxPrefetchPages = Math.max(1, config.maxPrefetchPages ?? 2);

  const startPage = Math.floor(offset / sitePageSize) + 1;
  const collected: T[] = [];

  const first = await fetchPage(startPage, config);
  collected.push(...first.items.slice(offset % sitePageSize, (offset % sitePageSize) + limit));

  let nextPage = startPage + 1;
  let maxPages = first.numPages;

  while (collected.length < limit && nextPage <= maxPages) {
    const remaining = limit - collected.length;
    const pagesNeeded = Math.ceil(remaining / sitePageSize);
    const batchSize = Math.min(maxPrefetchPages, pagesNeeded, maxPages - nextPage + 1);

    const results = await Promise.all(
      Array.from({ length: batchSize }, (_, i) => fetchPage(nextPage + i, config)),
    );

    for (const result of results) {
      maxPages = Math.max(maxPages, result.numPages);

      const stillNeeded = limit - collected.length;
      if (stillNeeded <= 0) {
        break;
      }
      if (result.items.length === 0) {
        return collected;
      }

      collected.push(...result.items.slice(0, stillNeeded));
    }

    nextPage += batchSize;
  }

  return collected;
}
