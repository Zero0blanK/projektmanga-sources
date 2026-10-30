// MangaPill. URL shapes and selectors follow the Keiyoushi extension (Apache-2.0); see
// THIRD_PARTY_NOTICES.md.
import { createHtmlSite, lazyImage } from "../../lib/htmlSite.js";
import {
  chapterNumberFromName,
  mapMangaStatus,
  normalizeText,
} from "../../lib/parse.js";
import type {
  FilterValue,
  MangaFilter,
  SourceManifest,
} from "../../lib/types.js";
import manifest from "./manifest.json";

const GENRES = [
  "Action",
  "Adventure",
  "Cars",
  "Comedy",
  "Dementia",
  "Demons",
  "Drama",
  "Ecchi",
  "Fantasy",
  "Game",
  "Harem",
  "Hentai",
  "Historical",
  "Horror",
  "Josei",
  "Kids",
  "Magic",
  "Martial Arts",
  "Mecha",
  "Military",
  "Music",
  "Mystery",
  "Parody",
  "Police",
  "Psychological",
  "Romance",
  "Samurai",
  "School",
  "Sci-Fi",
  "Seinen",
  "Shoujo",
  "Shoujo Ai",
  "Shounen",
  "Shounen Ai",
  "Slice of Life",
  "Space",
  "Sports",
  "Super Power",
  "Supernatural",
  "Thriller",
  "Vampire",
  "Yaoi",
  "Yuri",
];

const filters: MangaFilter[] = [
  {
    label: "Type",
    value: "type",
    type: "select",
    options: [
      ["All", ""],
      ["Manga", "manga"],
      ["Novel", "novel"],
      ["One-Shot", "one-shot"],
      ["Doujinshi", "doujinshi"],
      ["Manhwa", "manhwa"],
      ["Manhua", "manhua"],
      ["OEL", "oel"],
    ].map(([label, value]) => ({ label, value })),
  },
  {
    label: "Status",
    value: "status",
    type: "select",
    options: [
      ["All", ""],
      ["Publishing", "publishing"],
      ["Finished", "finished"],
      ["On hiatus", "on hiatus"],
      ["Discontinued", "discontinued"],
      ["Not yet published", "not yet published"],
    ].map(([label, value]) => ({ label, value })),
  },
  {
    label: "Genres",
    value: "genre",
    type: "multi",
    options: GENRES.map((genre) => ({ label: genre, value: genre })),
  },
];

/** The site's search, which is also its full, filterable catalogue. */
function searchUrl(
  query: string,
  page: number,
  active: Record<string, FilterValue>,
) {
  const url = new URL("/search", manifest.base_url);
  url.searchParams.set("q", query);
  url.searchParams.set("page", String(page));
  for (const key of ["type", "status"])
    if (typeof active[key] === "string" && active[key])
      url.searchParams.set(key, active[key]);
  if (Array.isArray(active.genre))
    for (const genre of active.genre) url.searchParams.append("genre", genre);
  return url.href;
}

export default createHtmlSite(manifest as SourceManifest, {
  // Titles are /manga/<number>/<slug>; chapters /chapters/<number-number>/<slug>.
  idPattern: /^\d+\/[a-z0-9-]+$/,
  chapterKeyPattern: /^\d+-\d+\/[a-z0-9-]+$/,
  filters,
  // The site's search lists nothing without a query or a filter. Unfiltered, "latest" is
  // the recent-chapters feed and "popular" the homepage's trending titles (one page).
  catalogueUrl: (category, page, active) => {
    const filtered = Object.values(active).some((value) =>
      Array.isArray(value) ? value.length > 0 : Boolean(value),
    );
    if (filtered) return searchUrl("", page, active);
    if (category === "latest")
      return new URL(`/chapters?page=${page}`, manifest.base_url).href;
    return page === 1 ? new URL("/", manifest.base_url).href : null;
  },
  searchUrl,
  parseCards: ($) =>
    $(".grid > div:not([class])")
      .toArray()
      .flatMap((el) => {
        const card = $(el);
        const href = card.find("a[href^='/manga/']").first().attr("href") ?? "";
        const id = href.match(/^\/manga\/(\d+\/[a-z0-9-]+)/)?.[1];
        const title = normalizeText(
          card.find("div.line-clamp-2").first().text(),
        );
        return id && title
          ? [
              {
                id,
                slug: id,
                title,
                thumbnail_url: lazyImage(card.find("img").first()),
              },
            ]
          : [];
      }),
  titleUrl: (id) => `/manga/${id}`,
  parseDetails: ($) => {
    const side = $("div.container > div:first-child");
    return {
      title: normalizeText($("h1").first().text()),
      thumbnail_url: lazyImage(side.find("img").first()),
      description: normalizeText(
        $(
          "div.container > div:first-child > div:last-child > div:nth-child(2) > p",
        ).text(),
      ),
      genres: $("a[href*=genre]")
        .map((_, el) => normalizeText($(el).text()))
        .get()
        .filter(Boolean),
      status: mapMangaStatus(
        $("label:contains(Status) + div, div:contains(Status) > div")
          .first()
          .text()
          .replace(/publishing/i, "ongoing")
          .replace(/finished/i, "completed"),
      ),
    };
  },
  parseChapters: ($) =>
    $("#chapters > div > a")
      .toArray()
      .flatMap((el) => {
        const link = $(el);
        const key = (link.attr("href") ?? "").match(
          /^\/chapters\/(\d+-\d+\/[a-z0-9-]+)/,
        )?.[1];
        const name = normalizeText(link.text());
        return key
          ? [{ key, name, number: chapterNumberFromName(name, 0) }]
          : [];
      }),
  chapterUrl: (key) => `/chapters/${key}`,
  parsePages: ($) =>
    $("picture img")
      .map((_, el) => lazyImage($(el)))
      .get(),
});
