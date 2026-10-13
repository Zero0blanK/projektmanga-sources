import { SourceError } from "./sourceError.js";

/** Some upstream catalogues expose numbered pages without a documented fixed page size. */
export async function collectSequentialPages<T extends { id: string }>(
  window: { limit: number; offset: number },
  sourceId: string,
  fetchPage: (page: number) => Promise<T[]>,
): Promise<T[]> {
  const limit = Math.max(0, Math.floor(window.limit)),
    offset = Math.max(0, Math.floor(window.offset));
  if (limit === 0) return [];
  const items: T[] = [],
    seen = new Set<string>();
  let skipped = 0;
  for (let page = 1; page <= 50; page++) {
    let rows: T[];
    try {
      rows = await fetchPage(page);
    } catch (error) {
      if (
        page > 1 &&
        error instanceof SourceError &&
        error.code === "NOT_FOUND"
      )
        return items;
      throw error;
    }
    let added = 0;
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      added++;
      if (skipped < offset) {
        skipped++;
        continue;
      }
      items.push(row);
      if (items.length === limit) return items;
    }
    if (added === 0) return items;
  }
  throw new SourceError(
    "PARSE_ERROR",
    "The pagination window exceeds 50 upstream pages",
    sourceId,
  );
}
