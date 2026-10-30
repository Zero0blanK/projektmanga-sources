// TCB Scans. Page shapes and selectors follow the Keiyoushi extension (Apache-2.0); see
// THIRD_PARTY_NOTICES.md.
import { createHtmlSite, lazyImage } from "../../lib/htmlSite.js";
import {
  MANGA_STATUS,
  chapterNumberFromName,
  normalizeText,
} from "../../lib/parse.js";
import type { SourceManifest } from "../../lib/types.js";
import manifest from "./manifest.json";

export default createHtmlSite(manifest as SourceManifest, {
  // Titles are /mangas/<number>/<slug>; chapters /chapters/<number>/<slug>.
  idPattern: /^\d+\/[a-z0-9-]+$/,
  chapterKeyPattern: /^\d+\/[a-z0-9-]+$/,
  // The whole catalogue is one page of projects, and the site has no search.
  catalogueUrl: (_category, page) =>
    page === 1 ? new URL("/projects", manifest.base_url).href : null,
  searchUrl: () => null,
  localSearch: true,
  parseCards: ($) =>
    $("div.bg-card")
      .toArray()
      .flatMap((el) => {
        const link = $(el).find("a[href].text-white").first();
        const id = (link.attr("href") ?? "").match(
          /\/mangas\/(\d+\/[a-z0-9-]+)/,
        )?.[1];
        const title = normalizeText(link.text());
        return id && title
          ? [
              {
                id,
                slug: id,
                title,
                thumbnail_url: lazyImage($(el).find("img").first()),
              },
            ]
          : [];
      }),
  titleUrl: (id) => `/mangas/${id}`,
  parseDetails: ($) => {
    const info = $("div.order-1").first();
    return {
      title: normalizeText(info.find("h1").first().text()),
      thumbnail_url: lazyImage(info.find("img").first()),
      description: normalizeText(info.find("p").first().text()),
      genres: [],
      // The site doesn't say; its projects are the series it is still translating.
      status: MANGA_STATUS.ONGOING,
    };
  },
  parseChapters: ($) =>
    $("div.grid a")
      .toArray()
      .flatMap((el) => {
        const link = $(el);
        const key = (link.attr("href") ?? "").match(
          /\/chapters\/(\d+\/[a-z0-9-]+)/,
        )?.[1];
        const heading = normalizeText(
          link.find("div.font-bold:not(.flex)").text(),
        );
        const subtitle = normalizeText(
          link.find(".text-gray-500").first().text(),
        );
        const number = chapterNumberFromName(heading, 0);
        const name = [number ? `Chapter ${number}` : heading, subtitle]
          .filter(Boolean)
          .join(": ");
        return key ? [{ key, name, number }] : [];
      }),
  chapterUrl: (key) => `/chapters/${key}`,
  parsePages: ($) =>
    $("picture img, .image-container img")
      .map((_, el) => lazyImage($(el)))
      .get(),
});
