// MangaRW (Japanese raws). URL shapes, the chapter API and selectors follow the Keiyoushi
// extension (Apache-2.0); see THIRD_PARTY_NOTICES.md.
import { createHtmlSite, lazyImage } from "../../lib/htmlSite.js";
import { MANGA_STATUS, chapterNumberFromName, normalizeText } from "../../lib/parse.js";
import type { SourceManifest } from "../../lib/types.js";
import manifest from "./manifest.json";

export default createHtmlSite(manifest as SourceManifest, {
  // Titles are /manga/<slug>/<number>; chapters are read by number (/read?id=<n>).
  idPattern: /^[^/?#\s]{1,200}\/\d{1,12}$/,
  chapterKeyPattern: /^\d{1,12}$/,
  rateLimitMs: 350,
  catalogueUrl: (category, page) =>
    new URL(category === "latest" ? `/browse?page=${page}` : `/?page=${page}`, manifest.base_url)
      .href,
  searchUrl: (query, page) => {
    const url = new URL("/browse", manifest.base_url);
    url.searchParams.set("page", String(page));
    url.searchParams.set("search", query);
    return url.href;
  },
  parseCards: ($) =>
    $("a[href^='/manga/']")
      .toArray()
      .flatMap((el) => {
        const href = $(el).attr("href") ?? "";
        const id = href.match(/^\/manga\/([^/?#]+\/\d+)$/)?.[1];
        const title = normalizeText($(el).attr("title") || $(el).text());
        return id && title
          ? [{ id: decodeURIComponent(id), slug: decodeURIComponent(id), title, thumbnail_url: lazyImage($(el).find("img").first()) }]
          : [];
      }),
  titleUrl: (id) => `/manga/${id.split("/").map(encodeURIComponent).join("/")}`,
  parseDetails: ($) => ({
    title: normalizeText($("h1").first().text()),
    thumbnail_url: $("img[src*=covers]").first().attr("src") ?? "",
    description: normalizeText($("div.description, p.synopsis").first().text()),
    // The title's own tags; the menus also link every genre.
    genres: $("div.flex.flex-wrap.gap-2 a[href*=genre]")
      .map((_, el) => normalizeText($(el).text()))
      .get()
      .filter(Boolean),
    status: MANGA_STATUS.UNKNOWN,
  }),
  // The title page names no chapters; the site's chapter API lists them as <option>s.
  parseChapters: () => [],
  chapterList: {
    url: (id) => new URL(`/api/v1/chapters?id=${id.split("/").pop()}`, manifest.base_url).href,
    parse: (body) =>
      [...body.matchAll(/<option[^>]*value="(\d+)"[^>]*>([^<]*)<\/option>/g)].flatMap(([, key, raw]) => {
        const name = normalizeText(raw);
        return name ? [{ key, name, number: chapterNumberFromName(name, 0) }] : [];
      }),
  },
  chapterUrl: (key) => `/read?id=${key}`,
  parsePages: ($) =>
    $("img[src*=mangabuzz], img[data-src*=mangabuzz]")
      .map((_, el) => lazyImage($(el)))
      .get(),
});
