// A raw-manga site design (RawDevArt, RawUwU) whose reader is a single-page app over a JSON
// API (`/spa/...`). Endpoints and fields follow the Keiyoushi "rawdevartart" and "rawuwu"
// extensions (Apache-2.0); see THIRD_PARTY_NOTICES.md.
import { load } from "cheerio/slim";
import { HttpClient, NAV_HEADERS } from "./http.js";
import { deriveIsNSFW } from "./manifest.js";
import { MANGA_STATUS, normalizeText, resolvePagination } from "./parse.js";
import { collectSequentialPages } from "./sequentialPagination.js";
import { SourceError } from "./sourceError.js";
import type {
  Chapters,
  FilterValue,
  MangaFilter,
  Mangas,
  Source,
  SourceManifest,
} from "./types.js";
const ID = /^\d{1,12}$/;
const CHAPTER = /^\d{1,12}\/\d{1,6}(?:\.\d{1,3})?$/;

interface ListItem {
  manga_id: number;
  manga_name: string;
  manga_cover_img: string;
}
interface ListResponse {
  manga_list?: ListItem[];
  pagi?: { button?: { next?: number } };
}
interface DetailResponse {
  detail: {
    manga_id: number;
    manga_name: string;
    manga_others_name?: string | null;
    manga_status?: boolean;
    manga_description?: string | null;
    manga_cover_img: string;
    manga_cover_img_full?: string | null;
  };
  tags?: Array<{ tag_name: string }>;
  authors?: Array<{ author_name: string }>;
  chapters?: Array<{
    chapter_title: string;
    chapter_number: number;
    chapter_date_published: string;
  }>;
}
interface ChapterResponse {
  chapter_detail?: { chapter_content?: string | null; server?: string };
}

export interface SpaRawUrls {
  /** The title's page on the site, for "open in browser". */
  title(id: string): string;
  /** A chapter's reader page. */
  chapter(id: string, number: string): string;
}

export function createSpaRawSite(
  manifest: SourceManifest,
  urls: SpaRawUrls,
): Source {
  const SOURCE = manifest;
  const BASE = SOURCE.base_url;
  const PREFIX = `${SOURCE.source_key}:`;
  const http = new HttpClient({
    sourceId: SOURCE.source_key,
    sourceName: SOURCE.name,
    baseUrl: BASE,
    headers: {
      ...NAV_HEADERS,
      Accept: "application/json",
      Referer: `${BASE}/`,
    },
    rateLimitMs: 400,
  });

  const fail = (message: string): never => {
    throw new SourceError(
      "PARSE_ERROR",
      `${SOURCE.name}: ${message}`,
      SOURCE.source_key,
    );
  };
  const numberText = (value: number) => String(value).replace(/\.0+$/, "");

  const SORTS = [
    { label: "Recently updated", value: "" },
    { label: "Most viewed", value: "most_viewed" },
    { label: "Most viewed today", value: "most_viewed_today" },
  ];
  const STATUSES = [
    { label: "All", value: "" },
    { label: "Ongoing", value: "ongoing" },
    { label: "Completed", value: "completed" },
  ];
  const FILTERS: MangaFilter[] = [
    { label: "Sort by", value: "sort", type: "select", options: SORTS },
    { label: "Status", value: "status", type: "select", options: STATUSES },
  ];
  const pick = (
    value: FilterValue | undefined,
    options: Array<{ value: string }>,
  ) =>
    typeof value === "string" &&
    options.some((option) => option.value === value)
      ? value
      : undefined;

  async function list(url: URL): Promise<Mangas[]> {
    const data = await http.getJson<ListResponse>(url.href);
    return (data.manga_list ?? []).flatMap((item) =>
      Number.isInteger(item.manga_id) && item.manga_name
        ? [
            {
              id: String(item.manga_id),
              slug: String(item.manga_id),
              title: normalizeText(item.manga_name),
              source: SOURCE.source_key,
              thumbnail_url: item.manga_cover_img ?? "",
            },
          ]
        : [],
    );
  }

  function browse(page: number, sort: string, status = ""): URL {
    const url = new URL("/spa/genre/all", BASE);
    url.searchParams.set("page", String(page));
    if (sort) url.searchParams.set("sort", sort);
    if (status) url.searchParams.set("status", status);
    return url;
  }

  async function detailOf(id: string): Promise<DetailResponse> {
    if (!ID.test(id)) return fail("Invalid title identifier");
    const data = await http.getJson<DetailResponse>(
      new URL(`/spa/manga/${id}`, BASE).href,
    );
    if (!data?.detail)
      throw new SourceError(
        "NOT_FOUND",
        `Not found on ${SOURCE.name}.`,
        SOURCE.source_key,
      );
    return data;
  }

  function chaptersFrom(data: DetailResponse): Chapters[] {
    const id = data.detail.manga_id;
    return (data.chapters ?? [])
      .filter((chapter) => Number.isFinite(chapter.chapter_number))
      .map((chapter) => {
        const number = numberText(chapter.chapter_number);
        const date = new Date(chapter.chapter_date_published);
        return {
          id: `${PREFIX}${id}/${number}`,
          name: `Chapter ${number}${chapter.chapter_title ? `: ${normalizeText(chapter.chapter_title)}` : ""}`,
          url: new URL(urls.chapter(String(id), number), BASE).href,
          chapter_number: chapter.chapter_number,
          release_date: Number.isNaN(date.getTime()) ? "" : date.toISOString(),
          language: SOURCE.lang,
          last_page_read: 0,
          pages: [],
        };
      })
      .sort((a, b) => b.chapter_number - a.chapter_number);
  }

  const source: Source = {
    id: SOURCE.source_key,
    name: SOURCE.name,
    lang: SOURCE.lang,
    base_url: BASE,
    isNSFW: deriveIsNSFW(SOURCE.content_rating),
    async fetchManga(category, pagination, filters = {}) {
      const sort = pick(filters.sort, SORTS);
      const status = pick(filters.status, STATUSES) ?? "";
      return collectSequentialPages(
        resolvePagination(pagination, { limit: 40 }),
        SOURCE.source_key,
        (page) => {
          if (category === "latest" && sort === undefined && !status) {
            const url = new URL("/spa/latest-manga", BASE);
            url.searchParams.set("page", String(page));
            return list(url);
          }
          return list(browse(page, sort ?? "most_viewed", status));
        },
      );
    },
    async searchManga(query = "", pagination, filters = {}) {
      if (!query.trim())
        return source.fetchManga("popular", pagination, filters);
      return collectSequentialPages(
        resolvePagination(pagination, { limit: 40 }),
        SOURCE.source_key,
        (page) => {
          const url = new URL("/spa/search", BASE);
          url.searchParams.set("page", String(page));
          url.searchParams.set("query", query.trim());
          return list(url);
        },
      );
    },
    async fetchMangaDetails(id) {
      const data = await detailOf(id);
      const { detail } = data;
      return {
        id: String(detail.manga_id),
        slug: String(detail.manga_id),
        title: normalizeText(detail.manga_name),
        source: SOURCE.source_key,
        thumbnail_url:
          detail.manga_cover_img_full || detail.manga_cover_img || "",
        url: new URL(urls.title(String(detail.manga_id)), BASE).href,
        author: (data.authors ?? [])
          .map((author) => normalizeText(author.author_name))
          .filter(Boolean),
        genres: (data.tags ?? [])
          .map((tag) => normalizeText(tag.tag_name))
          .filter(Boolean),
        status: detail.manga_status
          ? MANGA_STATUS.COMPLETED
          : MANGA_STATUS.ONGOING,
        description: [
          normalizeText(detail.manga_description ?? ""),
          detail.manga_others_name?.trim()
            ? `Alternative titles:\n${detail.manga_others_name.trim()}`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
        chapters: chaptersFrom(data),
      };
    },
    async fetchMangaThumbnail(id) {
      try {
        const { detail } = await detailOf(id);
        return detail.manga_cover_img_full || detail.manga_cover_img || "";
      } catch {
        return "";
      }
    },
    async fetchChapters(id) {
      return chaptersFrom(await detailOf(id));
    },
    async fetchChapterPages(chapterId, _slug, pagination) {
      if (!chapterId.startsWith(PREFIX))
        return fail("Invalid chapter identifier");
      const key = chapterId.slice(PREFIX.length);
      if (!CHAPTER.test(key)) return fail("Invalid chapter identifier");
      const data = await http.getJson<ChapterResponse>(
        new URL(`/spa/manga/${key}`, BASE).href,
      );
      const content = data.chapter_detail?.chapter_content ?? "";
      // Image paths are relative to the chapter's image server.
      const server = data.chapter_detail?.server ?? BASE;
      const $ = load(content);
      const images = $("img[data-src]")
        .map((_, el) => {
          try {
            return new URL($(el).attr("data-src") ?? "", server).href;
          } catch {
            return "";
          }
        })
        .get()
        .filter((src) => src.startsWith("https://"));
      if (images.length === 0)
        throw new SourceError(
          "PARSE_ERROR",
          `${SOURCE.name} returned no readable pages for this chapter — it may have changed its layout.`,
          SOURCE.source_key,
        );
      const { limit, offset } = resolvePagination(pagination, {
        limit: images.length,
      });
      const start = Math.min(offset, images.length);
      return {
        items: images
          .slice(start, start + Math.max(1, limit))
          .map((image_url, index) => ({ index: start + index + 1, image_url })),
        total: images.length,
      };
    },
    async getFilters() {
      return FILTERS;
    },
    async fetchMangaUpdates(id) {
      return chaptersFrom(await detailOf(id));
    },
  };

  return source;
}
