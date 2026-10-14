// ProjektManga GigaViewer engine (GraphQL catalogue, viewer JSON reader). Some protocol
// details were informed by Keiyoushi (Apache-2.0); see THIRD_PARTY_NOTICES.md.
import { load } from "cheerio/slim";
import { TTLCache } from "./cache.js";
import { HttpClient, JSON_HEADERS } from "./http.js";
import { deriveIsNSFW } from "./manifest.js";
import { createNativePager } from "./nativeCatalogue.js";
import { normalizeText, parseDateToIso, resolvePagination } from "./parse.js";
import {
  SourceError,
  classifyHttpStatus,
  classifyRequestError,
} from "./sourceError.js";
import type {
  Chapters,
  FilterValue,
  Mangas,
  Source,
  SourceManifest,
} from "./types.js";

export interface GigaViewerConfig {
  groups: string[];
  collections: { label: string; ids: string[] }[];
  seriesHtml?: boolean;
}

interface Series {
  databaseId: string;
  title: string;
  thumbnailUri?: string | null;
  firstEpisode?: { permalink: string } | null;
  firstVolume?: { permalink: string } | null;
  latestEpisode?: { publishedAt?: string | null } | null;
  latestVolume?: { thumbnailUri?: string | null } | null;
  likeCount?: number;
  author?: { name: string } | null;
  description?: string | null;
  episodes?: { totalCount: number };
  volumes?: { totalCount: number };
}
interface Connection {
  edges: { node: Series }[];
}
interface Product {
  readable_product_id: string;
  title: string;
  display_open_at?: string;
  viewer_uri: string;
  purchase_info: { can_read: boolean; unavailable: boolean };
}

const LIST_FIELDS = `databaseId title thumbnailUri firstEpisode { permalink } firstVolume { permalink }
  latestEpisode { publishedAt } latestVolume { thumbnailUri } likeCount`;
const SEARCH_QUERY = `query Search($keyword: String!) { searchSeries(keyword: $keyword) { edges { node { ${LIST_FIELDS} } } } }`;
const SERIES_QUERY = `query Series($id: String!) { series(databaseId: $id) {
  databaseId title author { name } description thumbnailUri firstEpisode { permalink }
  firstVolume { permalink } latestVolume { thumbnailUri }
  episodes: readableProducts(types: [EPISODE], first: 0) { totalCount }
  volumes: readableProducts(types: [VOLUME], first: 0) { totalCount }
} }`;

export function createGigaViewer(
  manifest: SourceManifest,
  config: GigaViewerConfig,
): Source {
  const base = new URL(manifest.base_url);
  const http = new HttpClient({
    sourceId: manifest.source_key,
    sourceName: manifest.name,
    baseUrl: manifest.base_url,
    headers: { "Accept-Language": "ja,en;q=0.8", Referer: `${base.origin}/` },
    rateLimitMs: 250,
  });
  const cache = new TTLCache<string, Series[]>(30_000, 30);
  const fail = (message: string): never => {
    throw new SourceError(
      "PARSE_ERROR",
      `${manifest.name}: ${message}`,
      manifest.source_key,
    );
  };
  const seriesId = (id: string) =>
    /^\d{1,30}$/.test(id) ? id : fail("Invalid title identifier");
  const viewerPath = (id: string) =>
    /^(episode|volume)\/\d{1,30}$/.test(id)
      ? `/${id}`
      : fail("Invalid chapter identifier");
  const allowedHost = (host: string) =>
    manifest.allowed_hosts.some(
      (allowed) => host === allowed || host.endsWith(`.${allowed}`),
    );
  const safeImage = (value: string | null | undefined): string => {
    if (!value) return "";
    let url: URL;
    try {
      url = new URL(value, base);
    } catch {
      return fail("Invalid image URL");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !allowedHost(url.hostname)
    )
      return fail("The publisher returned an unsupported image host");
    return url.href;
  };
  // A cover is decoration: an unexpected one must not fail a whole listing.
  const safeCover = (value: string | null | undefined): string => {
    try {
      return safeImage(value);
    } catch {
      return "";
    }
  };
  const toManga = (series: Series): Mangas => {
    if (
      typeof series.databaseId !== "string" ||
      typeof series.title !== "string" ||
      !series.title.trim()
    )
      return fail("The publisher returned an invalid series");
    const id = seriesId(series.databaseId);
    return {
      id,
      slug: id,
      source: manifest.source_key,
      title: normalizeText(series.title),
      thumbnail_url: safeCover(
        series.thumbnailUri ?? series.latestVolume?.thumbnailUri,
      ),
    };
  };
  async function graphql<T>(
    query: string,
    variables: Record<string, string>,
  ): Promise<T> {
    const url = `${base.origin}/graphql`;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Keep a real timeout even when the sandbox fetch shim delays resolving an abort.
      const response = await Promise.race([
        fetch(url, {
          method: "POST",
          headers: {
            ...JSON_HEADERS,
            "Content-Type": "application/json",
            "Accept-Language": "ja,en;q=0.8",
            Referer: `${base.origin}/`,
            Origin: base.origin,
          },
          body: JSON.stringify({ query, variables }),
          signal: controller.signal,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("Request timeout"));
          }, 15_000);
        }),
      ]);
      const body = await response.text();
      if (!response.ok)
        throw classifyHttpStatus(
          response.status,
          body.slice(0, 4000),
          manifest.source_key,
          manifest.name,
          url,
        );
      const result = JSON.parse(body) as { data?: T; errors?: unknown[] };
      if (result.errors?.length || !result.data)
        return fail("The publisher rejected its catalogue request");
      return result.data;
    } catch (error) {
      if (error instanceof SourceError) throw error;
      throw classifyRequestError(
        error,
        manifest.source_key,
        manifest.name,
        url,
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async function fetchGroups(ids: string[]): Promise<Series[]> {
    if (!ids.length) return [];
    const variables = Object.fromEntries(
      ids.map((id, i) => [
        `id${i}`,
        Buffer.from(id.includes(":") ? id : `SerialGroup:${id}`).toString(
          "base64",
        ),
      ]),
    );
    const definitions = Object.keys(variables)
      .map((key) => `$${key}: ID!`)
      .join(", ");
    const nodes = Object.keys(variables)
      .map(
        (key) => `${key}: node(id: $${key}) {
      ... on SerialGroup { series { edges { node { ${LIST_FIELDS} } } } }
      ... on Genre { series { edges { node { ${LIST_FIELDS} } } } } }`,
      )
      .join("\n");
    const result = await graphql<Record<string, { series: Connection }>>(
      `query(${definitions}) { ${nodes} }`,
      variables,
    );
    const series: Series[] = [];
    for (const key of Object.keys(variables)) {
      const connection = result[key]?.series;
      if (!Array.isArray(connection?.edges))
        return fail("The catalogue collection is unavailable");
      series.push(...connection.edges.map((edge) => edge.node));
    }
    return [...new Map(series.map((item) => [item.databaseId, item])).values()];
  }
  async function htmlSeries(path: string, latest: boolean): Promise<Series[]> {
    const $ = load(await http.getText(`/series${path}`));
    const weekday = new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      timeZone: "Asia/Tokyo",
    })
      .format(new Date())
      .toLowerCase();
    const selector = latest
      ? `h2.series-list-date-week.${weekday} + ul.series-list li a`
      : "ul.series-list li a";
    const result: Series[] = [];
    for (const element of $(selector).toArray()) {
      const link = $(element);
      const cover = safeCover(
        link.find("div.series-list-thumb img").attr("data-src") ||
          link.find("img").attr("src"),
      );
      const title = normalizeText(link.find("h2.series-list-title").text());
      if (!title) continue;
      const episode = new URL(link.attr("href") || "", base);
      if (
        episode.origin !== base.origin ||
        !/^\/(episode|volume)\/\d+$/.test(episode.pathname)
      )
        continue;
      let original: URL | undefined;
      try {
        const thumbnail = new URL(cover);
        // Scaled covers wrap the original, percent-encoded, as their last path segment.
        const last = decodeURIComponent(
          thumbnail.pathname.split("/").at(-1) || "",
        );
        original = last.startsWith("https:") ? new URL(last) : thumbnail;
      } catch {
        /* A missing cover requires the episode's declared series identifier. */
      }
      const parts = original?.pathname.split("/").filter(Boolean) ?? [];
      const inferred = parts.at(-2)?.startsWith("series-")
        ? parts.at(-1)?.split("-")[0]
        : undefined;
      const id =
        inferred && /^\d+$/.test(inferred)
          ? inferred
          : await seriesFromUrl(episode.href);
      result.push({
        databaseId: id,
        title,
        thumbnailUri: cover,
        firstEpisode: { permalink: episode.href },
      });
    }
    return [...new Map(result.map((item) => [item.databaseId, item])).values()];
  }
  async function catalogue(
    category: string | undefined,
    query: string | undefined,
    filters: Record<string, FilterValue>,
  ) {
    const collectionValue = filters.collection;
    if (
      collectionValue !== undefined &&
      (typeof collectionValue !== "string" || !/^\d+$/.test(collectionValue))
    )
      return fail("Invalid collection filter");
    const index = Number(collectionValue ?? 0);
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= config.collections.length
    )
      return fail("Invalid collection filter");
    return cache.getOrSet(
      JSON.stringify({ category, query, index }),
      async () => {
        if (query?.trim()) {
          const data = await graphql<{ searchSeries: Connection }>(
            SEARCH_QUERY,
            { keyword: query.trim() },
          );
          if (!Array.isArray(data.searchSeries?.edges))
            return fail("The search response is invalid");
          return data.searchSeries.edges.map((edge) => edge.node);
        }
        if (config.seriesHtml)
          return htmlSeries(
            config.collections[index].ids[0] || "",
            category === "latest",
          );
        const rows = await fetchGroups(config.collections[index].ids);
        return rows.sort(
          category === "latest"
            ? (a, b) =>
                (Date.parse(b.latestEpisode?.publishedAt || "") || 0) -
                (Date.parse(a.latestEpisode?.publishedAt || "") || 0)
            : (a, b) => (b.likeCount ?? 0) - (a.likeCount ?? 0),
        );
      },
    );
  }
  async function seriesFromUrl(url: string): Promise<string> {
    const parsed = new URL(url);
    if (
      parsed.origin !== base.origin ||
      parsed.username ||
      parsed.password ||
      !/^\/(episode|volume)\/\d{1,30}$/.test(parsed.pathname)
    )
      return fail("Invalid publisher URL");
    const $ = load(await http.getText(parsed.pathname));
    return seriesId($("script.js-valve").attr("data-giga_series") || "");
  }
  async function details(id: string): Promise<Series> {
    const data = await graphql<{ series: Series }>(SERIES_QUERY, {
      id: seriesId(id),
    });
    if (!data.series)
      throw new SourceError(
        "NOT_FOUND",
        `Not found on ${manifest.name}.`,
        manifest.source_key,
      );
    return data.series;
  }
  async function chapters(id: string, series?: Series): Promise<Chapters[]> {
    seriesId(id);
    const metadata = series ?? (await details(id));
    const products: Product[] = [];
    for (const type of ["episode", "volume"] as const) {
      const count =
        metadata[type === "episode" ? "episodes" : "volumes"]?.totalCount;
      if (!Number.isSafeInteger(count) || count! < 0 || count! > 50_000)
        return fail("Invalid chapter count");
      let offset = 0;
      const seen = new Set<string>();
      while (offset < count!) {
        const rows = await http.getJson<Product[]>(
          "/api/viewer/pagination_readable_products",
          {
            params: {
              type,
              aggregate_id: id,
              sort_order: "desc",
              offset,
            },
          },
        );
        if (!Array.isArray(rows))
          return fail("The chapter response is invalid");
        if (!rows.length) break;
        let added = 0;
        for (const row of rows) {
          if (
            typeof row.readable_product_id !== "string" ||
            !row.purchase_info ||
            typeof row.purchase_info.can_read !== "boolean"
          )
            return fail("The publisher returned an invalid chapter");
          if (!seen.has(row.readable_product_id)) {
            seen.add(row.readable_product_id);
            products.push(row);
            added++;
          }
        }
        if (!added) return fail("The chapter catalogue stopped advancing");
        offset += rows.length;
      }
    }
    return products
      .filter(
        (product) =>
          product.purchase_info.can_read && !product.purchase_info.unavailable,
      )
      .map((product) => {
        const url = new URL(product.viewer_uri, base);
        if (
          url.origin !== base.origin ||
          !/^\/(episode|volume)\/\d{1,30}$/.test(url.pathname)
        )
          return fail("Invalid chapter URL");
        const id = url.pathname.slice(1);
        const title = normalizeText(product.title);
        // Prefer an explicit episode marker so "Vol.3 第12話" reads as 12, not 3.
        const number = Number(
          (title.match(/第\s*(\d+(?:\.\d+)?)\s*[話章回]/) ??
            title.match(/(\d+(?:\.\d+)?)\s*[話章回]/) ??
            title.match(/(\d+(?:\.\d+)?)/))?.[1] ?? 0,
        );
        return {
          id: `${manifest.source_key}:${id}`,
          name: title,
          url: url.href,
          chapter_number: number,
          language: "ja",
          last_page_read: 0,
          release_date: parseDateToIso(product.display_open_at || ""),
          pages: [],
        };
      });
  }
  const source: Source = {
    id: manifest.source_key,
    name: manifest.name,
    lang: manifest.lang,
    base_url: manifest.base_url,
    isNSFW: deriveIsNSFW(manifest.content_rating),
    async getCapabilities() {
      return {
        latest: true,
        search: true,
        filters: true,
        languageFilter: false,
        urlSearch: true,
        nativePagination: true,
      };
    },
    async fetchMangaPage(category, request, filters = {}) {
      return createNativePager(
        manifest.source_key,
        "0",
        (position) => /^\d{1,9}$/.test(position),
        async (position) => {
          const rows = (await catalogue(category, undefined, filters)).map(
            toManga,
          );
          const start = Number(position);
          return {
            items: rows.slice(start, start + 30),
            ...(start + 30 < rows.length ? { next: String(start + 30) } : {}),
          };
        },
        { category, filters },
      )(request);
    },
    async searchMangaPage(query = "", request, filters = {}) {
      return createNativePager(
        manifest.source_key,
        "0",
        (position) => /^\d{1,9}$/.test(position),
        async (position) => {
          const rows = (await catalogue(undefined, query, filters)).map(
            toManga,
          );
          const start = Number(position);
          return {
            items: rows.slice(start, start + 30),
            ...(start + 30 < rows.length ? { next: String(start + 30) } : {}),
          };
        },
        { query, filters },
      )(request);
    },
    async fetchManga(category, pagination, filters = {}) {
      const { limit, offset } = resolvePagination(pagination, { limit: 30 });
      return (await catalogue(category, undefined, filters))
        .slice(offset, offset + limit)
        .map(toManga);
    },
    async searchManga(query = "", pagination, filters = {}) {
      const { limit, offset } = resolvePagination(pagination, { limit: 30 });
      return (await catalogue(undefined, query, filters))
        .slice(offset, offset + limit)
        .map(toManga);
    },
    async fetchMangaDetails(id) {
      const series = await details(id);
      return {
        ...toManga(series),
        author: series.author?.name ? [series.author.name] : [],
        description: normalizeText(load(series.description || "").text()),
        genres: [],
        status: "UNKNOWN",
        chapters: await chapters(id, series),
      };
    },
    fetchChapters: chapters,
    fetchMangaUpdates: chapters,
    async fetchMangaThumbnail(id) {
      return toManga(await details(id)).thumbnail_url;
    },
    async fetchChapterPages(id, _slug, pagination) {
      const prefix = `${manifest.source_key}:`;
      if (!id.startsWith(prefix)) return fail("Invalid chapter identifier");
      const $ = load(await http.getText(viewerPath(id.slice(prefix.length))));
      const raw = $("script#episode-json").attr("data-value");
      if (!raw) return fail("The reader data is unavailable");
      let structure:
        | { choJuGiga?: string; pages?: { type?: string; src?: string }[] }
        | undefined;
      try {
        structure = JSON.parse(raw).readableProduct?.pageStructure;
      } catch {
        return fail("The reader data is invalid");
      }
      if (!Array.isArray(structure?.pages) || !structure.pages.length)
        throw new SourceError(
          "BLOCKED",
          `${manifest.name}: This chapter is unavailable or requires purchase.`,
          manifest.source_key,
        );
      if (structure.choJuGiga === "baku")
        throw new SourceError(
          "BLOCKED",
          `${manifest.name}: This chapter uses a scrambled image format that ProjektManga cannot display yet.`,
          manifest.source_key,
        );
      const pages = structure.pages
        .filter((page) => page.type === "main")
        .map((page, index) => {
          if (!page.src) return fail("A reader image is missing");
          return { index: index + 1, image_url: safeImage(page.src) };
        });
      if (!pages.length) return fail("No readable pages were returned");
      const { limit, offset } = resolvePagination(pagination, {
        limit: pages.length,
      });
      return {
        items: pages.slice(offset, offset + limit),
        total: pages.length,
      };
    },
    async getFilters() {
      return [
        {
          label: "Collection",
          value: "collection",
          type: "select",
          options: config.collections.map((collection, index) => ({
            label: collection.label,
            value: String(index),
          })),
        },
      ];
    },
    async resolveMangaUrl(url) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return null;
      }
      if (
        parsed.origin !== base.origin ||
        parsed.username ||
        parsed.password ||
        !/^\/(episode|volume)\/\d{1,30}$/.test(parsed.pathname)
      )
        return null;
      return toManga(await details(await seriesFromUrl(url)));
    },
  };
  return source;
}
