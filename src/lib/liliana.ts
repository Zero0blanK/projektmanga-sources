// Liliana: a manga-site design used by several raw and aggregator sites. Catalogue paths,
// selectors and the image-list endpoint follow the Keiyoushi "liliana" library
// (Apache-2.0); see THIRD_PARTY_NOTICES.md.
import { load } from "cheerio/slim";
import { createHtmlSite, lazyImage } from "./htmlSite.js";
import { MANGA_STATUS, chapterNumberFromName, normalizeText } from "./parse.js";
import type { SourceManifest } from "./types.js";

const STATUS: Record<string, string> = {
  ongoing: MANGA_STATUS.ONGOING,
  進行中: MANGA_STATUS.ONGOING,
  completed: MANGA_STATUS.COMPLETED,
  完了: MANGA_STATUS.COMPLETED,
  "on-hold": MANGA_STATUS.HIATUS,
  保留: MANGA_STATUS.HIATUS,
  canceled: MANGA_STATUS.CANCELLED,
  キャンセル: MANGA_STATUS.CANCELLED,
};

const slugOf = (href: string) => href.match(/\/manga\/([^/?#]+)\/?$/)?.[1];

export function createLilianaSite(manifest: SourceManifest) {
  const base = manifest.base_url;
  return createHtmlSite(manifest, {
    idPattern: /^[^/?#\s]{1,200}$/,
    chapterKeyPattern: /^[^/?#\s]{1,200}\/[^/?#\s]{1,200}$/,
    catalogueUrl: (category, page) =>
      new URL(
        category === "latest" ? `/all-manga/${page}/?sort=last_update&status=0` : `/ranking/week/${page}`,
        base,
      ).href,
    searchUrl: (query, page) => {
      const url = new URL(`/search/${page}/`, base);
      url.searchParams.set("keyword", query);
      return url.href;
    },
    parseCards: ($) =>
      $("div#main div.grid > div")
        .toArray()
        .flatMap((el) => {
          const link = $(el).find(".text-center a").first();
          const id = slugOf(link.attr("href") ?? "");
          const title = normalizeText(link.text());
          return id && title
            ? [{ id: decodeURIComponent(id), slug: decodeURIComponent(id), title, thumbnail_url: lazyImage($(el).find("img").first()) }]
            : [];
        }),
    titleUrl: (id) => `/manga/${encodeURIComponent(id)}`,
    parseDetails: ($) => {
      const author = normalizeText($("div.y6x11p i.fas.fa-user + span.dt").first().text());
      const status = normalizeText($("div.y6x11p i.fas.fa-rss + span.dt").first().text()).toLowerCase();
      return {
        title: normalizeText($(".a2 header h1").first().text()),
        description: normalizeText($("div#syn-target").first().text()),
        thumbnail_url: lazyImage($(".a1 > figure img").first()),
        genres: $(".a2 div > a[rel='tag'].label")
          .map((_, el) => normalizeText($(el).text()))
          .get()
          .filter(Boolean),
        author: author && !/updating/i.test(author) ? [author] : [],
        status: STATUS[status] ?? MANGA_STATUS.UNKNOWN,
      };
    },
    parseChapters: ($) =>
      $("ul > li.chapter")
        .toArray()
        .flatMap((el) => {
          const link = $(el).find("a").first();
          const key = (link.attr("href") ?? "").match(/\/manga\/([^/?#]+\/[^/?#]+)\/?$/)?.[1];
          const name = normalizeText(link.text());
          const seconds = Number($(el).find("time[datetime]").attr("datetime"));
          return key
            ? [
                {
                  key: decodeURIComponent(key),
                  name,
                  number: chapterNumberFromName(name, 0),
                  date: Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : "",
                },
              ]
            : [];
        }),
    chapterUrl: (key) => `/manga/${key.split("/").map(encodeURIComponent).join("/")}`,
    // The reader loads its images from an endpoint keyed by the chapter's id, stated in a
    // script on the chapter page.
    parsePages: async (_$, html, origin, fetchText, chapterUrl) => {
      const id = html.match(/const CHAPTER_ID\s*=\s*(\d+);/)?.[1];
      if (!id) return [];
      const body = await fetchText(new URL(`/ajax/image/list/chap/${id}`, origin).href, {
        Accept: "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        Referer: chapterUrl,
      });
      let data: { status?: boolean; html?: string };
      try {
        data = JSON.parse(body);
      } catch {
        return [];
      }
      if (!data.status || !data.html) return [];
      const $ = load(data.html);
      const separators = $("div.separator").toArray();
      const indexed = separators.some((el) => $(el).attr("data-index") !== undefined);
      return separators
        .map((el) => ({
          index: Number($(el).attr("data-index") ?? 0),
          url: $(el).find("a").first().attr("href") ?? "",
        }))
        .filter(({ url }) => url && !/\.svg(?:$|[?#])/i.test(url) && !/loading_comments/i.test(url))
        .sort((a, b) => (indexed ? a.index - b.index : 0))
        .map(({ url }) => url);
    },
  });
}
