import { attachHtmlCatalogue } from "../../lib/nativeCatalogue.js";
import { load } from "cheerio/slim";
import type {
  Chapters,
  FilterValue,
  MangaFilter,
  Mangas,
  Source,
} from "../../lib/types.js";
import { HttpClient, NAV_HEADERS } from "../../lib/http.js";
import { TTLCache } from "../../lib/cache.js";
import { normalizeText, resolvePagination } from "../../lib/parse.js";
import { deriveIsNSFW } from "../../lib/manifest.js";
import { SourceError } from "../../lib/sourceError.js";
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
const api = "https://api.komiku.org";
function fail(message: string): never {
  throw new SourceError("PARSE_ERROR", message, manifest.source_key);
}

function localPath(value: string, series = false): string {
  let url: URL;
  try {
    url = new URL(value, manifest.base_url);
  } catch {
    return fail("Invalid Komiku identifier");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (
    url.origin !== manifest.base_url ||
    url.search ||
    url.hash ||
    segments.length === 0 ||
    segments.some((segment) => {
      try {
        const decoded = decodeURIComponent(segment);
        return decoded === "." || decoded === ".." || /[\\/]/.test(decoded);
      } catch {
        return true;
      }
    })
  )
    return fail("Invalid Komiku identifier");
  if (series && (segments.length !== 2 || segments[0] !== "manga"))
    return fail("Invalid Komiku title identifier");
  return `/${segments.join("/")}/`;
}
const seriesPath = (id: string) => localPath(`/manga/${id}/`, true);
const imageUrl = (value: string) => {
  if (!value.trim()) return "";
  try {
    const url = new URL(value, manifest.base_url);
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
};

export function parseKomikuDate(text: string, now = Date.now()): string {
  const relative = normalizeText(text)
    .toLowerCase()
    .match(/^(\d+)\s+(detik|menit|jam|hari|minggu|bulan|tahun)\s+lalu$/);
  if (relative) {
    const amount = Number(relative[1]);
    if (!Number.isSafeInteger(amount) || amount > 10000) return "";
    const units: Record<string, number> = {
      detik: 1000,
      menit: 60000,
      jam: 3600000,
      hari: 86400000,
      minggu: 604800000,
    };
    if (units[relative[2]])
      return new Date(now - amount * units[relative[2]]).toISOString();
    const date = new Date(now),
      day = date.getUTCDate();
    date.setUTCDate(1);
    if (relative[2] === "bulan") date.setUTCMonth(date.getUTCMonth() - amount);
    else date.setUTCFullYear(date.getUTCFullYear() - amount);
    date.setUTCDate(
      Math.min(
        day,
        new Date(
          Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
        ).getUTCDate(),
      ),
    );
    return date.toISOString();
  }
  const absolute = text.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!absolute) return "";
  const [, d, m, y] = absolute.map(Number),
    date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
    ? new Date(+date - 7 * 3600000).toISOString()
    : "";
}

function chapterRows(text: string): Chapters[] {
  const $ = load(text),
    seen = new Set<string>();
  return $("#Daftar_Chapter tr:has(td.judulseries)")
    .toArray()
    .flatMap((element) => {
      const row = $(element),
        anchor = row.find("a").first();
      const path = localPath(anchor.attr("href") ?? "");
      if (seen.has(path)) return [];
      seen.add(path);
      const name = normalizeText(anchor.text()),
        match = name.match(/(?:chapter|chap|ch\.?|bab)\s*(\d+(?:[.,]\d+)?)/i);
      if (!match) return fail("Komiku chapter number was not found");
      return [
        {
          id: `komiku:${path}`,
          url: manifest.base_url + path,
          name,
          chapter_number: Number(match[1].replace(",", ".")),
          last_page_read: 0,
          release_date: parseKomikuDate(row.find("td.tanggalseries").text()),
          language: "id",
          pages: [],
        },
      ];
    });
}

function catalogueUrl(
  category: string,
  query: string,
  filters: Record<string, FilterValue>,
  page: number,
) {
  const popular =
    category === "popular" && !query && !Object.values(filters).some(Boolean);
  const url = new URL(
    popular
      ? `${api}/other/hot/${page > 1 ? `page/${page}/` : ""}`
      : `${api}/manga/${page > 1 ? `page/${page}/` : ""}`,
  );
  url.searchParams.set("orderby", popular ? "meta_value_num" : "modified");
  if (query.trim()) url.searchParams.set("s", query.trim());
  for (const key of ["tipe", "orderby", "genre", "genre2", "statusmanga"])
    if (typeof filters[key] === "string" && filters[key])
      url.searchParams.set(key, String(filters[key]));
  return url;
}
function parseCards(text: string): Mangas[] {
  const $ = load(text);
  return $("div.bge")
    .toArray()
    .map((element) => {
      const card = $(element),
        anchor = card.find("a:has(h3)").first(),
        title = normalizeText(card.find("h3").first().text());
      if (!title || !anchor.attr("href"))
        return fail("Komiku catalogue markup changed");
      const id = localPath(anchor.attr("href")!, true).split("/")[2],
        img = card.find("img").first();
      return {
        id,
        slug: id,
        title,
        source: manifest.source_key,
        thumbnail_url: imageUrl(img.attr("data-src") || img.attr("src") || ""),
      };
    });
}
async function browse(
  category: string,
  query: string,
  pagination: Parameters<Source["fetchManga"]>[1],
  filters: Record<string, FilterValue> = {},
): Promise<Mangas[]> {
  const { limit, offset } = resolvePagination(pagination, { limit: 20 });
  if (limit === 0) return [];
  const rows: Mangas[] = [],
    seen = new Set<string>();
  for (let page = 1; page <= 50; page++) {
    const url = catalogueUrl(category, query, filters, page);
    let text: string;
    try {
      text = await html(url.href);
    } catch (error) {
      if (
        page > 1 &&
        error instanceof SourceError &&
        error.code === "NOT_FOUND"
      )
        break;
      throw error;
    }
    const $ = load(text),
      elements = $("div.bge").toArray();
    if (!elements.length) break;
    let added = 0;
    for (const element of elements) {
      const card = $(element),
        anchor = card.find("a:has(h3)").first(),
        title = normalizeText(card.find("h3").first().text());
      if (!title || !anchor.attr("href"))
        return fail("Komiku catalogue markup changed");
      const path = localPath(anchor.attr("href")!, true),
        id = path.split("/")[2];
      if (seen.has(id)) continue;
      seen.add(id);
      added++;
      const img = card.find("img").first();
      rows.push({
        id,
        slug: id,
        title,
        source: manifest.source_key,
        thumbnail_url: imageUrl(img.attr("data-src") || img.attr("src") || ""),
      });
    }
    if (rows.length >= offset + limit)
      return rows.slice(offset, offset + limit);
    if (added === 0) break;
    if (page === 50)
      return fail("Komiku pagination exceeds the bounded upstream window");
  }
  return rows.slice(offset, offset + limit);
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
    const text = await html(seriesPath(id)),
      $ = load(text),
      title = normalizeText($("h1").first().text());
    if (!title) return fail("Komiku title metadata was not found");
    const status = normalizeText(
      $("table.inftable td:contains(Status)+td").text(),
    ).toLowerCase();
    const img = $("div.ims > img, img[itemprop=image]").first();
    const author = normalizeText(
      $(
        "table.inftable td:contains(Pengarang)+td, table.inftable td:contains(Komikus)+td, table.inftable td:contains(Author)+td",
      )
        .first()
        .text(),
    );
    return {
      id,
      slug: id,
      url: manifest.base_url + seriesPath(id),
      title,
      source: manifest.source_key,
      thumbnail_url: imageUrl(img.attr("data-src") || img.attr("src") || ""),
      author: author ? [author] : [],
      description: normalizeText(
        $("#Sinopsis > p, p.desc[itemprop=description]").text(),
      ),
      genres: $("ul.genre li.genre a span")
        .toArray()
        .map((el) => normalizeText($(el).text())),
      status: /end|completed|tamat/.test(status)
        ? "COMPLETED"
        : /on\s?going/.test(status)
          ? "ONGOING"
          : "UNKNOWN",
      chapters: chapterRows(text),
    };
  },
  async fetchChapters(id) {
    return chapterRows(await html(seriesPath(id)));
  },
  async fetchChapterPages(id, _slug, pagination) {
    if (!id.startsWith("komiku:/"))
      return fail("Invalid Komiku chapter identifier");
    const path = localPath(id.slice("komiku:".length)),
      $ = load(await html(path));
    const urls = [
      ...new Set(
        $("#Baca_Komik img")
          .toArray()
          .map((el) => {
            const img = $(el);
            return imageUrl(img.attr("data-src") || img.attr("src") || "");
          })
          .filter((url) => url && !url.includes("komiku-promosi")),
      ),
    ];
    if (!urls.length) return fail("Komiku reader images were not found");
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
    return (await this.fetchMangaDetails(id)).chapters;
  },
  async getFilters(): Promise<MangaFilter[]> {
    return [
      {
        label: "Type",
        value: "tipe",
        type: "select",
        options: [
          { label: "All", value: "" },
          ...["manga", "manhua", "manhwa"].map((value) => ({
            label: value,
            value,
          })),
        ],
      },
      {
        label: "Order",
        value: "orderby",
        type: "select",
        options: [
          { label: "Updated", value: "modified" },
          { label: "Added", value: "date" },
          { label: "Popular", value: "meta_value_num" },
          { label: "Random", value: "rand" },
        ],
      },
      { label: "Genre", value: "genre", type: "input" },
      { label: "Second genre", value: "genre2", type: "input" },
      {
        label: "Status",
        value: "statusmanga",
        type: "select",
        options: [
          { label: "All", value: "" },
          { label: "Ongoing", value: "ongoing" },
          { label: "Completed", value: "end" },
        ],
      },
    ];
  },
};
export default attachHtmlCatalogue(source, {
  requestBaseUrl: api,
  getText: html,
  parse: parseCards,
  path: ({ category, query, filters }) =>
    catalogueUrl(category || "latest", query || "", filters, 1).href,
  route: /^\/(?:manga|other\/hot)\/(?:page\/\d+\/)?$/,
  next: async (text, current, context) => {
    const href = load(text)("span[hx-get]").first().attr("hx-get");
    if (href) return href;
    const cards = parseCards(text);
    if (cards.length < 10) return undefined;
    const page = Number(current.pathname.match(/\/page\/(\d+)\//)?.[1] || 1);
    const next = catalogueUrl(
      context.category || "latest",
      context.query || "",
      context.filters,
      page + 1,
    ).href;
    // The upstream theme sometimes omits HTMX metadata. Verify one page ahead,
    // including a repeated final page, instead of guessing from a full result.
    try {
      const rows = parseCards(await html(next));
      return rows.some((row) => !cards.some((card) => card.id === row.id))
        ? next
        : undefined;
    } catch (error) {
      if (error instanceof SourceError && error.code === "NOT_FOUND")
        return undefined;
      throw error;
    }
  },
});
