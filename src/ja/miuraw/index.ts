// MiuRaw (Japanese raws). URL shapes, selectors and the site's image proxy follow the
// Keiyoushi extension (Apache-2.0); see THIRD_PARTY_NOTICES.md.
import { createHtmlSite } from "../../lib/htmlSite.js";
import {
  chapterNumberFromName,
  jaRelativeDateToIso,
  jaStatus,
  normalizeText,
} from "../../lib/parse.js";
import type { SourceManifest } from "../../lib/types.js";
import manifest from "./manifest.json";

const SUFFIX = / \(Raw – Free\)$/;
const slugOf = (href: string) => href.match(/\/manga\/([^/?#]+)\/?$/)?.[1];

/** Page images load through the site's own proxy, as its reader does. */
function proxied(url: string): string {
  if (!url || url.includes("img-proxy.php?url=")) return url;
  const proxy = new URL("/wp-content/themes/manga-theme-MangaVerse/img-proxy.php", manifest.base_url);
  proxy.searchParams.set("url", url);
  return proxy.href;
}

export default createHtmlSite(manifest as SourceManifest, {
  idPattern: /^[^/?#\s]{1,300}$/,
  chapterKeyPattern: /^[^?#\s]{1,500}$/,
  catalogueUrl: (category, page) =>
    new URL(
      `/manga/page/${page}/?orderby=${category === "latest" ? "date" : "views"}`,
      manifest.base_url,
    ).href,
  searchUrl: (query, page) => {
    const url = new URL(page > 1 ? `/page/${page}/` : "/", manifest.base_url);
    url.searchParams.set("s", query);
    url.searchParams.set("post_type", "manga");
    return url.href;
  },
  parseCards: ($) =>
    $(".manga-card")
      .toArray()
      .flatMap((el) => {
        const link = $(el).find("a.manga-card-thumb").first();
        const id = slugOf(link.attr("href") ?? "");
        const title = normalizeText($(el).find(".manga-card-title").first().text()).replace(SUFFIX, "");
        return id && title
          ? [{ id: decodeURIComponent(id), slug: decodeURIComponent(id), title, thumbnail_url: link.find("img").attr("src") ?? "" }]
          : [];
      }),
  titleUrl: (id) => `/manga/${encodeURIComponent(id)}/`,
  parseDetails: ($) => {
    const author = normalizeText($(".md-meta-row:has(.fa-user) .md-meta-val").text());
    return {
      title: normalizeText($(".md-title").first().text()).replace(SUFFIX, ""),
      author: author && author !== "更新中" ? [author] : [],
      status: jaStatus($(".md-meta-row:has(.fa-rss) .md-meta-val").first().text()),
      genres: $(".md-tag")
        .map((_, el) => normalizeText($(el).text()))
        .get()
        .filter(Boolean),
      description: normalizeText($(".md-desc-content").first().text()),
      thumbnail_url: $(".md-cover img").first().attr("src") ?? "",
    };
  },
  parseChapters: ($, _id, base) =>
    $(".md-chapter-row")
      .toArray()
      .flatMap((el) => {
        const link = $(el).find(".md-chapter-name a").first();
        const href = link.attr("href");
        if (!href) return [];
        const url = new URL(href, base);
        if (url.origin !== base.origin) return [];
        const name = normalizeText(link.contents().filter((_, node) => node.type === "text").text() || link.text());
        return [
          {
            key: decodeURIComponent(url.pathname.replace(/^\/+|\/+$/g, "")),
            name,
            number: chapterNumberFromName(name, 0),
            date: jaRelativeDateToIso($(el).find(".md-chapter-time").first().text()),
          },
        ];
      }),
  chapterUrl: (key) => `/${key.split("/").map(encodeURIComponent).join("/")}/`,
  parsePages: ($) =>
    $(".reader-page img")
      .map((_, el) => proxied($(el).attr("src") ?? ""))
      .get(),
});
