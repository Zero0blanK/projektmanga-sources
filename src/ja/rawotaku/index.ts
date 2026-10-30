// RawOtaku (Japanese raws), a "MangaReader" theme site. URL shapes, selectors and the
// chapter image endpoint follow the Keiyoushi extension and its "mangareader" library
// (Apache-2.0); see THIRD_PARTY_NOTICES.md.
import { load } from "cheerio/slim";
import { createHtmlSite, lazyImage } from "../../lib/htmlSite.js";
import { MANGA_STATUS, chapterNumberFromName, normalizeText } from "../../lib/parse.js";
import type { SourceManifest } from "../../lib/types.js";
import manifest from "./manifest.json";

const STATUS: Record<string, string> = {
  ongoing: MANGA_STATUS.ONGOING,
  publishing: MANGA_STATUS.ONGOING,
  releasing: MANGA_STATUS.ONGOING,
  completed: MANGA_STATUS.COMPLETED,
  finished: MANGA_STATUS.COMPLETED,
  "on-hold": MANGA_STATUS.HIATUS,
  on_hiatus: MANGA_STATUS.HIATUS,
  canceled: MANGA_STATUS.CANCELLED,
  discontinued: MANGA_STATUS.CANCELLED,
};

const SORTS = [
  { label: "Default", value: "" },
  { label: "Latest update", value: "latest-updated" },
  { label: "Most viewed", value: "most-viewed" },
  { label: "Title A–Z", value: "title-az" },
  { label: "Title Z–A", value: "title-za" },
];

/** The path after /read/, from a link on the site. */
const readPath = (href: string) => {
  try {
    const url = new URL(href, manifest.base_url);
    if (url.origin !== new URL(manifest.base_url).origin) return "";
    return decodeURIComponent(url.pathname.match(/^\/read\/(.+?)\/?$/)?.[1] ?? "");
  } catch {
    return "";
  }
};
const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

const filterUrl = (page: number, sort: string) => {
  const url = new URL("/filter/", manifest.base_url);
  url.searchParams.set("sort", sort);
  url.searchParams.set("p", String(page));
  return url.href;
};

export default createHtmlSite(manifest as SourceManifest, {
  idPattern: /^[^/?#\s]{1,200}$/,
  // A chapter key is the reader's id (which the image endpoint needs and the reader page
  // doesn't state) followed by the reader path: "<id>/<title>/ja/<chapter>".
  chapterKeyPattern: /^\d{1,12}\/[^/?#\s]{1,200}\/[a-z]{2}\/[^/?#\s]{1,200}$/,
  rateLimitMs: 500,
  catalogueUrl: (category, page, filters) =>
    filterUrl(
      page,
      typeof filters.sort === "string" && filters.sort && SORTS.some((sort) => sort.value === filters.sort)
        ? filters.sort
        : category === "latest"
          ? "latest-updated"
          : "most-viewed",
    ),
  searchUrl: (query, page) => {
    const url = new URL("/", manifest.base_url);
    url.searchParams.set("q", query);
    url.searchParams.set("p", String(page));
    return url.href;
  },
  parseCards: ($) =>
    $(".manga_list-sbs .manga-poster")
      .toArray()
      .flatMap((el) => {
        const id = readPath($(el).attr("href") ?? "");
        const image = $(el).find("img").first();
        const title = normalizeText(image.attr("alt") ?? "");
        return id && !id.includes("/") && title
          ? [{ id, slug: id, title, thumbnail_url: lazyImage(image) }]
          : [];
      }),
  titleUrl: (id) => `/read/${encodeURIComponent(id)}/`,
  parseDetails: ($) => {
    const root = $("#ani_detail");
    const title = normalizeText(root.find(".manga-name").first().text());
    const alt = normalizeText(root.find(".manga-name-or").first().text());
    const item = (head: string) =>
      root.find(".anisc-info > .item").filter((_, el) => normalizeText($(el).find(".item-head").text()) === head);
    const status = normalizeText(item("地位:").find(".name").first().text()).toLowerCase();
    return {
      title,
      thumbnail_url: lazyImage(root.find("img").first()),
      genres: root
        .find(".genres > a")
        .map((_, el) => normalizeText($(el).text()))
        .get()
        .filter(Boolean),
      author: item("著者:")
        .find("a")
        .map((_, el) => normalizeText($(el).text()).replace(/,/g, ""))
        .get()
        .filter(Boolean),
      status: STATUS[status] ?? MANGA_STATUS.UNKNOWN,
      description: [
        normalizeText(root.find(".description").first().text()),
        alt && alt !== title ? `Alternative Title: ${alt}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    };
  },
  parseChapters: ($) =>
    $("#ja-chaps > li.chapter-item")
      .toArray()
      .flatMap((el) => {
        const readerId = $(el).attr("data-id") ?? "";
        const link = $(el).find("a").first();
        const path = readPath(link.attr("href") ?? "");
        const name = normalizeText(link.find(".name").text() || link.text());
        const number = Number($(el).attr("data-number"));
        return /^\d{1,12}$/.test(readerId) && path.split("/").length === 3
          ? [
              {
                key: `${readerId}/${path}`,
                name,
                number: Number.isFinite(number) ? number : chapterNumberFromName(name, 0),
              },
            ]
          : [];
      }),
  chapterUrl: (key) => `/read/${encodePath(key.slice(key.indexOf("/") + 1))}/?reader=${key.split("/")[0]}`,
  parsePages: async (_$, _html, base, fetchText, chapterUrl) => {
    const reader = new URL(chapterUrl).searchParams.get("reader");
    if (!reader || !/^\d{1,12}$/.test(reader)) return [];
    const body = await fetchText(new URL(`/json/chapter?mode=vertical&id=${reader}`, base).href, {
      Accept: "application/json, text/javascript, */*; q=0.01",
      "X-Requested-With": "XMLHttpRequest",
      Referer: chapterUrl.replace(/\?.*$/, ""),
    });
    let data: { status?: unknown; html?: string };
    try {
      data = JSON.parse(body);
    } catch {
      return [];
    }
    if (!data.html) return [];
    const $ = load(data.html);
    return $(".container-reader-chapter > div > img")
      .map((_, el) => lazyImage($(el)))
      .get();
  },
  filters: [{ label: "Sort by", value: "sort", type: "select", options: SORTS }],
});
