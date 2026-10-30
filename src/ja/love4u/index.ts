// Love4u (WeLoveManga, Japanese raws), an FMReader-theme site. URL shapes and selectors
// follow the Keiyoushi extension and its "fmreader" library (Apache-2.0); see
// THIRD_PARTY_NOTICES.md.
import { createHtmlSite, lazyImage } from "../../lib/htmlSite.js";
import { chapterNumberFromName, mapMangaStatus, normalizeText, parseDateToIso } from "../../lib/parse.js";
import type { SourceManifest } from "../../lib/types.js";
import manifest from "./manifest.json";

const list = (page: number, params: Record<string, string>) => {
  const url = new URL("/manga-list.html", manifest.base_url);
  url.searchParams.set("listType", "pagination");
  url.searchParams.set("page", String(page));
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set("sort_type", "DESC");
  return url.href;
};

/** The title, which the page sends base64-encoded and fills in with a script. */
function decodeTitle(encoded: string | undefined): string {
  if (!encoded || !/^[A-Za-z0-9+/=]+$/.test(encoded)) return "";
  try {
    return normalizeText(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    return "";
  }
}

export default createHtmlSite(manifest as SourceManifest, {
  // Titles are /manga-<id>/; chapters /manga-<id>/<slug>.<chapter id>.html.
  idPattern: /^\d{1,12}$/,
  chapterKeyPattern: /^manga-\d{1,12}\/[a-z0-9][a-z0-9.-]{0,299}$/i,
  rateLimitMs: 500,
  catalogueUrl: (category, page) => list(page, { sort: category === "latest" ? "last_update" : "views" }),
  searchUrl: (query, page) => list(page, { name: query, sort: "views" }),
  parseCards: ($) =>
    $(".thumb-item-flow")
      .toArray()
      .flatMap((el) => {
        const link = $(el).find(".series-title a, h3 a").first();
        const id = (link.attr("href") ?? "").match(/^\/manga-(\d+)\/?$/)?.[1];
        const title = normalizeText(link.attr("title") || link.text());
        return id && title
          ? [{ id, slug: id, title, thumbnail_url: $(el).find(".img-in-ratio").attr("data-bg") || lazyImage($(el).find("img").first()) }]
          : [];
      }),
  titleUrl: (id) => `/manga-${id}/`,
  parseDetails: ($) => {
    const info = $("div.row").first();
    const other = normalizeText($("li:contains(Other names)").first().text()).replace(/^Other names\s*:\s*/, "");
    const status = normalizeText(info.find("li a.btn-success").first().text()).toLowerCase().replace(/\s+/g, "");
    return {
      // The breadcrumb keeps the title's own casing; the heading's copy is upper-cased.
      title:
        normalizeText($("ol.breadcrumb li.active").last().text()) ||
        decodeTitle($(".manga-info h3, .manga-info h1").first().attr("data-enc")),
      author: info
        .find("li a.btn-info")
        .map((_, el) => normalizeText($(el).text()))
        .get()
        .filter((name) => name && name.toLowerCase() !== "updating"),
      genres: info
        .find("li a.btn-danger")
        .map((_, el) => normalizeText($(el).text()))
        .get()
        .filter(Boolean),
      status: mapMangaStatus(status),
      thumbnail_url: lazyImage(info.find("img.thumbnail").first()),
      description: [
        normalizeText($("div.detail .content, div.row ~ div.row:has(h3:first-child) p, .summary-content p").text()),
        other ? `Alternative names: ${other.replace(/\\'/g, "'")}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    };
  },
  parseChapters: ($, id) =>
    $(`a[href^='/manga-${id}/']:has(.chapter-name)`)
      .toArray()
      .flatMap((el) => {
        const key = ($(el).attr("href") ?? "").match(/^\/(manga-\d+\/[^/?#]+)\.html$/)?.[1];
        const name = normalizeText($(el).find(".chapter-name").text() || $(el).attr("title") || "");
        return key
          ? [
              {
                key,
                name,
                number: chapterNumberFromName(name, 0),
                date: parseDateToIso(normalizeText($(el).find(".chapter-time").text())),
              },
            ]
          : [];
      }),
  chapterUrl: (key) => `/${key}.html`,
  parsePages: ($) =>
    $("img.chapter-img")
      .map((_, el) => lazyImage($(el)))
      .get(),
});
