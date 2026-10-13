import { load } from "cheerio/slim";
import type {
  Chapters,
  FilterValue,
  MangaFilter,
  Mangas,
  Source,
} from "../lib/types.js";
import { HttpClient, NAV_HEADERS } from "../lib/http.js";
import { TTLCache } from "../lib/cache.js";
import {
  normalizeText,
  parseDateToIso,
  resolvePagination,
} from "../lib/parse.js";
import { deriveIsNSFW } from "../lib/manifest.js";
import { collectSequentialPages } from "../lib/sequentialPagination.js";
import { SourceError } from "../lib/sourceError.js";
import manifest from "./manifest.json";

const http = new HttpClient({
  sourceId: manifest.source_key,
  sourceName: manifest.name,
  baseUrl: manifest.base_url,
  headers: NAV_HEADERS,
  rateLimitMs: 550,
});
const cache = new TTLCache<string, string>(120_000, 40);
const html = (url: string) => cache.getOrSet(url, () => http.getText(url));
function fail(message: string): never {
  throw new SourceError("PARSE_ERROR", message, manifest.source_key);
}
function path(value: string): string {
  let url: URL;
  try {
    url = new URL(value, manifest.base_url);
  } catch {
    return fail("Invalid Sushi-Scan identifier");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (
    url.origin !== manifest.base_url ||
    url.search ||
    url.hash ||
    !parts.length ||
    parts.some((part) => {
      try {
        return (
          /[\\/]/.test(decodeURIComponent(part)) ||
          [".", ".."].includes(decodeURIComponent(part))
        );
      } catch {
        return true;
      }
    })
  )
    return fail("Invalid Sushi-Scan identifier");
  return `/${parts.join("/")}/`;
}
function image(value: string): string {
  if (!value.trim()) return "";
  try {
    const url = new URL(value, manifest.base_url);
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}
const imgValue = (attributes: Record<string, string>) =>
  attributes["data-lazy-src"] ||
  attributes["data-src"] ||
  attributes["data-cfsrc"] ||
  attributes.src ||
  "";
export function parseFrenchDate(value: string): string {
  const months: Record<string, string> = {
    janvier: "January",
    février: "February",
    mars: "March",
    avril: "April",
    mai: "May",
    juin: "June",
    juillet: "July",
    août: "August",
    septembre: "September",
    octobre: "October",
    novembre: "November",
    décembre: "December",
  };
  const text = normalizeText(value).toLowerCase();
  const absolute = text.match(/^(\d{1,2})\s+(\p{L}+)\s+(\d{4})$/u);
  if (absolute) {
    const month = Object.keys(months).indexOf(absolute[2]),
      day = Number(absolute[1]),
      year = Number(absolute[3]);
    if (month < 0) return "";
    const date = new Date(Date.UTC(year, month, day));
    return date.getUTCFullYear() === year &&
      date.getUTCMonth() === month &&
      date.getUTCDate() === day
      ? date.toISOString()
      : "";
  }
  return parseDateToIso(
    text.replace(/\b\p{L}+\b/gu, (word) => months[word] ?? word),
  );
}
function chapters(text: string): Chapters[] {
  const $ = load(text),
    seen = new Set<string>();
  return $(
    "div.bxcl li, div.cl li, #chapterlist li, ul li:has(div.chbox):has(div.eph-num)",
  )
    .toArray()
    .flatMap((el) => {
      const row = $(el),
        anchor = row.find("a").first(),
        url = path(anchor.attr("href") || ""),
        name = normalizeText(
          row.find(".lch a, .chapternum").text() || anchor.text(),
        );
      if (seen.has(url)) return [];
      seen.add(url);
      const number = name.match(
        /(?:chapitre|chapter|chap|ch\.?)\s*(\d+(?:[.,]\d+)?)/i,
      );
      if (!number) return fail("Sushi-Scan chapter number was not found");
      return [
        {
          id: `sushiscan:${url}`,
          url: manifest.base_url + url,
          name,
          chapter_number: Number(number[1].replace(",", ".")),
          release_date: parseFrenchDate(row.find(".chapterdate").text()),
          language: "fr",
          last_page_read: 0,
          pages: [],
        },
      ];
    });
}
function scriptedImages(text: string): string[] {
  const match = /(?:["']?(?:images|imageUrls)["']?)\s*[:=]\s*\[/.exec(text);
  if (!match) return [];
  const start = match.index + match[0].length - 1;
  let quoted = false,
    escaped = false;
  for (let end = start + 1; end < text.length; end++) {
    const character = text[end];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quoted) {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (character === "]" && !quoted) {
      let value: unknown;
      try {
        value = JSON.parse(text.slice(start, end + 1));
      } catch {
        return fail("Sushi-Scan reader metadata is malformed");
      }
      if (
        !Array.isArray(value) ||
        !value.every((item) => typeof item === "string")
      )
        return fail("Sushi-Scan reader metadata is malformed");
      return value;
    }
  }
  return fail("Sushi-Scan reader metadata is incomplete");
}
async function browse(
  category: string,
  query: string,
  pagination: Parameters<Source["fetchManga"]>[1],
  filters: Record<string, FilterValue> = {},
): Promise<Mangas[]> {
  const window = resolvePagination(pagination, { limit: 20 });
  return collectSequentialPages(window, manifest.source_key, async (page) => {
    const url = new URL(
      query ? `/page/${page}/` : "/catalogue/",
      manifest.base_url,
    );
    if (query) url.searchParams.set("s", query);
    else url.searchParams.set("page", String(page));
    url.searchParams.set(
      "order",
      category === "popular" ? "popular" : "update",
    );
    for (const key of ["status", "type", "order", "author", "year"])
      if (typeof filters[key] === "string" && filters[key])
        url.searchParams.set(key, String(filters[key]));
    if (Array.isArray(filters.genre))
      for (const genre of filters.genre)
        url.searchParams.append("genre[]", genre);
    const $ = load(await html(url.href));
    return $(".utao .uta .imgu, .listupd .bs .bsx, .listo .bs .bsx")
      .toArray()
      .map((el) => {
        const card = $(el),
          anchor = card.find("a").first(),
          id = path(anchor.attr("href") || ""),
          title = normalizeText(
            anchor.attr("title") || card.find(".tt").text() || anchor.text(),
          );
        if (!title) return fail("Sushi-Scan catalogue title was not found");
        return {
          id,
          slug: id,
          title,
          source: manifest.source_key,
          thumbnail_url: image(imgValue(card.find("img").first().attr() ?? {})),
        };
      });
  });
}
const source: Source = {
  id: manifest.source_key,
  name: manifest.name,
  lang: manifest.lang,
  base_url: manifest.base_url,
  isNSFW: deriveIsNSFW(manifest.content_rating),
  fetchManga: (category = "latest", pagination, filters) =>
    browse(category, "", pagination, filters),
  searchManga: (query = "", pagination, filters) =>
    browse("latest", query, pagination, filters),
  async fetchMangaDetails(id) {
    const text = await html(path(id)),
      $ = load(text),
      root = $(
        "div.bigcontent, div.animefull, div.main-info, div.postbody",
      ).first(),
      title = normalizeText(
        root
          .find(".entry-title, .ts-breadcrumb li:last-child span")
          .first()
          .text(),
      );
    if (!title) return fail("Sushi-Scan title metadata was not found");
    const author = normalizeText(
        root.find(".infotable tr:contains(Auteur) td:last-child").text(),
      ),
      artist = normalizeText(
        root.find(".infotable tr:contains(Artiste) td:last-child").text(),
      ),
      status = normalizeText(
        root.find(".infotable tr:contains(Statut) td:last-child").text(),
      ).toLowerCase();
    return {
      id: path(id),
      slug: path(id),
      title,
      source: manifest.source_key,
      thumbnail_url: image(
        imgValue(
          root
            .find(".infomanga > div[itemprop=image] img, .thumb img")
            .first()
            .attr() ?? {},
        ),
      ),
      description: normalizeText(
        root.find(".desc, .entry-content[itemprop=description]").text(),
      ),
      author: author ? [author] : [],
      artist: artist ? [artist] : [],
      genres: root
        .find("div.gnr a, .mgen a, .seriestugenre a")
        .toArray()
        .map((el) => normalizeText($(el).text())),
      status: /termin|compl|fini|achev/.test(status)
        ? "COMPLETED"
        : /pause|attente|hiatus/.test(status)
          ? "HIATUS"
          : /cours|ongoing/.test(status)
            ? "ONGOING"
            : "UNKNOWN",
      chapters: chapters(text),
    };
  },
  async fetchChapters(id) {
    return chapters(await html(path(id)));
  },
  async fetchChapterPages(id, _slug, pagination) {
    if (!id.startsWith("sushiscan:/"))
      return fail("Invalid Sushi-Scan chapter identifier");
    const text = await html(path(id.slice("sushiscan:".length))),
      $ = load(text);
    let urls = $("div#readerarea img")
      .toArray()
      .map((el) => image(imgValue($(el).attr() ?? {})))
      .filter(Boolean);
    if (!urls.length) {
      const script = $("script[src^='data:text/javascript;base64,']")
        .first()
        .attr("src");
      const body = script
        ? Buffer.from(script.split(",").slice(1).join(","), "base64").toString(
            "utf8",
          )
        : text;
      urls = scriptedImages(body).map(image).filter(Boolean);
    }
    urls = [...new Set(urls)];
    if (!urls.length) return fail("Sushi-Scan reader images were not found");
    const { limit, offset } = resolvePagination(pagination, {
      limit: urls.length,
    });
    return {
      items: urls
        .slice(offset, offset + limit)
        .map((image_url, index) => ({ index: offset + index + 1, image_url })),
      total: urls.length,
    };
  },
  async fetchMangaUpdates(id) {
    return source.fetchChapters(id);
  },
  async getFilters(): Promise<MangaFilter[]> {
    const $ = load(await html("/catalogue/")),
      genres = $("ul.genrez li")
        .toArray()
        .flatMap((el) => {
          const row = $(el),
            value = row.find("input[type=checkbox]").attr("value"),
            label = normalizeText(row.find("label").text());
          return value && label ? [{ value, label }] : [];
        });
    return [
      {
        label: "Status",
        value: "status",
        type: "select",
        options: [
          { label: "All", value: "" },
          { label: "Ongoing", value: "ongoing" },
          { label: "Completed", value: "completed" },
          { label: "Hiatus", value: "hiatus" },
        ],
      },
      {
        label: "Type",
        value: "type",
        type: "select",
        options: [
          { label: "All", value: "" },
          ...["Manga", "Manhwa", "Manhua", "Comic"].map((value) => ({
            label: value,
            value,
          })),
        ],
      },
      {
        label: "Order",
        value: "order",
        type: "select",
        options: ["update", "latest", "popular", "title", "titlereverse"].map(
          (value) => ({ label: value, value }),
        ),
      },
      { label: "Author", value: "author", type: "input" },
      { label: "Year", value: "year", type: "input" },
      { label: "Genres", value: "genre", type: "multi", options: genres },
    ];
  },
};
export default source;
