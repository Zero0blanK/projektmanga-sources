// Yiimanga: a manhwa-site theme (manhwa18tx.com, yaoiscan.me, 4porncomic.com…). Listing,
// search, details, chapter and reader selectors follow Keiyoushi's lib-multisrc/yiimanga
// (Apache-2.0); see THIRD_PARTY_NOTICES.md.
import type { CheerioAPI } from "cheerio/slim";
import { createHtmlSite } from "./htmlSite.js";
import {
  MANGA_STATUS,
  chapterNumberFromName,
  normalizeText,
  parseDateToIso,
} from "./parse.js";
import type { MangaFilter, Source, SourceManifest } from "./types.js";

export interface YiimangaOptions {
  /** The directory titles live under: `/manga/<slug>/`, `/comic/<slug>/`… */
  mangaPath: string;
  /** The search page's query parameter. */
  searchParam?: string;
  /** A listing the site sorts by views (`?order=views`); without one, popular is latest. */
  popularPath?: string;
}

const SEGMENT = /^[a-z0-9][a-z0-9-]{0,99}$/;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
// `<slug>/<chapter>`, the chapter's path under the title directory.
const CHAPTER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}\/[A-Za-z0-9](?:[A-Za-z0-9_-]|\.(?!\.)){0,199}$/;

export function createYiimangaSite(
  manifest: SourceManifest,
  filters: MangaFilter[],
  { mangaPath, searchParam = "s", popularPath }: YiimangaOptions,
): Source {
  for (const value of [mangaPath, ...(popularPath ? [popularPath] : [])])
    if (!SEGMENT.test(value)) throw new Error(`Invalid Yiimanga path: ${value}`);
  if (!/^[a-z]{1,20}$/.test(searchParam)) throw new Error(`Invalid search parameter: ${searchParam}`);
  const listPath = (page: number, ...segments: string[]) =>
    // A genre listing has no `/page/1/` (it answers 404); the others take it.
    segments[0] === "genre" && page === 1
      ? `/${segments.join("/")}/`
      : `/${[...segments, "page", String(page)].join("/")}/`;
  /** The path under the title directory, or null for any other link. */
  const underTitles = (href: string | undefined, base: URL) => {
    if (!href) return null;
    try {
      const url = new URL(href.trim(), base);
      if (url.hostname !== base.hostname) return null;
      const match = url.pathname.match(new RegExp(`^/${mangaPath}/(.+?)/?$`));
      // Search results can link `/site/detail/?slug=<slug>`, the same title.
      if (!match && url.pathname === "/site/detail/") return url.searchParams.get("slug");
      return match?.[1] ?? null;
    } catch {
      return null;
    }
  };
  /** A details row's value: `.main-info-list li > h5`, Madara-like `.summary-heading`, or
   * `.info-item > span.sh` headings followed by the value. */
  const info = ($: CheerioAPI, ...labels: string[]) => {
    const heading = $(".main-info-list li > h5, .post-content_item .summary-heading > h5, .info-item > span.sh")
      .toArray()
      .find((element) =>
        labels.includes($(element).text().trim().replace(/:$/, "").replace(/ -$/, "")),
      );
    if (!heading) return null;
    return $(heading)
      .closest("li, .post-content_item, .info-item")
      .children()
      .not("h5, .summary-heading, .sh")
      .first();
  };
  const names = ($: CheerioAPI, labels: string[]) => {
    const value = info($, ...labels);
    if (!value?.length) return [];
    const links = value.find("a");
    const list = links.length
      ? links.toArray().map((link) => normalizeText($(link).contents().filter((_, node) => node.type === "text").text()))
      : [normalizeText(value.text())];
    return list.flatMap((name) => name.split(/\s*,\s*/)).filter(Boolean);
  };
  return createHtmlSite(manifest, {
    idPattern: SLUG,
    chapterKeyPattern: CHAPTER,
    catalogueUrl: (category, page, active) => {
      const genre = typeof active.genre === "string" && SEGMENT.test(active.genre) ? active.genre : "";
      if (genre) return listPath(page, "genre", genre);
      if (category === "popular" && popularPath) return `${listPath(page, popularPath)}?order=views`;
      return listPath(page);
    },
    // A text search ignores the genre; a genre with no text is that genre's listing.
    searchUrl: (query, page, active) => {
      const genre = typeof active.genre === "string" && SEGMENT.test(active.genre) ? active.genre : "";
      if (!query && genre) return listPath(page, "genre", genre);
      return `/search/?${new URLSearchParams({ [searchParam]: query, page: String(page) })}`;
    },
    parseCards: ($, base) =>
      $(".latest-list .latest-item, .list .list-item")
        .toArray()
        .flatMap((element) => {
          const link = $(element).find(".latest-right a:has(h3, h4), .item-title a").first();
          const id = underTitles(link.attr("href"), base);
          const title = normalizeText(link.text());
          if (!id || !SLUG.test(id) || !title) return [];
          const image = $(element).find(".latest-left img, .item-img img").first().attr("src");
          return [
            {
              id,
              slug: id,
              title,
              thumbnail_url: image ? new URL(image.trim(), base).href : "",
            },
          ];
        }),
    titleUrl: (id) => `/${mangaPath}/${id}/`,
    parseDetails: ($, _id, base) => {
      const image = $("img.img-cover, .summary_image img, .manga-detail .poster img").first().attr("src");
      const status = normalizeText(
        (info($, "Status", "Estado") ?? $(".manga-detail .info p.type").first()).text(),
      ).toLowerCase();
      const block = $(".short-desc-content, .dsct, .description-summary").first();
      const paragraphs = block.find("p, li").toArray();
      const synopsis = (paragraphs.length ? paragraphs : block.toArray())
        .map((element) => normalizeText($(element).text()))
        .filter(Boolean)
        .join("\n\n");
      const alternative = normalizeText(
        (info($, "Alternative") ?? $(".main-info-list li > h4, .manga-detail .info h6").first()).text(),
      );
      return {
        title: normalizeText($("h1.main-info-title, .post-title h1, .manga-detail .info h1").first().text()),
        thumbnail_url: image ? new URL(image.trim(), base).href : "",
        author: names($, ["Author(s)", "Author", "Autores"]),
        artist: names($, ["Artist(s)", "Artist", "Artistas"]),
        genres: names($, ["Genres", "Genre(s)", "Géneros"]),
        status:
          status === "ongoing"
            ? MANGA_STATUS.ONGOING
            : status === "completed"
              ? MANGA_STATUS.COMPLETED
              : MANGA_STATUS.UNKNOWN,
        description: [synopsis, alternative && `Alternative names: ${alternative}`]
          .filter(Boolean)
          .join("\n\n"),
      };
    },
    parseChapters: ($, _id, base) =>
      $("ul.chapter-list li, ul.row-content-chapter li, .list-items li.item")
        .toArray()
        .flatMap((element) => {
          const key = underTitles($(element).find("a[href]").first().attr("href"), base);
          const name = normalizeText($(element).find(".chapter-name, .item a > span:first-child").first().text());
          const date = normalizeText($(element).find(".ct-update, .chapter-time, .item a > span:nth-child(2)").first().text());
          if (!key || !CHAPTER.test(key) || !name) return [];
          return [
            {
              key,
              name,
              number: chapterNumberFromName(name, -1),
              ...(date ? { date: parseDateToIso(date) } : {}),
            },
          ];
        }),
    chapterUrl: (key) => `/${mangaPath}/${key}/`,
    parsePages: ($, _html, base) =>
      $(".reading-content img, .read-content img")
        .map((_, element) => $(element).attr("src")?.trim() ?? "")
        .get()
        .filter(Boolean)
        .map((src) => new URL(src, base).href),
    filters,
  });
}
