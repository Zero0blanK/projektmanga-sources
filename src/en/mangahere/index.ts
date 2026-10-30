// MangaHere. URL shapes, filters and the reader (its packed key script and the
// chapterfun.ashx image endpoint) follow the Keiyoushi extension (Apache-2.0); see
// THIRD_PARTY_NOTICES.md. The packed scripts are unpacked as text, never run.
import { createHtmlSite } from "../../lib/htmlSite.js";
import { joinedLiterals, unpack } from "../../lib/packer.js";
import {
  chapterNumberFromName,
  mapMangaStatus,
  normalizeText,
  parseDateToIso,
} from "../../lib/parse.js";
import type {
  FilterValue,
  MangaFilter,
  SourceManifest,
  TriStateFilterValue,
} from "../../lib/types.js";
import manifest from "./manifest.json";

const GENRES = [
  "Action", "Adventure", "Comedy", "Fantasy", "Historical", "Horror", "Martial Arts",
  "Mystery", "Romance", "Shounen Ai", "Supernatural", "Drama", "Shounen", "School Life",
  "Shoujo", "Gender Bender", "Josei", "Psychological", "Seinen", "Slice of Life", "Sci-fi",
  "Ecchi", "Harem", "Shoujo Ai", "Yuri", "Mature", "Tragedy", "Yaoi", "Doujinshi", "Sports",
  "Adult", "One Shot", "Smut", "Mecha", "Shotacon", "Lolicon", "Webtoons",
];

const filters: MangaFilter[] = [
  {
    label: "Type",
    value: "type",
    type: "select",
    options: [
      ["Any", "0"], ["Japanese manga", "1"], ["Korean manhwa", "2"], ["Chinese manhua", "3"],
      ["European manga", "4"], ["American manga", "5"], ["Hong Kong manga", "6"], ["Other", "7"],
    ].map(([label, value]) => ({ label, value })),
  },
  {
    label: "Completed series",
    value: "st",
    type: "select",
    options: [
      { label: "Either", value: "0" },
      { label: "No", value: "1" },
      { label: "Yes", value: "2" },
    ],
  },
  {
    label: "Genres",
    value: "genre",
    type: "tri-state",
    options: GENRES.map((label, index) => ({ label, value: String(index + 1) })),
  },
];

const active = (filters: Record<string, FilterValue>) =>
  Object.values(filters).some((value) =>
    Array.isArray(value)
      ? value.length > 0
      : typeof value === "object" && value
        ? (value.include?.length ?? 0) + (value.exclude?.length ?? 0) > 0
        : Boolean(value) && value !== "0",
  );

function searchUrl(query: string, page: number, filters: Record<string, FilterValue>) {
  const url = new URL("/search", manifest.base_url);
  const genre = filters.genre as TriStateFilterValue | string[] | undefined;
  const include = Array.isArray(genre) ? genre : (genre?.include ?? []);
  const exclude = Array.isArray(genre) ? [] : (genre?.exclude ?? []);
  url.searchParams.set("type", typeof filters.type === "string" ? filters.type : "0");
  url.searchParams.set("st", typeof filters.st === "string" ? filters.st : "0");
  url.searchParams.set("genres", include.join(","));
  url.searchParams.set("nogenres", exclude.join(","));
  url.searchParams.set("page", String(page));
  url.searchParams.set("title", query);
  url.searchParams.set("stype", "1");
  return url.href;
}

/** "Today", "5 hours ago", "Yesterday" or "Oct 29,2026". */
function chapterDate(raw: string): string {
  const text = raw.trim();
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  if (/today| ago/i.test(text)) return day.toISOString();
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
  filters,
  // The site shows mature titles only with this cookie set.
  headers: { Cookie: "isAdult=1" },
  rateLimitMs: 700,
  catalogueUrl: (category, page, filters) =>
    active(filters)
      ? searchUrl("", page, filters)
      : new URL(`/directory/${page}.htm${category === "latest" ? "?latest" : ""}`, manifest.base_url)
          .href,
  searchUrl,
  parseCards: ($) => [
    ...$(".manga-list-1-list li")
      .toArray()
      .flatMap((el) => {
        const link = $(el).find("a").first();
        const id = slugOf(link.attr("href") ?? "");
        const title = normalizeText(link.attr("title") ?? "");
        return id && title
          ? [{ id, slug: id, title, thumbnail_url: $(el).find("img.manga-list-1-cover").attr("src") ?? "" }]
          : [];
      }),
    ...$(".manga-list-4-list > li")
      .toArray()
      .flatMap((el) => {
        const link = $(el).find(".manga-list-4-item-title > a").first();
        const id = slugOf(link.attr("href") ?? "");
        const title = normalizeText(link.attr("title") || link.text());
        return id && title
          ? [{ id, slug: id, title, thumbnail_url: $(el).find("img.manga-list-4-cover").attr("src") ?? "" }]
          : [];
      }),
  ],
  titleUrl: (id) => `/manga/${id}/`,
  parseDetails: ($) => ({
    title: normalizeText($(".detail-info-right-title-font").first().text()),
    author: $(".detail-info-right-say > a")
      .map((_, el) => normalizeText($(el).text()))
      .get()
      .filter(Boolean),
    genres: $(".detail-info-right-tag-list > a")
      .map((_, el) => normalizeText($(el).text()))
      .get()
      .filter(Boolean),
    description: normalizeText($(".fullcontent").first().text()),
    thumbnail_url: $("img.detail-info-cover-img").first().attr("src") ?? "",
    status: mapMangaStatus($("span.detail-info-right-title-tip").first().text()),
  }),
  parseChapters: ($) =>
    $("ul.detail-main-list > li")
      .toArray()
      .flatMap((el) => {
        const link = $(el).find("a").first();
        const key = (link.attr("href") ?? "").match(
          /\/manga\/([a-z0-9_]+(?:\/v[\w.]+)?\/c[\d.]+)\/\d+\.html/,
        )?.[1];
        const name = normalizeText(link.find("p.title3").first().text());
        return key
          ? [
              {
                key,
                name,
                number: chapterNumberFromName(name, Number(key.match(/c([\d.]+)$/)?.[1] ?? 0)),
                date: chapterDate(link.find("p.title2").first().text()),
              },
            ]
          : [];
      }),
  chapterUrl: (key) => `/manga/${key}/1.html`,
  parsePages: async ($, html, base, fetchText, chapterUrl) => {
    const packed = [...html.matchAll(/eval\(function\(p,a,c,k,e,d\)[\s\S]*?<\/script>/g)]
      .map((match) => unpack(match[0]))
      .filter((script): script is string => Boolean(script));
    // The long-strip reader lists every image in one script.
    for (const script of packed) {
      const list = script.match(/newImgs=\['([^\]]*)'\]/)?.[1];
      if (list) return list.split("','").map((src) => `https:${src}`);
    }
    // The page reader: one script holds the key; chapterfun.ashx names two pages a call.
    const keyScript = packed.find((script) => script.includes("guidkey") || script.includes("dm5_key"));
    const key = keyScript ? joinedLiterals(keyScript.slice(keyScript.indexOf("'"), keyScript.indexOf(";"))) : "";
    const chapterId = html.match(/chapterid\s*=\s*(\d+)/)?.[1];
    const count = Number(html.match(/imagecount\s*=\s*(\d+)/)?.[1] ?? 0);
    if (!chapterId || !count) return [];
    const endpoint = new URL("chapterfun.ashx", chapterUrl);
    const headers = {
      Referer: chapterUrl,
      Accept: "*/*",
      "X-Requested-With": "XMLHttpRequest",
      Cookie: "isAdult=1",
    };
    const images: string[] = [];
    for (let page = 1; page <= count && images.length < count; page += 2) {
      let script: string | null = null;
      for (const tryKey of [key, ""]) {
        endpoint.search = new URLSearchParams({ cid: chapterId, page: String(page), key: tryKey }).toString();
        const body = await fetchText(endpoint.href, headers);
        script = body ? unpack(body) : null;
        if (script) break;
      }
      if (!script) break;
      const pix = script.match(/pix="([^"]+)"/)?.[1] ?? "";
      const values = [...(script.match(/pvalue=\[([^\]]*)\]/)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(
        (match) => match[1],
      );
      for (const value of values) images.push(`https:${pix}${value}`);
    }
    return images.slice(0, count);
  },
});
