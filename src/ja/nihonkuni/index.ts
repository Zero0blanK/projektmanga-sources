// NihonKuni (MangaGun, Japanese raws), an FMReader-theme site. URL shapes and selectors
// follow the Keiyoushi "mangagun" extension and its "fmreader" library (Apache-2.0); see
// THIRD_PARTY_NOTICES.md.
import type { CheerioAPI } from "cheerio/slim";
import { createHtmlSite, lazyImage } from "../../lib/htmlSite.js";
import { chapterNumberFromName, mapMangaStatus, normalizeText, parseDateToIso } from "../../lib/parse.js";
import type { SourceManifest } from "../../lib/types.js";
import manifest from "./manifest.json";

// The site only answers list requests that carry every one of its form's parameters.
const list = (page: number, sort: string, name = "") => {
  const url = new URL("/manga-list.html", manifest.base_url);
  url.searchParams.set("listType", "pagination");
  url.searchParams.set("page", String(page));
  for (const key of ["artist", "author", "group", "m_status"]) url.searchParams.set(key, "");
  url.searchParams.set("name", name);
  for (const key of ["genre", "ungenre", "magazine"]) url.searchParams.set(key, "");
  url.searchParams.set("sort", sort);
  url.searchParams.set("sort_type", "DESC");
  return url.href;
};

/** The heading's title, which the page sends base64-encoded and fills in with a script. */
function decodeTitle(encoded: string | undefined): string {
  if (!encoded || !/^[A-Za-z0-9+/=]+$/.test(encoded)) return "";
  try {
    return normalizeText(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    return "";
  }
}

/** The covers are CSS backgrounds: `url('<cover>'), url('<placeholder>')`. */
const backgroundImage = (style: string | undefined) => style?.match(/url\(\s*['"]?([^'")]+)['"]?\s*\)/)?.[1] ?? "";

const field = ($: CheerioAPI, label: string) =>
  $(".manga-info-list > li").filter((_, el) => normalizeText($(el).find(".info-field-label").text()) === label);

export default createHtmlSite(manifest as SourceManifest, {
  // Titles are /manga-<slug>.html; chapters /read-<slug>-chapter-<n>.html.
  idPattern: /^[a-z0-9][a-z0-9-]{0,199}$/i,
  chapterKeyPattern: /^[a-z0-9][a-z0-9.-]{0,299}$/i,
  rateLimitMs: 500,
  catalogueUrl: (category, page) => list(page, category === "latest" ? "last_update" : "views"),
  searchUrl: (query, page) => list(page, "views", query),
  parseCards: ($) =>
    $("div.manga-grid div.manga-card")
      .toArray()
      .flatMap((el) => {
        const link = $(el).find(".manga-title").first();
        const id = (link.attr("href") ?? "").match(/^\/?manga-([a-z0-9-]+)\.html$/i)?.[1];
        const title = normalizeText(link.text());
        return id && title
          ? [{ id, slug: id, title, thumbnail_url: backgroundImage($(el).find(".manga-cover").attr("style")) }]
          : [];
      }),
  titleUrl: (id) => `/manga-${id}.html`,
  parseDetails: ($) => {
    const cover = $("div.manga-detail-container img.manga-cover-image").first();
    const other = normalizeText(field($, "Other names").find(".info-field-value").text());
    return {
      title: normalizeText(cover.attr("alt") ?? "") || decodeTitle($("h1.manga-main-title").attr("data-enc")),
      author: field($, "Author(s)")
        .find("a")
        .map((_, el) => normalizeText($(el).text()))
        .get()
        .filter((name) => name && name.toLowerCase() !== "updating"),
      genres: field($, "Genre(s)")
        .find("a")
        .map((_, el) => normalizeText($(el).text()))
        .get()
        .filter(Boolean),
      status: mapMangaStatus(normalizeText(field($, "Status").text()).toLowerCase().replace(/\s+/g, "")),
      thumbnail_url: lazyImage(cover),
      description: [
        normalizeText($(".description-text-content").first().text()),
        other ? `Alternative names: ${other}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    };
  },
  parseChapters: ($, id) => {
    const seen = new Set<string>();
    return $(`a[href^='read-${id}-']:has(.chapter-name), a[href^='/read-${id}-']:has(.chapter-name)`)
      .toArray()
      .flatMap((el) => {
        const key = ($(el).attr("href") ?? "").match(/^\/?(read-[a-z0-9.-]+)\.html$/i)?.[1];
        if (!key || seen.has(key)) return [];
        seen.add(key);
        const name = normalizeText($(el).find(".chapter-name").text());
        return [
          {
            key,
            name,
            number: chapterNumberFromName(name, 0),
            date: parseDateToIso(normalizeText($(el).attr("data-time") ?? "")),
          },
        ];
      });
  },
  chapterUrl: (key) => `/${key}.html`,
  parsePages: ($) =>
    $("img.chapter-img[id^=page]")
      .map((_, el) => lazyImage($(el)))
      .get(),
});
