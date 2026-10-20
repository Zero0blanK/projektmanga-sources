// ProjektManga Flame Comics source (Next.js data routes). Some route details were informed
// by Keiyoushi (Apache-2.0); see THIRD_PARTY_NOTICES.md.
import { load } from "cheerio/slim";
import { z } from "zod";
import { HttpClient } from "../../lib/http.js";
import { TTLCache } from "../../lib/cache.js";
import { createNativePager } from "../../lib/nativeCatalogue.js";
import { SourceError } from "../../lib/sourceError.js";
import { deriveIsNSFW } from "../../lib/manifest.js";
import { mapMangaStatus, resolvePagination } from "../../lib/parse.js";
import type {
  Source,
  Mangas,
  Chapters,
  SourcePageRequest,
  FilterValue,
} from "../../lib/types.js";
import manifest from "./manifest.json";

const seriesSchema = z.object({
  series_id: z.number().int().positive().nullish(),
  title: z.string().min(1),
  altTitles: z.array(z.string()).nullish(),
  description: z.string().nullish(),
  cover: z.string().min(1),
  type: z.string(),
  tags: z.array(z.string()).nullish(),
  author: z.array(z.string()).nullish(),
  artist: z.array(z.string()).nullish(),
  status: z.string(),
  last_edit: z.number().finite(),
  views: z.number().nullish(),
});
// The API has sent chapter numbers both as numbers and as strings like "18.00".
const chapterNumber = z
  .union([z.number(), z.string().trim().min(1)])
  .pipe(z.coerce.number().finite());
const chapterSchema = z.object({
  chapter: chapterNumber,
  title: z.string().nullish(),
  release_date: z.number().finite(),
  series_id: z.number().int().positive(),
  token: z.string().regex(/^[A-Za-z0-9_-]+$/),
});
const chapterPageSchema = z.object({
  release_date: z.number().finite(),
  series_id: z.number().int().positive(),
  token: z.string().regex(/^[A-Za-z0-9_-]+$/),
  images: z.record(z.object({ name: z.string().min(1) })),
});
type Series = z.infer<typeof seriesSchema>;
/** One malformed upstream row is skipped rather than failing the whole response. */
function lenientArray<S extends z.ZodTypeAny>(schema: S) {
  return z.array(z.unknown()).transform((rows) =>
    rows.flatMap((row): z.infer<S>[] => {
      const parsed = schema.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    }),
  );
}
const http = new HttpClient({
  sourceId: manifest.source_key,
  sourceName: manifest.name,
  baseUrl: manifest.base_url,
  rateLimitMs: 1000,
});
const cache = new TTLCache<string, unknown>(120_000, 50);
const fail = (message: string): never => {
  throw new SourceError("PARSE_ERROR", message, manifest.source_key);
};
let buildId: string | undefined;
let pendingBuild: Promise<string> | undefined;
async function findBuild(): Promise<string> {
  if (buildId) return buildId;
  if (pendingBuild) return pendingBuild;
  pendingBuild = (async () => {
    const $ = load(await http.getText("/"));
    let data: unknown;
    try {
      data = JSON.parse($("script#__NEXT_DATA__").text());
    } catch {
      return fail("Flame Comics did not provide its current build identifier.");
    }
    const parsed = z
      .object({
        buildId: z
          .string()
          .regex(/^[A-Za-z0-9_-]+$/)
          .max(200),
      })
      .safeParse(data);
    if (!parsed.success)
      return fail("Flame Comics changed its build metadata.");
    buildId = parsed.data.buildId;
    return buildId;
  })();
  try {
    return await pendingBuild;
  } finally {
    pendingBuild = undefined;
  }
}
async function data<T>(
  route: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
): Promise<T> {
  return cache.getOrSet(route, async () => {
    let value: unknown;
    const fetchData = async () =>
      http.getJson(`/_next/data/${await findBuild()}/${route}`);
    try {
      value = await fetchData();
    } catch (error) {
      if (!(error instanceof SourceError) || error.statusCode !== 404)
        throw error;
      // Deploys invalidate every Next data route; discover the replacement once and retry.
      buildId = undefined;
      value = await fetchData();
    }
    const parsed = z.object({ pageProps: schema }).safeParse(value);
    if (!parsed.success)
      return fail("Flame Comics returned an unsupported response.");
    return parsed.data.pageProps;
  }) as Promise<T>;
}
function seriesId(value: string): string {
  if (!/^[1-9]\d{0,11}$/.test(value))
    return fail("Invalid Flame Comics title identifier.");
  return value;
}
function imageUrl(
  id: number,
  name: string,
  revision: number,
  token?: string,
): string {
  const parts = [String(id), ...(token ? [token] : []), name].map(
    encodeURIComponent,
  );
  return `https://cdn.flamecomics.xyz/uploads/images/series/${parts.join("/")}?${revision}`;
}
function manga(row: Series): Mangas | null {
  if (!row.series_id) return null;
  return {
    id: String(row.series_id),
    slug: String(row.series_id),
    source: manifest.source_key,
    title: row.title,
    thumbnail_url: imageUrl(row.series_id, row.cover, row.last_edit),
  };
}
async function browse(
  category: string | undefined,
  query: string | undefined,
  filters: Record<string, FilterValue> = {},
): Promise<Mangas[]> {
  let rows: Series[];
  if (category === "latest" && query === undefined) {
    const latest = await data(
      "index.json",
      z.object({
        latestEntries: z.object({
          blocks: z.array(z.object({ series: lenientArray(seriesSchema) })),
        }),
      }),
    );
    rows = latest.latestEntries.blocks[0]?.series ?? [];
  } else {
    rows = (
      await data("browse.json", z.object({ series: lenientArray(seriesSchema) }))
    ).series;
    const normalized = (value: string) =>
      value
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[^\p{L}\p{N} ]/gu, "");
    if (query?.trim()) {
      const needle = normalized(query).trim();
      // A query of only punctuation has nothing to match on.
      rows = rows.filter((row) =>
        !!needle &&
        [row.title, ...(row.altTitles ?? [])].some((title) =>
          normalized(title).includes(needle),
        ),
      );
    }
  }
  if (filters.status)
    rows = rows.filter((row) => row.status.toLowerCase() === filters.status);
  if (filters.type)
    rows = rows.filter((row) => row.type.toLowerCase() === filters.type);
  if (category !== "latest" || query !== undefined || filters.sort)
    rows = [...rows].sort((a, b) =>
      filters.sort === "title"
        ? a.title.localeCompare(b.title)
        : filters.sort === "latest"
          ? b.last_edit - a.last_edit
          : (b.views ?? 0) - (a.views ?? 0),
    );
  return [
    ...new Map(
      rows
        .map(manga)
        .filter((row): row is Mangas => !!row)
        .map((row) => [row.id, row]),
    ).values(),
  ];
}
const detail = async (id: string) =>
  data(
    `series/${seriesId(id)}.json?id=${id}`,
    z.object({ series: seriesSchema, chapters: lenientArray(chapterSchema) }),
  );
function chapters(
  rows: z.infer<typeof chapterSchema>[],
  id: string,
): Chapters[] {
  return [
    ...new Map(
      rows
        .filter((row) => String(row.series_id) === id)
        .map((row) => {
          const key = `${id}/${row.token}`;
          const chapter: Chapters = {
            id: `${manifest.source_key}:${key}`,
            name: `Chapter ${row.chapter}${row.title?.trim() ? ` — ${row.title.trim()}` : ""}`,
            url: `${manifest.base_url}/series/${key}`,
            chapter_number: row.chapter,
            release_date: new Date(row.release_date * 1000).toISOString(),
            language: manifest.lang,
            last_page_read: 0,
            page_count: 0,
            pages: [],
          };
          return [chapter.id, chapter] as const;
        }),
    ).values(),
  ].sort((a, b) => b.chapter_number - a.chapter_number);
}
async function page(
  category: string | undefined,
  query: string | undefined,
  request: SourcePageRequest = {},
  filters: Record<string, FilterValue> = {},
) {
  return createNativePager(
    manifest.source_key,
    "0",
    (position) => /^\d{1,9}$/.test(position),
    async (position) => {
      const rows = await browse(category, query, filters);
      const start = Number(position);
      if (start > rows.length)
        return fail("Flame Comics catalogue position no longer exists.");
      return {
        items: rows.slice(start, start + 30),
        ...(start + 30 < rows.length ? { next: String(start + 30) } : {}),
      };
    },
    { category, query, filters },
  )(request);
}
const source: Source = {
  id: manifest.source_key,
  name: manifest.name,
  lang: manifest.lang,
  base_url: manifest.base_url,
  isNSFW: deriveIsNSFW(manifest.content_rating),
  getCapabilities: async () => ({
    latest: true,
    search: true,
    filters: true,
    languageFilter: false,
    urlSearch: true,
    nativePagination: true,
  }),
  fetchMangaPage: (category = "latest", request, filters) =>
    page(category, undefined, request, filters),
  searchMangaPage: (query = "", request, filters) =>
    page(undefined, query.trim(), request, filters),
  async fetchManga(category, pagination, filters) {
    const { offset, limit } = resolvePagination(pagination, { limit: 30 });
    return (await browse(category, undefined, filters)).slice(
      offset,
      offset + limit,
    );
  },
  async searchManga(query = "", pagination, filters) {
    const { offset, limit } = resolvePagination(pagination, { limit: 30 });
    return (await browse(undefined, query, filters)).slice(
      offset,
      offset + limit,
    );
  },
  async fetchMangaDetails(id) {
    const result = await detail(id);
    const row = manga(result.series);
    if (!row || row.id !== id)
      return fail("Flame Comics returned a different title.");
    const description = load(result.series.description ?? "")
      .text()
      .trim();
    return {
      ...row,
      url: `${manifest.base_url}/series/${id}`,
      description,
      author: result.series.author ?? [],
      artist: result.series.artist ?? [],
      genres: [result.series.type, ...(result.series.tags ?? [])],
      status: mapMangaStatus(
        result.series.status === "dropped" ? "cancelled" : result.series.status,
      ),
      chapters: chapters(result.chapters, id),
    };
  },
  async fetchMangaThumbnail(id) {
    return (await source.fetchMangaDetails(id)).thumbnail_url;
  },
  async fetchChapters(id) {
    return chapters((await detail(id)).chapters, id);
  },
  async fetchMangaUpdates(id) {
    cache.delete(`series/${seriesId(id)}.json?id=${id}`);
    return source.fetchChapters(id);
  },
  async fetchChapterPages(chapterId, mangaSlug, pagination) {
    const match = /^flamecomics:([1-9]\d{0,11})\/([A-Za-z0-9_-]+)$/.exec(
      chapterId,
    );
    if (!match || (mangaSlug && mangaSlug !== match[1]))
      return fail("Invalid Flame Comics chapter identifier.");
    const [, id, token] = match;
    const row = (
      await data(
        `series/${id}/${token}.json?id=${id}&token=${token}`,
        z.object({ chapter: chapterPageSchema }),
      )
    ).chapter;
    if (String(row.series_id) !== id || row.token !== token)
      return fail("Flame Comics returned a different chapter.");
    const images = Object.values(row.images);
    if (!images.length) return fail("Flame Comics returned no readable pages.");
    const items = images.map((image, index) => ({
      index: index + 1,
      image_url: imageUrl(row.series_id, image.name, row.release_date, token),
    }));
    const { offset, limit } = resolvePagination(pagination, {
      limit: items.length,
    });
    return { items: items.slice(offset, offset + limit), total: items.length };
  },
  async resolveMangaUrl(value) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    if (url.origin !== manifest.base_url || url.username || url.password)
      return null;
    const match = /^\/series\/([1-9]\d{0,11})\/?$/.exec(url.pathname);
    if (!match) return null;
    const result = await source.fetchMangaDetails(match[1]);
    return {
      id: result.id,
      slug: result.slug,
      source: result.source,
      title: result.title,
      thumbnail_url: result.thumbnail_url,
    };
  },
  async getFilters() {
    return [
      {
        label: "Sort",
        value: "sort",
        type: "select",
        options: [
          { label: "Popularity", value: "popular" },
          { label: "Latest", value: "latest" },
          { label: "Title", value: "title" },
        ],
      },
      {
        label: "Status",
        value: "status",
        type: "select",
        options: [
          { label: "Any", value: "" },
          ...["ongoing", "completed", "hiatus", "dropped"].map((value) => ({
            label: value[0].toUpperCase() + value.slice(1),
            value,
          })),
        ],
      },
      {
        label: "Type",
        value: "type",
        type: "select",
        options: [
          { label: "Any", value: "" },
          ...["manga", "manhwa", "manhua"].map((value) => ({
            label: value[0].toUpperCase() + value.slice(1),
            value,
          })),
        ],
      },
    ];
  },
};
export default source;
