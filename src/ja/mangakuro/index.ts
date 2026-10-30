// MangaKuro (Japanese raws). URL shapes, selectors and the image-list endpoint follow the
// Keiyoushi extension (Apache-2.0); see THIRD_PARTY_NOTICES.md.
import { load } from "cheerio/slim";
import { createHtmlSite, lazyImage } from "../../lib/htmlSite.js";
import { MANGA_STATUS, chapterNumberFromName, normalizeText } from "../../lib/parse.js";
import type { SourceManifest } from "../../lib/types.js";
import manifest from "./manifest.json";

const STATUS: Array<[string, string]> = [
  ["進行中", MANGA_STATUS.ONGOING],
  ["完了", MANGA_STATUS.COMPLETED],
  ["保留", MANGA_STATUS.HIATUS],
  ["キャンセル", MANGA_STATUS.CANCELLED],
];

/** "昨日", "3時間前", "2日前"… */
function kuroDate(raw: string): string {
  const text = raw.trim();
  const date = new Date();
  if (text.includes("昨日")) {
    date.setDate(date.getDate() - 1);
    return date.toISOString();
  }
  const amount = Number(text.match(/(\d+)/)?.[1]);
  if (!Number.isFinite(amount)) return "";
  if (text.includes("秒")) date.setSeconds(date.getSeconds() - amount);
  else if (text.includes("分")) date.setMinutes(date.getMinutes() - amount);
  else if (text.includes("時")) date.setHours(date.getHours() - amount);
  else if (text.includes("日")) date.setDate(date.getDate() - amount);
  else if (text.includes("週")) date.setDate(date.getDate() - amount * 7);
  else if (text.includes("月")) date.setMonth(date.getMonth() - amount);
  else if (text.includes("年")) date.setFullYear(date.getFullYear() - amount);
  else return "";
  return date.toISOString();
}

const list = (path: string, page: number, key: string, value: string) => {
  const url = new URL(`/${path}/${page}`, manifest.base_url);
  url.searchParams.set(key, value);
  return url.href;
};

export default createHtmlSite(manifest as SourceManifest, {
  idPattern: /^[a-z0-9][a-z0-9-]{0,199}$/i,
  chapterKeyPattern: /^[a-z0-9][a-z0-9-]{0,199}\/[^/?#\s]{1,200}$/i,
  catalogueUrl: (category, page) =>
    list("all-manga", page, "sort", category === "latest" ? "latest-updated" : "views"),
  searchUrl: (query, page) => list("search", page, "keyword", query),
  parseCards: ($) =>
    $("div.story_item")
      .toArray()
      .flatMap((el) => {
        const link = $(el).find("div.mg_name a").first();
        const id = (link.attr("href") ?? "").match(/\/manga\/([^/?#]+)\/?$/)?.[1];
        const title = normalizeText(link.text());
        return id && title
          ? [{ id, slug: id, title, thumbnail_url: lazyImage($(el).find("img").first()) }]
          : [];
      }),
  titleUrl: (id) => `/manga/${id}`,
  parseDetails: ($) => {
    const status = $("div:has(.lnr-leaf) + .info_value").first().text();
    return {
      title: normalizeText($("div.detail_name > h1").first().text()),
      author: $("div:has(.lnr-user) + .info_value a[href*='/authors/']")
        .map((_, el) => normalizeText($(el).text()))
        .get()
        .filter((name) => name && name !== "未詳" && name !== "不明"),
      status: STATUS.find(([word]) => status.includes(word))?.[1] ?? MANGA_STATUS.UNKNOWN,
      genres: [
        ...new Set(
          $("div.detail_listInfo a.genres-el")
            .map((_, el) => normalizeText($(el).text()))
            .get()
            .filter(Boolean),
        ),
      ],
      description: normalizeText($(".detail_reviewContent").first().text()),
      thumbnail_url: lazyImage($(".detail_avatar img").first()),
    };
  },
  parseChapters: ($) =>
    $("div.chapter_box .item")
      .toArray()
      .flatMap((el) => {
        const link = $(el).find("a.chapter_num").first();
        const key = decodeURIComponent(
          (link.attr("href") ?? "").match(/\/manga\/([^/?#]+\/[^/?#]+)\/?$/)?.[1] ?? "",
        );
        const name = normalizeText(link.text()).replace(/^#\s*/, "");
        return key
          ? [
              {
                key,
                name,
                number: chapterNumberFromName(name, 0),
                date: kuroDate($(el).find("p.chapter_info").eq(1).text()),
              },
            ]
          : [];
      }),
  chapterUrl: (key) => `/manga/${key.split("/").map(encodeURIComponent).join("/")}`,
  // The reader loads its images from an endpoint keyed by the chapter's id, which a
  // script on the chapter page states.
  parsePages: async (_$, html, base, fetchText, chapterUrl) => {
    const id = html.match(/CHAPTER_ID\s*=\s*(\d+);/)?.[1];
    if (!id) return [];
    const body = await fetchText(new URL(`/ajax/image/list/chap/${id}`, base).href, {
      "X-Requested-With": "XMLHttpRequest",
      Referer: chapterUrl,
      Accept: "application/json",
    });
    let data: { status?: boolean; html?: string };
    try {
      data = JSON.parse(body);
    } catch {
      return [];
    }
    if (!data.status || !data.html) return [];
    const $ = load(data.html);
    return $("div.image_story img")
      .map((_, el) => lazyImage($(el)))
      .get();
  },
});
