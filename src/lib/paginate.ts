import { SourceError } from './sourceError.js';

/**
 * Turning a site's fixed page size into the app's arbitrary `{ limit, offset }` window.
 * Pages are fetched sequentially because the source's response size and rate policy may be
 * small; only an explicit not-found response on a later page is treated as end-of-list.
 */
export interface PagedWindow {
  limit: number;
  offset: number;
  sitePageSize: number;
}

export interface PageFetcher<T> {
  /** Fetches one 1-based site page. Resolve with an empty array to signal "no more". */
  (page: number): Promise<T[]>;
}

export async function collectPaged<T>(window: PagedWindow, fetchPage: PageFetcher<T>): Promise<T[]> {
  const limit = Math.max(0, window.limit);
  if (limit === 0) return [];

  const offset = Math.max(0, window.offset);
  const sitePageSize = Math.max(1, window.sitePageSize);
  const startPage = Math.floor(offset / sitePageSize) + 1;
  let page = startPage;
  let skipInPage = offset % sitePageSize;
  const collected: T[] = [];

  while (collected.length < limit) {
    let items: T[];
    try {
      items = await fetchPage(page);
    } catch (error) {
      if (error instanceof SourceError && error.code === 'NOT_FOUND' && page > startPage) break;
      throw error;
    }

    if (items.length === 0) break;
    const remaining = limit - collected.length;
    collected.push(...items.slice(skipInPage, skipInPage + remaining));
    if (items.length <= skipInPage) break;
    skipInPage = 0;
    page++;
  }
  return collected;
}
