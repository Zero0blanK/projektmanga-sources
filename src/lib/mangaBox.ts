// The MangaBox family (Mangakakalot, Manganato, MangaBat): one site design under several
// domains. Catalogue paths, selectors, the chapter API and the reader's CDN script follow
// the Keiyoushi "mangabox" library (Apache-2.0); see THIRD_PARTY_NOTICES.md.
import type { CheerioAPI } from "cheerio/slim";
import { createHtmlSite, lazyImage } from "./htmlSite.js";
import { mapMangaStatus, normalizeText } from "./parse.js";
import type { FilterValue, MangaFilter, SourceManifest } from "./types.js";
import genres from "./mangaBoxGenres.json";

const filters: MangaFilter[] = [
  {
    label: "Order by",
    value: "sort",
    type: "select",
    options: [
      { label: "Latest", value: "latest" },
      { label: "Newest", value: "newest" },
      { label: "Top read", value: "topview" },
    ],
  },
  {
    label: "Status",
    value: "status",
    type: "select",
    options: [
      { label: "All", value: "all" },
      { label: "Completed", value: "completed" },
      { label: "Ongoing", value: "ongoing" },
    ],
  },
  {
    label: "Category",
    value: "genre",
    type: "select",
    options: [{ label: "All", value: "" }, ...genres],
  },
];

/** The site's one `filter` number for each order-and-status pair. */
const FILTER_ID: Record<string, string> = {
  "newest/all": "1",
  "newest/completed": "2",
  "newest/ongoing": "3",
  "latest/all": "4",
  "latest/completed": "5",
  "latest/ongoing": "6",
  "topview/all": "7",
  "topview/completed": "8",
  "topview/ongoing": "9",
};

/** The site's search slug: lower case, accents dropped, punctuation to underscores. */
export function mangaBoxQuery(query: string): string {
  return query
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/[!@%^*()+=<>?/,.:;'\s"&#[\]~\-$_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const SLUG = /^[a-z0-9][a-z0-9_-]{0,199}$/;

function cards($: CheerioAPI) {
  return $(
    "div.truyen-list > div.list-truyen-item-wrap, div.comic-list > .list-comic-item-wrap, .panel_story_list .story_item, div.list-truyen-item-wrap, div.list-comic-item-wrap",
  )
    .toArray()
    .flatMap((el) => {
      const link = $(el).find("h3 a").first();
      const id = (link.attr("href") ?? "").match(/\/manga\/([^/?#]+)\/?$/)?.[1];
      const title = normalizeText(link.text());
      return id && title && SLUG.test(id)
        ? [
            {
              id,
              slug: id,
              title,
              thumbnail_url: lazyImage($(el).find("img").first()),
            },
          ]
        : [];
    });
}

interface ApiChapter {
  chapter_name?: string | null;
  chapter_slug?: string | null;
  chapter_num?: number | null;
  updated_at?: string | null;
}

/** Splits `name = [ "a", "b" ]` out of the reader's script. */
function scriptArray(script: string, name: string): string[] {
  const body = script.match(new RegExp(`${name}\\s*=\\s*\\[([^\\]]+)\\]`))?.[1];
  return body
    ? body
        .split(",")
        .map((entry) =>
          entry
            .trim()
            .replace(/^"|"$/g, "")
            .replace(/\\\//g, "/")
            .replace(/\/$/, ""),
        )
        .filter(Boolean)
    : [];
}

export function createMangaBoxSite(manifest: SourceManifest) {
  const base = manifest.base_url;
  return createHtmlSite(manifest, {
    idPattern: SLUG,
    chapterKeyPattern:
      /^[a-z0-9][a-z0-9_-]{0,199}\/[a-z0-9][a-z0-9._-]{0,199}$/,
    filters,
    // The Origin header makes the site's Cloudflare cache miss.
    rateLimitMs: 400,
    catalogueUrl: (category, page, active: Record<string, FilterValue>) => {
      const sort = typeof active.sort === "string" ? active.sort : "";
      const status = typeof active.status === "string" ? active.status : "";
      const genre = typeof active.genre === "string" ? active.genre : "";
      if (sort || status || genre) {
        const url = new URL(`/genre${genre ? `/${genre}` : "/all"}`, base);
        const id = FILTER_ID[`${sort || "latest"}/${status || "all"}`];
        if (id) url.searchParams.set("filter", id);
        url.searchParams.set("page", String(page));
        return url.href;
      }
      return new URL(
        `/manga-list/${category === "latest" ? "latest-manga" : "hot-manga"}?page=${page}`,
        base,
      ).href;
    },
    searchUrl: (query, page) => {
      const slug = mangaBoxQuery(query);
      return slug
        ? new URL(`/search/story/${slug}?page=${page}`, base).href
        : null;
    },
    parseCards: ($) => cards($),
    titleUrl: (id) => `/manga/${id}`,
    parseDetails: ($) => {
      const info = $("div.manga-info-top, div.panel-story-info").first();
      const title = normalizeText(info.find("h1, h2").first().text());
      const description = normalizeText(
        $("div#noidungm, div#panel-story-info-description, div#contentBox")
          .first()
          .text()
          .replace(
            new RegExp(
              `^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} summary:\\s*`,
            ),
            "",
          ),
      );
      const alt = normalizeText(
        $(".story-alternative, tr:has(.info-alternative) h2").first().text(),
      );
      return {
        title,
        author: info
          .find("li:contains(Author) a, td:contains(Author) + td a")
          .map((_, el) => normalizeText($(el).text()))
          .get()
          .filter(Boolean),
        status: mapMangaStatus(
          info
            .find("li:contains(Status), td:contains(Status) + td")
            .first()
            .text(),
        ),
        genres: info
          .find("li:contains(Genres) a, td:contains(Genres) + td a")
          .map((_, el) => normalizeText($(el).text()))
          .get()
          .filter(Boolean),
        description: [
          description,
          alt &&
            `Alternative names: ${alt.replace(/^Alternative ?:?/i, "").trim()}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
        thumbnail_url: lazyImage(
          $("div.manga-info-pic img, span.info-image img").first(),
        ),
      };
    },
    // Chapters come from the site's API, every one in one response.
    parseChapters: () => [],
    chapterList: {
      url: (id) => new URL(`/api/manga/${id}/chapters?limit=-1`, base).href,
      parse: (body, id) => {
        let data: { success?: boolean; data?: { chapters?: ApiChapter[] } };
        try {
          data = JSON.parse(body);
        } catch {
          return [];
        }
        return (data.data?.chapters ?? []).flatMap((chapter) =>
          chapter.chapter_slug
            ? [
                {
                  key: `${id}/${chapter.chapter_slug}`,
                  name: chapter.chapter_name || "Chapter",
                  number: Number(chapter.chapter_num ?? 0),
                  date: chapter.updated_at
                    ? new Date(chapter.updated_at).toISOString()
                    : "",
                },
              ]
            : [],
        );
      },
    },
    chapterUrl: (key) => `/manga/${key}`,
    // The reader lists its image paths in a script, with the CDNs to fetch them from;
    // pages without that script carry plain <img> tags.
    parsePages: ($, html) => {
      const cdns = [
        ...scriptArray(html, "cdns"),
        ...scriptArray(html, "backupImage"),
      ];
      const paths = scriptArray(html, "chapterImages");
      if (paths.length && cdns[0])
        return paths.map((path) => `${cdns[0]}/${path.replace(/^\/+/, "")}`);
      return $("div.container-chapter-reader > img")
        .map((_, el) => lazyImage($(el)))
        .get();
    },
  });
}
