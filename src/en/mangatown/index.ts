// MangaTown. URL shapes and selectors follow the Keiyoushi extension (Apache-2.0); see
// THIRD_PARTY_NOTICES.md. A webtoon chapter shows every image on one page; a manga chapter
// shows one image per page, so each page is read in turn.
import { load } from "cheerio/slim";
import { createHtmlSite, lazyImage } from "../../lib/htmlSite.js";
import { chapterNumberFromName, mapMangaStatus, normalizeText, parseDateToIso } from "../../lib/parse.js";
import type { SourceManifest } from "../../lib/types.js";
import manifest from "./manifest.json";

/** "Today", "Yesterday" or "Oct 29,2026". */
function chapterDate(raw: string): string {
  const text = raw.trim();
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  if (/today/i.test(text)) return day.toISOString();
  if (/yesterday/i.test(text)) {
    day.setUTCDate(day.getUTCDate() - 1);
    return day.toISOString();
  }
  return parseDateToIso(text.replace(",", ", "));
}

const slugOf = (href: string) => href.match(/\/manga\/([a-z0-9_]+)\/?$/)?.[1];

export default createHtmlSite(manifest as SourceManifest, {
  idPattern: /^[a-z0-9_]{1,200}$/,
  // "<slug>/c001" or "<slug>/v01/c001".
  chapterKeyPattern: /^[a-z0-9_]{1,200}(?:\/v[\w.]{1,10})?\/c[\d.]{1,10}$/,
  rateLimitMs: 350,
  catalogueUrl: (category, page) =>
    new URL(
      category === "latest" ? `/latest/${page}.htm` : `/directory/0-0-0-0-0-0/${page}.htm`,
      manifest.base_url,
    ).href,
  searchUrl: (query, page) => {
    const url = new URL("/search", manifest.base_url);
    url.searchParams.set("page", String(page));
    url.searchParams.set("name", query);
    return url.href;
  },
  parseCards: ($) =>
    $("li:has(a.manga_cover)")
      .toArray()
      .flatMap((el) => {
        const link = $(el).find("p.title a").first();
        const id = slugOf(link.attr("href") ?? "");
        const title = normalizeText(link.attr("title") || link.text());
        return id && title
          ? [{ id, slug: id, title, thumbnail_url: lazyImage($(el).find("img").first()) }]
          : [];
      }),
  titleUrl: (id) => `/manga/${id}/`,
  parseDetails: ($) => {
    const info = $("div.article_content").first();
    const field = (label: string) =>
      info
        .find("li")
        .filter((_, el) => new RegExp(`^${label}`, "i").test($(el).find("b").first().text().trim()));
    const licensed = info.find("div.chapter_content:contains(has been licensed)").length > 0;
    return {
      title: normalizeText(info.find("h1").first().text()),
      author: field("author").find("a").map((_, el) => normalizeText($(el).text())).get(),
      artist: field("artist").find("a").map((_, el) => normalizeText($(el).text())).get(),
      genres: field("genre").find("a").map((_, el) => normalizeText($(el).text())).get(),
      status: mapMangaStatus(field("status").text()),
      description: [
        normalizeText($("span#show").first().text().replace(/HIDE$/, "")),
        licensed ? "Licensed: MangaTown has removed this title's chapters." : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      thumbnail_url: lazyImage($("div.detail_info img").first()),
    };
  },
  parseChapters: ($) =>
    $("ul.chapter_list li")
      .toArray()
      .flatMap((el) => {
        const link = $(el).find("a").first();
        const key = (link.attr("href") ?? "").match(
          /\/manga\/([a-z0-9_]+(?:\/v[\w.]+)?\/c[\d.]+)\/?$/,
        )?.[1];
        const extra = $(el)
          .find("span:not(.time):not(.new)")
          .map((_, span) => normalizeText($(span).text()))
          .get()
          .join(" ");
        const name = normalizeText(`${link.text()} ${extra}`);
        return key
          ? [
              {
                key,
                name,
                number: chapterNumberFromName(name, Number(key.match(/c([\d.]+)$/)?.[1] ?? 0)),
                date: chapterDate($(el).find("span.time").text()),
              },
            ]
          : [];
      }),
  chapterUrl: (key) => `/manga/${key}/`,
  parsePages: async ($, _html, base, fetchText) => {
    const pages = $("select#top_chapter_list ~ div.page_select option")
      .toArray()
      .filter((el) => !/featured/i.test($(el).text()))
      .map((el) => $(el).attr("value") ?? "")
      .filter(Boolean);
    if (pages.length === 0)
      return $("div#viewer img").map((_, el) => lazyImage($(el))).get();
    const images: string[] = [];
    for (const page of pages) {
      const doc = load(await fetchText(new URL(page, base).href));
      const src = lazyImage(doc("div#viewer img").first());
      if (src) images.push(src);
    }
    return images;
  },
});
