import { attachHtmlCatalogue } from "./nativeCatalogue.js";
import { load } from "cheerio/slim";
import type {
  Chapters,
  FilterValue,
  MangaFilter,
  Mangas,
  Source,
} from "./types.js";
import { HttpClient, NAV_HEADERS } from "./http.js";
import { TTLCache } from "./cache.js";
import { normalizeText, parseDateToIso, resolvePagination } from "./parse.js";
import { deriveIsNSFW } from "./manifest.js";
import { collectSequentialPages } from "./sequentialPagination.js";
import { SourceError } from "./sourceError.js";

export interface MangaThemesiaConfig {
  manifest: import("./types.js").SourceManifest;
  cataloguePath?: string;
  parseDate?: (value: string) => string;
  filters?: MangaFilter[];
  buildCatalogueUrl?: (
    category: string,
    query: string,
    filters: Record<string, FilterValue>,
    page: number,
  ) => URL;
  catalogueRoute?: RegExp;
  selectors?: Partial<{
    cards: string;
    chapterRows: string;
    detailsRoot: string;
    title: string;
    cover: string;
    author: string;
    artist: string;
    status: string;
    description: string;
    genres: string;
    readerImages: string;
  }>;
}
export function createMangaThemesiaSource(config: MangaThemesiaConfig): Source {
  const { manifest } = config;
  const selectors = {
    cards: ".utao .uta .imgu, .listupd .bs .bsx, .listo .bs .bsx",
    chapterRows:
      "div.bxcl li, div.cl li, #chapterlist li, ul li:has(div.chbox):has(div.eph-num)",
    detailsRoot: "div.bigcontent, div.animefull, div.main-info, div.postbody",
    title: ".entry-title, .ts-breadcrumb li:last-child span",
    cover: ".infomanga > div[itemprop=image] img, .thumb img",
    // MangaThemesia ships two details layouts and sites pick either one. The
    // `.infotable` table is the older; the `.tsinfo`/`.imptdt` list is what current
    // builds of the theme emit — `<div class="imptdt"><h1>Status</h1><i>Ongoing</i></div>`.
    // Only the table was matched here, so on a site using the list form every one of
    // these came back empty: status fell through to UNKNOWN even where the page plainly
    // showed "Ongoing", and author/artist were simply missing. Madara Scans is one such
    // site; its pages carry no `.infotable` at all.
    author:
      ".infotable tr:contains(Author) td:last-child, .tsinfo .imptdt:contains(Author) i",
    artist:
      ".infotable tr:contains(Artist) td:last-child, .tsinfo .imptdt:contains(Artist) i",
    status:
      ".infotable tr:contains(Status) td:last-child, .tsinfo .imptdt:contains(Status) i",
    description: ".desc, .entry-content[itemprop=description]",
    genres: "div.gnr a, .mgen a, .seriestugenre a",
    readerImages: "div#readerarea img",
    ...config.selectors,
  };
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
      return fail(`Invalid ${manifest.name} identifier`);
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
      return fail(`Invalid ${manifest.name} identifier`);
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

  function chapters(text: string): Chapters[] {
    const $ = load(text),
      seen = new Set<string>();
    return $(selectors.chapterRows)
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
        if (!number)
          return fail(`${manifest.name} chapter number was not found`);
        return [
          {
            id: `${manifest.source_key}:${url}`,
            url: manifest.base_url + url,
            name,
            chapter_number: Number(number[1].replace(",", ".")),
            release_date: (config.parseDate ?? parseDateToIso)(
              row.find(".chapterdate").text(),
            ),
            language: manifest.lang,
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
          return fail(`${manifest.name} reader metadata is malformed`);
        }
        if (
          !Array.isArray(value) ||
          !value.every((item) => typeof item === "string")
        )
          return fail(`${manifest.name} reader metadata is malformed`);
        return value;
      }
    }
    return fail(`${manifest.name} reader metadata is incomplete`);
  }
  function catalogueUrl(
    category: string,
    query: string,
    filters: Record<string, FilterValue>,
    page: number,
  ): URL {
    if (config.buildCatalogueUrl)
      return config.buildCatalogueUrl(category, query, filters, page);
    const url = new URL(
      query ? `/page/${page}/` : (config.cataloguePath ?? "/manga/"),
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
    return url;
  }
  function parseCards(text: string): Mangas[] {
    const $ = load(text);
    return $(selectors.cards)
      .toArray()
      .map((el) => {
        const card = $(el),
          anchor = card.find("a").first(),
          id = path(anchor.attr("href") || ""),
          title = normalizeText(
            anchor.attr("title") || card.find(".tt").text() || anchor.text(),
          );
        if (!title)
          return fail(`${manifest.name} catalogue title was not found`);
        return {
          id,
          slug: id,
          title,
          source: manifest.source_key,
          thumbnail_url: image(imgValue(card.find("img").first().attr() ?? {})),
        };
      });
  }
  async function browse(
    category: string,
    query: string,
    pagination: Parameters<Source["fetchManga"]>[1],
    filters: Record<string, FilterValue> = {},
  ): Promise<Mangas[]> {
    const window = resolvePagination(pagination, { limit: 20 });
    return collectSequentialPages(window, manifest.source_key, async (page) => {
      const url = catalogueUrl(category, query, filters, page);
      const $ = load(await html(url.href));
      return parseCards($.html());
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
        root = $(selectors.detailsRoot).first(),
        title = normalizeText(root.find(selectors.title).first().text());
      if (!title) return fail(`${manifest.name} title metadata was not found`);
      const author = normalizeText(root.find(selectors.author).text()),
        artist = normalizeText(root.find(selectors.artist).text()),
        status = normalizeText(
          root.find(selectors.status).text(),
        ).toLowerCase();
      return {
        id: path(id),
        slug: path(id),
        title,
        source: manifest.source_key,
        thumbnail_url: image(
          imgValue(root.find(selectors.cover).first().attr() ?? {}),
        ),
        description: normalizeText(root.find(selectors.description).text()),
        author: author ? [author] : [],
        artist: artist ? [artist] : [],
        genres: root
          .find(selectors.genres)
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
      if (!id.startsWith(`${manifest.source_key}:/`))
        return fail(`Invalid ${manifest.name} chapter identifier`);
      const text = await html(path(id.slice(manifest.source_key.length + 1))),
        $ = load(text);
      let urls = $(selectors.readerImages)
        .toArray()
        .map((el) => image(imgValue($(el).attr() ?? {})))
        .filter(Boolean);
      if (!urls.length) {
        // Optimisers move inline scripts into base64 data URIs, and ts_reader.run can
        // be in any of them, not just the first. Search all of them plus the page.
        const decoded = $("script[src^='data:text/javascript;base64,']")
          .toArray()
          .map((el) =>
            Buffer.from(
              ($(el).attr("src") ?? "").split(",").slice(1).join(","),
              "base64",
            ).toString("utf8"),
          );
        const bodies = [...decoded, text].sort(
          (a, b) =>
            Number(b.includes("ts_reader")) - Number(a.includes("ts_reader")),
        );
        for (const body of bodies) {
          urls = scriptedImages(body).map(image).filter(Boolean);
          if (urls.length) break;
        }
      }
      urls = [...new Set(urls)];
      if (!urls.length)
        return fail(`${manifest.name} reader images were not found`);
      const { limit, offset } = resolvePagination(pagination, {
        limit: urls.length,
      });
      return {
        items: urls.slice(offset, offset + limit).map((image_url, index) => ({
          index: offset + index + 1,
          image_url,
        })),
        total: urls.length,
      };
    },
    async fetchMangaUpdates(id) {
      return source.fetchChapters(id);
    },
    async getFilters(): Promise<MangaFilter[]> {
      if (config.filters) return structuredClone(config.filters);
      const $ = load(await html(config.cataloguePath ?? "/manga/")),
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
  return attachHtmlCatalogue(source, {
    getText: html,
    parse: parseCards,
    path: ({ category, query, filters }) =>
      catalogueUrl(category || "latest", query || "", filters, 1).href,
    route:
      config.catalogueRoute ??
      new RegExp(
        `^(?:${(config.cataloguePath ?? "/manga/").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|/page/\\d+/)$`,
      ),
    capabilities: { filters: true, languageFilter: false },
  });
}
