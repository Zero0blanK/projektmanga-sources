// MangaCatalog engine: the network of single-franchise reader sites ("Read Chainsaw Man
// Manga Online", readberserk.com…). Each site reads a fixed handful of titles, so its
// catalogue is a list in the source itself, and a title page holds its details and every
// chapter. Page shapes follow Keiyoushi's lib-multisrc/mangacatalog (Apache-2.0); see
// THIRD_PARTY_NOTICES.md.
import { createHtmlSite, lazyImage } from "./htmlSite.js";
import {
  MANGA_STATUS,
  chapterNumberFromName,
  normalizeText,
  parseDateToIso,
} from "./parse.js";
import type { Source, SourceManifest } from "./types.js";

export interface MangaCatalogTitle {
  title: string;
  /** The title's slug: its page is `/manga/<slug>/`. */
  slug: string;
}

export interface MangaCatalogOptions {
  titles: MangaCatalogTitle[];
  /**
   * The site's page design: the Tailwind one most sites use (`"default"`), or the older
   * Bootstrap card with a chapter table (`"card"`, readberserk.com and readopm.com).
   */
  layout?: "default" | "card";
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,199}$/;
// Chapter slugs carry decimals ("chapter-139.5"), never "..".
const CHAPTER = /^[a-z0-9](?:[a-z0-9-]|\.(?!\.)){0,299}$/;

export function createMangaCatalogSite(
  manifest: SourceManifest,
  { titles, layout = "default" }: MangaCatalogOptions,
): Source {
  for (const entry of titles)
    if (!SLUG.test(entry.slug)) throw new Error(`Invalid title slug: ${entry.slug}`);
  const unique = [...new Map(titles.map((entry) => [entry.slug, entry])).values()];
  const chapterKey = (href: string | undefined, base: URL) => {
    if (!href) return null;
    try {
      const url = new URL(href.trim(), base);
      if (url.hostname !== base.hostname) return null;
      const key = url.pathname.match(/^\/chapter\/([^/]+)\/?$/)?.[1];
      return key && CHAPTER.test(key) ? key : null;
    } catch {
      return null;
    }
  };
  return createHtmlSite(manifest, {
    idPattern: SLUG,
    chapterKeyPattern: CHAPTER,
    // The titles are the source's own list: one page, searched locally.
    catalogueUrl: (_category, page) => (page === 1 ? "/" : null),
    searchUrl: () => null,
    localSearch: true,
    parseCards: () =>
      unique.map((entry) => ({
        id: entry.slug,
        slug: entry.slug,
        title: entry.title,
        thumbnail_url: "",
      })),
    titleUrl: (id) => `/manga/${id}/`,
    parseDetails: ($, id) => {
      const fallback = unique.find((entry) => entry.slug === id)?.title ?? id;
      if (layout === "card")
        return {
          title:
            normalizeText($("h2 > span").first().text()).replace(/^.*Manga:\s*/, "") ||
            fallback,
          thumbnail_url: lazyImage($(".card-img-right").first()),
          description: normalizeText($("div.card-body > p").text()),
          genres: [],
          status: MANGA_STATUS.UNKNOWN,
        };
      const info = normalizeText($("div.bg-bg-secondary > div.px-6 > div.flex-col").text());
      return {
        title: normalizeText($("div.container > h1").first().text()) || fallback,
        thumbnail_url: lazyImage($("div.flex > img").first()),
        description: info.includes("Description")
          ? info.slice(info.indexOf("Description") + "Description".length).trim()
          : info,
        genres: [],
        status: MANGA_STATUS.UNKNOWN,
      };
    },
    parseChapters: ($, _id, base) => {
      if (layout === "card")
        return $("tbody > tr")
          .toArray()
          .flatMap((row) => {
            const key = chapterKey(
              $(row).find("a.btn-primary").attr("href") ?? $(row).find("a").attr("href"),
              base,
            );
            const name = normalizeText($(row).find("td:first-child").text());
            const date = normalizeText($(row).find("td:nth-child(2)").text());
            return key
              ? [
                  {
                    key,
                    name,
                    number: chapterNumberFromName(name, -1),
                    ...(date ? { date: parseDateToIso(date) } : {}),
                  },
                ]
              : [];
          });
      return $("div.w-full div.bg-bg-secondary div.grid")
        .toArray()
        .flatMap((row) => {
          const link = $(row).find(".col-span-4 > a, .col-span-4 a").first();
          const key = chapterKey(link.attr("href"), base);
          const heading = normalizeText(link.text());
          const subtitle = normalizeText($(row).find("div.text-xs").first().text());
          return key
            ? [
                {
                  key,
                  name: [heading, subtitle].filter(Boolean).join(" - "),
                  number: chapterNumberFromName(heading, -1),
                },
              ]
            : [];
        });
    },
    chapterUrl: (key) => `/chapter/${key}/`,
    parsePages: ($) => {
      const lazy = $("img[data-src]")
        .map((_, el) => $(el).attr("data-src")?.trim() ?? "")
        .get()
        .filter(Boolean);
      if (lazy.length) return lazy;
      return $("img.js-page, div.pages img.pages__img, div.pages img")
        .map((_, el) => lazyImage($(el)))
        .get();
    },
  });
}
