import { load } from "cheerio/slim";
import { createHash } from "node:crypto";
import type {
  FilterValue,
  Mangas,
  Source,
  SourceCapabilities,
  SourceCataloguePage,
  SourcePageRequest,
} from "./types.js";
import { SourceError } from "./sourceError.js";

type NativePage = { items: Mangas[]; next?: string };
export type CatalogueContext = {
  category?: string;
  query?: string;
  filters: Record<string, FilterValue>;
};

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stable(child)]),
    );
  return value;
}

/** Opaque continuation tokens carry only upstream position, never reader/account state. */
export function createNativePager(
  sourceId: string,
  initial: string,
  validate: (position: string) => boolean,
  fetchPage: (position: string) => Promise<NativePage>,
  context: CatalogueContext,
) {
  const scope = createHash("sha256")
    .update(JSON.stringify(stable({ sourceId, ...context })))
    .digest("base64url");
  const fail = (request = true): never => {
    throw new SourceError(
      "PARSE_ERROR",
      "Invalid catalogue cursor",
      sourceId,
      request ? { reason: "INVALID_CURSOR" } : undefined,
    );
  };
  return async (
    request: SourcePageRequest = {},
  ): Promise<SourceCataloguePage> => {
    const limit = request.limit ?? 30;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return fail();
    let position = initial,
      skip = 0;
    if (request.cursor !== undefined) {
      if (!/^[A-Za-z0-9_-]{1,1024}$/.test(request.cursor)) return fail();
      try {
        const decoded = JSON.parse(
          Buffer.from(request.cursor, "base64url").toString("utf8"),
        );
        if (
          decoded.v !== 1 ||
          decoded.scope !== scope ||
          typeof decoded.position !== "string" ||
          !Number.isSafeInteger(decoded.skip) ||
          decoded.skip < 0 ||
          decoded.skip > 1000
        )
          return fail();
        position = decoded.position;
        skip = decoded.skip;
      } catch {
        return fail();
      }
    }
    if (!validate(position)) return fail();
    const page = await fetchPage(position);
    const rows = [
      ...new Map(page.items.map((item) => [item.id, item])).values(),
    ];
    if (skip > rows.length) return fail(false);
    if (page.next && (!validate(page.next) || page.next === position))
      return fail(false);
    if (!rows.length) return { items: [], hasMore: false };
    const items = rows.slice(skip, skip + limit);
    const remaining = skip + items.length < rows.length;
    const next = remaining ? position : page.next;
    const nextCursor = next
      ? Buffer.from(
          JSON.stringify({
            v: 1,
            scope,
            position: next,
            skip: remaining ? skip + items.length : 0,
          }),
        ).toString("base64url")
      : undefined;
    if (nextCursor && nextCursor.length > 1024) return fail(false);
    return {
      items,
      hasMore: !!nextCursor,
      ...(nextCursor ? { nextCursor } : {}),
    };
  };
}

/** Shared ParsedHttpSource-style request/parser boundary. Each site owns next-page evidence. */
export function attachHtmlCatalogue(
  source: Source,
  config: {
    requestBaseUrl?: string;
    getText(path: string): Promise<string>;
    path(context: CatalogueContext, page: number): string;
    parse(text: string): Mangas[];
    route: RegExp;
    next?(
      text: string,
      current: URL,
      context: CatalogueContext,
    ): string | undefined | Promise<string | undefined>;
    capabilities?: Partial<SourceCapabilities>;
  },
) {
  const page = (context: CatalogueContext, request?: SourcePageRequest) => {
    const initial = config.path(context, 1);
    const requestBaseUrl = config.requestBaseUrl ?? source.base_url;
    const baseline = new URL(initial, requestBaseUrl);
    const paginationKeys = ["page", "offset", "limit"];
    const compact = (url: URL) => {
      const params = new URLSearchParams(
        [...url.searchParams].filter(([key]) => paginationKeys.includes(key)),
      );
      return `${url.pathname}${params.size ? `?${params}` : ""}`;
    };
    const validate = (position: string) => {
      try {
        const url = new URL(position, requestBaseUrl);
        if (
          url.origin !== baseline.origin ||
          url.username ||
          url.password ||
          url.hash ||
          !config.route.test(url.pathname)
        )
          return false;
        for (const [key, value] of url.searchParams)
          if (!paginationKeys.includes(key) || !/^\d{1,9}$/.test(value))
            return false;
        for (const key of paginationKeys)
          if (url.searchParams.getAll(key).length > 1) return false;
        return true;
      } catch {
        return false;
      }
    };
    return createNativePager(
      source.id,
      compact(baseline),
      validate,
      async (position) => {
        const current = new URL(position, requestBaseUrl);
        for (const [key, value] of baseline.searchParams)
          if (!paginationKeys.includes(key))
            current.searchParams.append(key, value);
        const text = await config.getText(current.href);
        const items = config.parse(text);
        const next = items.length
          ? await (config.next ?? htmlNext)(text, current, context)
          : undefined;
        if (!next) return { items };
        const nextUrl = new URL(next, current);
        for (const key of new Set(current.searchParams.keys())) {
          if (!paginationKeys.includes(key) && !nextUrl.searchParams.has(key))
            for (const value of current.searchParams.getAll(key))
              nextUrl.searchParams.append(key, value);
        }
        // Validate the full URL before reducing it to a local path.
        const contextParams = (url: URL) =>
          JSON.stringify(
            [...url.searchParams]
              .filter(([key]) => !paginationKeys.includes(key))
              .sort(),
          );
        if (
          nextUrl.origin !== baseline.origin ||
          nextUrl.username ||
          nextUrl.password ||
          nextUrl.hash ||
          contextParams(nextUrl) !== contextParams(baseline) ||
          !validate(compact(nextUrl))
        )
          throw new SourceError(
            "PARSE_ERROR",
            "Invalid catalogue next page",
            source.id,
          );
        return { items, next: compact(nextUrl) };
      },
      context,
    )(request);
  };
  source.fetchMangaPage = (category = "latest", request, filters = {}) =>
    page({ category, filters }, request);
  source.searchMangaPage = (query = "", request, filters = {}) =>
    page({ query: query.trim(), filters }, request);
  source.getCapabilities = async () => {
    const filters =
      config.capabilities?.filters !== undefined &&
      config.capabilities?.languageFilter !== undefined
        ? []
        : await source.getFilters();
    return {
      latest: true,
      search: true,
      filters: filters.length > 0,
      languageFilter: filters.some((filter) => filter.value === "language"),
      urlSearch: !!source.resolveMangaUrl,
      nativePagination: true,
      ...config.capabilities,
    };
  };
  return source;
}

export function htmlNext(text: string, current: URL): string | undefined {
  const $ = load(text);
  const href = $(
    'a[rel="next"], a.next, .hpage a.r, .pagination a, .pag a, .hpage a, .nav-links a, .page-numbers a',
  )
    .filter((_, el) => {
      const anchor = $(el);
      return (
        anchor.attr("rel") === "next" ||
        anchor.hasClass("next") ||
        anchor.hasClass("r") ||
        /^(?:(?:next|suivant|siguiente|berikutnya)\b|[›»→]$)/i.test(
          anchor.text().trim(),
        )
      );
    })
    .first()
    .attr("href");
  if (href) return new URL(href, current).href;
  // Some sites render their next-page anchor as an unlabelled SVG arrow.
  const page = Number(current.searchParams.get("page") || 1);
  return $("a[href]")
    .toArray()
    .map((el) => {
      try {
        return new URL($(el).attr("href")!, current);
      } catch {
        return null;
      }
    })
    .find(
      (url) =>
        url &&
        url.origin === current.origin &&
        url.pathname === current.pathname &&
        Number(url.searchParams.get("page")) === page + 1,
    )?.href;
}
