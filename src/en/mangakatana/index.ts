// MangaKatana. URL shapes, filters and the reader's image-array script follow the
// Keiyoushi extension (Apache-2.0); see THIRD_PARTY_NOTICES.md.
import type { CheerioAPI } from "cheerio/slim";
import { createHtmlSite } from "../../lib/htmlSite.js";
import {
  chapterNumberFromName,
  mapMangaStatus,
  normalizeText,
  parseDateToIso,
} from "../../lib/parse.js";
import type {
  FilterValue,
  MangaFilter,
  SourceManifest,
  TriStateFilterValue,
} from "../../lib/types.js";
import manifest from "./manifest.json";

const GENRES: Array<[string, string]> = [
  ["4-koma", "4 koma"],
  ["action", "Action"],
  ["adult", "Adult"],
  ["adventure", "Adventure"],
  ["artbook", "Artbook"],
  ["award-winning", "Award winning"],
  ["comedy", "Comedy"],
  ["cooking", "Cooking"],
  ["doujinshi", "Doujinshi"],
  ["drama", "Drama"],
  ["ecchi", "Ecchi"],
  ["erotica", "Erotica"],
  ["fantasy", "Fantasy"],
  ["gender-bender", "Gender Bender"],
  ["gore", "Gore"],
  ["harem", "Harem"],
  ["historical", "Historical"],
  ["horror", "Horror"],
  ["isekai", "Isekai"],
  ["josei", "Josei"],
  ["loli", "Loli"],
  ["manhua", "Manhua"],
  ["manhwa", "Manhwa"],
  ["martial-arts", "Martial Arts"],
  ["mecha", "Mecha"],
  ["medical", "Medical"],
  ["music", "Music"],
  ["mystery", "Mystery"],
  ["one-shot", "One shot"],
  ["overpowered-mc", "Overpowered MC"],
  ["psychological", "Psychological"],
  ["reincarnation", "Reincarnation"],
  ["romance", "Romance"],
  ["school-life", "School Life"],
  ["sci-fi", "Sci-fi"],
  ["seinen", "Seinen"],
  ["sexual-violence", "Sexual violence"],
  ["shota", "Shota"],
  ["shoujo", "Shoujo"],
  ["shoujo-ai", "Shoujo Ai"],
  ["shounen", "Shounen"],
  ["shounen-ai", "Shounen Ai"],
  ["slice-of-life", "Slice of Life"],
  ["sports", "Sports"],
  ["super-power", "Super power"],
  ["supernatural", "Supernatural"],
  ["survival", "Survival"],
  ["time-travel", "Time Travel"],
  ["tragedy", "Tragedy"],
  ["webtoon", "Webtoon"],
  ["yaoi", "Yaoi"],
  ["yuri", "Yuri"],
];

const filters: MangaFilter[] = [
  {
    label: "Search by",
    value: "search_by",
    type: "select",
    options: [
      { label: "Title", value: "book_name" },
      { label: "Author", value: "author" },
    ],
  },
  {
    label: "Sort",
    value: "order",
    type: "select",
    options: [
      { label: "Latest update", value: "latest" },
      { label: "New manga", value: "new" },
      { label: "A-Z", value: "az" },
      { label: "Number of chapters", value: "numc" },
    ],
  },
  {
    label: "Status",
    value: "status",
    type: "select",
    options: [
      { label: "All", value: "" },
      { label: "Cancelled", value: "0" },
      { label: "Ongoing", value: "1" },
      { label: "Completed", value: "2" },
    ],
  },
  {
    label: "Genres",
    value: "genre",
    type: "tri-state",
    options: GENRES.map(([value, label]) => ({ label, value })),
  },
];

/** The filtered catalogue: genres included/excluded, sort and status. */
function catalogue(page: number, active: Record<string, FilterValue>) {
  const url = new URL(`/manga/page/${page}`, manifest.base_url);
  url.searchParams.set("filter", "1");
  const genre = active.genre as TriStateFilterValue | string[] | undefined;
  const include = Array.isArray(genre) ? genre : (genre?.include ?? []);
  const exclude = Array.isArray(genre) ? [] : (genre?.exclude ?? []);
  if (include.length) url.searchParams.set("include", include.join("_"));
  if (exclude.length) url.searchParams.set("exclude", exclude.join("_"));
  url.searchParams.set("include_mode", "and");
  url.searchParams.set(
    "order",
    typeof active.order === "string" && active.order ? active.order : "latest",
  );
  if (typeof active.status === "string" && active.status)
    url.searchParams.set("status", active.status);
  url.searchParams.set("chapters", "1");
  return url.href;
}

const slugOf = (href: string) => href.match(/\/manga\/([^/?#]+)\/?$/)?.[1];

function cards($: CheerioAPI) {
  const rows = $("div#book_list > div.item")
    .toArray()
    .flatMap((el) => {
      // Catalogue cards nest the link in div.text; search results put it in h3.title.
      const link = $(el).find("div.text > h3 > a, h3.title > a").first();
      const id = slugOf(link.attr("href") ?? "");
      const title = normalizeText(link.text());
      return id && title
        ? [
            {
              id,
              slug: id,
              title,
              thumbnail_url: $(el).find("img").first().attr("src") ?? "",
            },
          ]
        : [];
    });
  if (rows.length) return rows;
  // A search with exactly one hit lands on that title's own page.
  const id = slugOf($('link[rel="canonical"]').attr("href") ?? "");
  const title = normalizeText($("h1.heading").first().text());
  return id && title
    ? [
        {
          id,
          slug: id,
          title,
          thumbnail_url: $("div.media div.cover img").attr("src") ?? "",
        },
      ]
    : [];
}

const hasFilters = (active: Record<string, FilterValue>) =>
  Object.entries(active).some(
    ([key, value]) =>
      key !== "search_by" &&
      (Array.isArray(value)
        ? value.length > 0
        : typeof value === "object" && value
          ? (value.include?.length ?? 0) + (value.exclude?.length ?? 0) > 0
          : Boolean(value)),
  );

export default createHtmlSite(manifest as SourceManifest, {
  // Slugs carry a numeric suffix after a dot ("one-piece.123"); chapters are "<slug>/c<n>".
  idPattern: /^[a-z0-9][a-z0-9-]*(?:\.\d+)?$/i,
  chapterKeyPattern: /^[a-z0-9][a-z0-9-]*(?:\.\d+)?\/c[\d.]+$/i,
  filters,
  catalogueUrl: (category, page, active) =>
    hasFilters(active)
      ? catalogue(page, active)
      : new URL(
          category === "latest" ? `/page/${page}` : `/manga/page/${page}`,
          manifest.base_url,
        ).href,
  searchUrl: (query, page, active) => {
    // The site answers a one-character search with a 404 page.
    if (query.length < 2) return null;
    const url = new URL(`/page/${page}`, manifest.base_url);
    url.searchParams.set("search", query);
    url.searchParams.set(
      "search_by",
      typeof active.search_by === "string" && active.search_by
        ? active.search_by
        : "book_name",
    );
    return url.href;
  },
  parseCards: ($) => cards($),
  titleUrl: (id) => `/manga/${id}`,
  parseDetails: ($) => {
    const alt = normalizeText($(".alt_name").text());
    return {
      title: normalizeText($("h1.heading").first().text()),
      author: $(".author")
        .map((_, el) => normalizeText($(el).text()))
        .get()
        .filter(Boolean),
      description: [
        normalizeText($(".summary > p").text()),
        alt && `Alternative names: ${alt}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
      status: mapMangaStatus($(".value.status").first().text()),
      genres: $(".genres > a")
        .map((_, el) => normalizeText($(el).text()))
        .get()
        .filter(Boolean),
      thumbnail_url: $("div.media div.cover img").first().attr("src") ?? "",
    };
  },
  parseChapters: ($) =>
    $("tr:has(.chapter)")
      .toArray()
      .flatMap((el) => {
        const link = $(el).find("a").first();
        const key = (link.attr("href") ?? "").match(
          /\/manga\/([^/]+\/c[\d.]+)/,
        )?.[1];
        const name = normalizeText(link.text());
        // Dates read "Oct-29-2026".
        const date = $(el)
          .find(".update_time")
          .first()
          .text()
          .trim()
          .replace(/-/g, " ");
        return key
          ? [
              {
                key,
                name,
                number: chapterNumberFromName(name, 0),
                date: parseDateToIso(date),
              },
            ]
          : [];
      }),
  chapterUrl: (key) => `/manga/${key}`,
  // The reader builds its pages from a script array: `data-src', <name>` names the array
  // and `var <name>=[...]` holds the URLs.
  parsePages: (_$, html) => {
    const name = html.match(/data-src['"],\s*(\w+)/)?.[1];
    if (!name) return [];
    const list =
      html.match(new RegExp(`var ${name}=\\[([^\\[]*)\\]`))?.[1] ?? "";
    return [...list.matchAll(/'([^']*)'/g)].map((match) => match[1]);
  },
});
