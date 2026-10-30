// Iken: a scanlation-site platform with a JSON API on the site's `api.` subdomain.
// Endpoints and fields follow the Keiyoushi "iken" library (Apache-2.0); see
// THIRD_PARTY_NOTICES.md. Locked chapters (coins, time or link locks) are left out: they
// can't be read without an account.
import { load } from "cheerio/slim";
import { HttpClient, JSON_HEADERS } from "./http.js";
import { TTLCache } from "./cache.js";
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

export interface IkenOptions {
  /** Titles per catalogue page. */
  perPage?: number;
  /** Order page images by the number in their file name rather than the API's order. */
  sortPagesByFilename?: boolean;
}

interface Post {
  id: number;
  slug: string;
  postTitle: string;
  postContent?: string | null;
  isNovel?: boolean;
  featuredImage?: string | null;
  alternativeTitles?: string | null;
  author?: string | null;
  artist?: string | null;
  seriesType?: string | null;
  seriesStatus?: string | null;
  genres?: Array<{ id: number; name: string }>;
  chapters?: ApiChapter[];
}
interface ApiChapter {
  id: number;
  slug: string;
  number: number | string;
  title?: string | null;
  createdAt?: string;
  isLocked?: boolean | null;
  isTimeLocked?: boolean | null;
  price?: number | null;
  chapterPurchased?: boolean | null;
}

const STATUS: Record<string, string> = {
  ONGOING: MANGA_STATUS.ONGOING,
  COMING_SOON: MANGA_STATUS.ONGOING,
  MASS_RELEASED: MANGA_STATUS.ONGOING,
  COMPLETED: MANGA_STATUS.COMPLETED,
  CANCELLED: MANGA_STATUS.CANCELLED,
  DROPPED: MANGA_STATUS.CANCELLED,
};

const filters: MangaFilter[] = [
  {
    label: "Sort",
    value: "orderBy",
    type: "select",
    options: [
      { label: "Last chapter", value: "lastChapterAddedAt" },
      { label: "Views", value: "totalViews" },
      { label: "Date added", value: "createdAt" },
      { label: "Chapter count", value: "chaptersCount" },
      { label: "Title", value: "postTitle" },
    ],
  },
  {
    label: "Status",
    value: "seriesStatus",
    type: "select",
    options: [
      { label: "All", value: "" },
      { label: "Ongoing", value: "ONGOING" },
      { label: "Completed", value: "COMPLETED" },
      { label: "Cancelled", value: "CANCELLED" },
      { label: "Dropped", value: "DROPPED" },
      { label: "Coming soon", value: "COMING_SOON" },
      { label: "Mass released", value: "MASS_RELEASED" },
    ],
  },
  {
    label: "Type",
    value: "seriesType",
    type: "select",
    options: [
      { label: "All", value: "" },
      { label: "Manga", value: "MANGA" },
      { label: "Manhua", value: "MANHUA" },
      { label: "Manhwa", value: "MANHWA" },
    ],
  },
];

const SLUG = /^[a-z0-9][a-z0-9-]{0,199}$/i;
const locked = (chapter: ApiChapter) =>
  chapter.isLocked === true ||
  chapter.isTimeLocked === true ||
  (chapter.chapterPurchased === false && (chapter.price ?? 0) !== 0);

export function createIkenSite(
  manifest: SourceManifest,
  options: IkenOptions = {},
): Source {
  const base = manifest.base_url;
  const api = base.replace("https://", "https://api.");
  const perPage = options.perPage ?? 18;
  const prefix = `${manifest.source_key}:`;
  const http = new HttpClient({
    sourceId: manifest.source_key,
    sourceName: manifest.name,
    baseUrl: api,
    headers: { ...JSON_HEADERS, Referer: `${base}/`, Origin: base },
    rateLimitMs: 300,
  });
  const posts = new TTLCache<
    string,
    { totalChapterCount?: number; post: Post }
  >(30_000, 40);
  const fail = (message: string): never => {
    throw new SourceError(
      "PARSE_ERROR",
      `${manifest.name}: ${message}`,
      manifest.source_key,
    );
  };

  const card = (post: Post): Mangas => ({
    id: post.slug,
    slug: post.slug,
    title: post.postTitle,
    source: manifest.source_key,
    thumbnail_url: post.featuredImage ?? "",
  });

  async function query(
    text: string,
    page: number,
    active: Record<string, FilterValue>,
  ) {
    const url = new URL("/api/query", api);
    url.searchParams.set("perPage", String(perPage));
    url.searchParams.set("searchTerm", text);
    url.searchParams.set("page", String(page));
    for (const key of ["orderBy", "seriesStatus", "seriesType"])
      if (typeof active[key] === "string" && active[key])
        url.searchParams.set(key, active[key]);
    const data = await http.getJson<{ posts?: Post[] }>(url.href);
    return (data.posts ?? [])
      .filter(
        (post) =>
          !post.isNovel &&
          post.seriesType?.toUpperCase() !== "NOVEL" &&
          SLUG.test(post.slug),
      )
      .map(card);
  }

  function postOf(slug: string) {
    if (!SLUG.test(slug)) return fail("Invalid title identifier");
    return posts.getOrSet(slug, () =>
      http.getJson<{ totalChapterCount?: number; post: Post }>(
        `/api/post?postSlug=${encodeURIComponent(slug)}`,
      ),
    );
  }

  async function chaptersOf(slug: string): Promise<Chapters[]> {
    const data = await postOf(slug);
    let list = data.post.chapters ?? [];
    // The post carries only the latest chapters of a long series.
    if ((data.totalChapterCount ?? 0) > list.length) {
      const full = await http.getJson<{ post?: { chapters?: ApiChapter[] } }>(
        `/api/chapters?postId=${data.post.id}`,
      );
      if ((full.post?.chapters?.length ?? 0) > list.length)
        list = full.post!.chapters!;
    }
    return list
      .filter((chapter) => !locked(chapter) && SLUG.test(chapter.slug))
      .map((chapter) => {
        const number = Number(chapter.number);
        return {
          id: `${prefix}${chapter.id}`,
          name: `Chapter ${chapter.number}${chapter.title ? ` - ${chapter.title}` : ""}`,
          url: `${base}/series/${slug}/${chapter.slug}`,
          chapter_number: Number.isFinite(number) ? number : 0,
          release_date: chapter.createdAt
            ? new Date(chapter.createdAt).toISOString()
            : "",
          language: manifest.lang,
          last_page_read: 0,
          pages: [],
        };
      })
      .sort((a, b) => b.chapter_number - a.chapter_number);
  }

  const source: Source = {
    id: manifest.source_key,
    name: manifest.name,
    lang: manifest.lang,
    base_url: base,
    isNSFW: deriveIsNSFW(manifest.content_rating),
    async fetchManga(category, pagination, active = {}) {
      const order =
        typeof active.orderBy === "string" && active.orderBy
          ? active.orderBy
          : category === "popular"
            ? "totalViews"
            : "lastChapterAddedAt";
      return collectSequentialPages(
        resolvePagination(pagination, { limit: perPage }),
        manifest.source_key,
        (page) => query("", page, { ...active, orderBy: order }),
      );
    },
    async searchManga(text = "", pagination, active = {}) {
      return collectSequentialPages(
        resolvePagination(pagination, { limit: perPage }),
        manifest.source_key,
        (page) => query(text.trim(), page, active),
      );
    },
    async fetchMangaDetails(slug) {
      const { post } = await postOf(slug);
      if (post.isNovel) return fail("Novels can't be read here");
      const type = { MANGA: "Manga", MANHUA: "Manhua", MANHWA: "Manhwa" }[
        post.seriesType ?? ""
      ];
      const description = normalizeText(
        load((post.postContent ?? "").replace(/\n/g, "<br>")).text(),
      );
      return {
        ...card(post),
        url: `${base}/series/${post.slug}`,
        author: post.author ? [post.author] : [],
        artist: post.artist ? [post.artist] : [],
        genres: [
          ...new Set([
            ...(type ? [type] : []),
            ...(post.genres ?? []).map((genre) => genre.name),
          ]),
        ],
        status: STATUS[post.seriesStatus ?? ""] ?? MANGA_STATUS.UNKNOWN,
        description: [
          description,
          post.alternativeTitles &&
            `Alternative names: ${post.alternativeTitles}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
        chapters: await chaptersOf(slug),
      };
    },
    async fetchMangaThumbnail(slug) {
      try {
        return (await postOf(slug)).post.featuredImage ?? "";
      } catch {
        return "";
      }
    },
    fetchChapters: chaptersOf,
    async fetchChapterPages(chapterId, _slug, pagination) {
      if (!chapterId.startsWith(prefix))
        return fail("Invalid chapter identifier");
      const id = chapterId.slice(prefix.length);
      if (!/^\d{1,12}$/.test(id)) return fail("Invalid chapter identifier");
      const data = await http.getJson<{
        chapter: {
          images?: Array<{ url: string; order?: number | null }>;
          isPermanentlyLocked?: boolean;
          isLockedByCoins?: boolean;
          isShortLinkLocked?: boolean;
        };
      }>(`/api/chapter?chapterId=${id}`);
      const chapter = data.chapter;
      if (
        chapter.isPermanentlyLocked ||
        chapter.isLockedByCoins ||
        chapter.isShortLinkLocked
      )
        throw new SourceError(
          "NOT_FOUND",
          `${manifest.name} has locked this chapter; it can only be read on the site.`,
          manifest.source_key,
        );
      const fileNumber = (url: string) =>
        Number(
          url.split("/").pop()?.match(/\d+/)?.[0] ?? Number.MAX_SAFE_INTEGER,
        );
      const images = [...(chapter.images ?? [])]
        .sort((a, b) =>
          options.sortPagesByFilename
            ? fileNumber(a.url) - fileNumber(b.url)
            : (a.order ?? Number.MAX_SAFE_INTEGER) -
              (b.order ?? Number.MAX_SAFE_INTEGER),
        )
        .map((image) => image.url.replace(/ /g, "%20"));
      if (images.length === 0) return fail("This chapter has no pages");
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
      return filters;
    },
    async fetchMangaUpdates(slug) {
      posts.clear();
      return chaptersOf(slug);
    },
  };
  return source;
}
