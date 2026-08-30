/**
 * Turning a site's fixed page size into the app's arbitrary `{ limit, offset }` window.
 *
 * Every HTML source in this repository has the same problem: the reader asks for
 * "20 items starting at 45" and the site only knows how to serve "page 3". This walks
 * pages from the one containing `offset` until `limit` items are collected.
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
  if (limit === 0) {
    return [];
  }

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
      // The first page must succeed — that is a real failure the caller needs to see.
      // Beyond it, a failing "next page" (a 404 past the last real page, typically) is
      // just the normal end of pagination.
      if (collected.length === 0 && page === startPage) {
        throw error;
      }
      break;
    }

    if (items.length === 0) {
      break;
    }

    const remaining = limit - collected.length;
    collected.push(...items.slice(skipInPage, skipInPage + remaining));

    if (items.length <= skipInPage) {
      break;
    }

    skipInPage = 0;
    page++;
  }

  return collected;
}
