import { attachHtmlCatalogue } from "../../lib/nativeCatalogue.js";
import { load } from "cheerio/slim";
import type {
  Source,
  Mangas,
  MangaDetails,
  Chapters,
  Page,
  ChapterPagesResult,
  MangaFilter,
} from "../../lib/types.js";
import { HttpClient } from "../../lib/http.js";
import { collectPaged } from "../../lib/paginate.js";
import {
  mapMangaStatus,
  normalizeText,
  parseDateToIso,
  resolvePagination,
  toAbsoluteUrl,
} from "../../lib/parse.js";
import { SourceError } from "../../lib/sourceError.js";
import { deriveIsNSFW } from "../../lib/manifest.js";
import manifest from "./manifest.json";
import { filters, browseParams } from "./filters.js";

const SOURCE_ID = manifest.source_key;
const SOURCE_NAME = manifest.name;
const BASE_URL = manifest.base_url;
const PAGE_SIZE = 20;
const http = new HttpClient({
  sourceId: SOURCE_ID,
  sourceName: SOURCE_NAME,
  baseUrl: BASE_URL,
  rateLimitMs: 250,
});
const seriesPath = (id: string) => `/comics/${encodeURIComponent(id)}`;

function parseCards(html: string): Mangas[] {
  const $ = load(html);
  const cards = $('a[href^="/comics/"]')
    .map((_, el) => {
      const link = $(el);
      const href = link.attr("href") || "";
      const id = href.split("/").filter(Boolean).at(-1) || "";
      if (!id || id === "comics") return null;
      const image = link.find("img").first();
      const title = normalizeText(image.attr("alt") || link.text());
      return {
        source: SOURCE_ID,
        id,
        slug: id,
        title: title || "No Title",
        thumbnail_url: toAbsoluteUrl(
          image.attr("src") || image.attr("data-src") || "",
          BASE_URL,
        ),
      } as Mangas;
    })
    .get()
    .filter((item): item is Mangas => item !== null);
  const unique = new Map<string, Mangas>();
  for (const card of cards) {
    const previous = unique.get(card.id);
    unique.set(
      card.id,
      previous
        ? {
            ...previous,
            title: previous.title === "No Title" ? card.title : previous.title,
            thumbnail_url: previous.thumbnail_url || card.thumbnail_url,
          }
        : card,
    );
  }
  return [...unique.values()];
}

function parseChapters(html: string, id: string): Chapters[] {
  const $ = load(html);
  const seen = new Set<string>();
  return $('a[href*="/chapter/"]')
    .filter((_, el) =>
      /^\/comics\/[^/]+\/chapter\/[^/?#]+/.test($(el).attr("href") || ""),
    )
    .map((index, el) => {
      const link = $(el);
      const href = link.attr("href") || "";
      const chapterId = href.split("/").filter(Boolean).at(-1) || "";
      if (!chapterId || seen.has(chapterId)) return null;
      seen.add(chapterId);
      const name = normalizeText(link.text());
      const number = Number.parseFloat(name.match(/[\d.]+/)?.[0] || chapterId);
      return {
        id: `${id}/${chapterId}`,
        name,
        url: toAbsoluteUrl(href, BASE_URL),
        chapter_number: Number.isFinite(number) ? number : index + 1,
        scanlator: "Unknown",
        language: manifest.lang,
        last_page_read: 0,
        release_date: parseDateToIso(link.find("time").attr("datetime") || ""),
        page_count: 0,
        pages: [],
      } as Chapters;
    })
    .get()
    .filter((chapter): chapter is Chapters => chapter !== null);
}

const source: Source = {
  id: SOURCE_ID,
  name: SOURCE_NAME,
  lang: manifest.lang,
  base_url: BASE_URL,
  isNSFW: deriveIsNSFW(manifest.content_rating),
  async fetchManga(category, pagination, active) {
    const { limit, offset } = resolvePagination(pagination, {
      limit: PAGE_SIZE,
    });
    const params = browseParams("", category, active);
    return collectPaged(
      { limit, offset, sitePageSize: PAGE_SIZE },
      async (page) =>
        parseCards(await http.getText(`/browse/comics?${params}&page=${page}`)),
    );
  },
  async searchManga(query, pagination, active) {
    if (!query?.trim()) return [];
    const { limit, offset } = resolvePagination(pagination, {
      limit: PAGE_SIZE,
    });
    const params = browseParams(query.trim(), undefined, active);
    return collectPaged(
      { limit, offset, sitePageSize: PAGE_SIZE },
      async (page) =>
        parseCards(await http.getText(`/browse/comics?${params}&page=${page}`)),
    );
  },
  async fetchMangaDetails(id): Promise<MangaDetails> {
    const $ = load(await http.getText(seriesPath(id)));
    const title = normalizeText($("h1").last().text());
    const image = $('img[src*="/asura-images/covers/"]').first();
    const description = normalizeText($("#description-text").text());
    const statusText = $("div")
      .filter((_, el) => normalizeText($(el).text()) === "Status")
      .first()
      .parent()
      .text();
    const chapters = parseChapters($.html() || "", id);
    if (!title)
      throw new SourceError(
        "PARSE_ERROR",
        `${SOURCE_NAME} returned unexpected series details.`,
        SOURCE_ID,
      );
    return {
      source: SOURCE_ID,
      id,
      slug: id,
      url: toAbsoluteUrl(seriesPath(id), BASE_URL),
      title,
      thumbnail_url: toAbsoluteUrl(image.attr("src") || "", BASE_URL),
      description,
      author: $('a[href*="author="]')
        .map((_, el) => normalizeText($(el).text()))
        .get()
        .filter(Boolean),
      artist: [],
      genres: $('a[href*="genres="]')
        .map((_, el) => normalizeText($(el).text()))
        .get()
        .filter(Boolean),
      status: mapMangaStatus(statusText),
      chapters,
    };
  },
  async fetchMangaThumbnail(id) {
    try {
      const $ = load(await http.getText(seriesPath(id)));
      return toAbsoluteUrl(
        $('img[src*="/asura-images/covers/"]').first().attr("src") || "",
        BASE_URL,
      );
    } catch {
      return "";
    }
  },
  async fetchChapters(id) {
    return parseChapters(await http.getText(seriesPath(id)), id);
  },
  async fetchChapterPages(
    chapterId,
    mangaSlug,
    pagination,
  ): Promise<ChapterPagesResult<Page>> {
    const pieces = chapterId.split("/").filter(Boolean);
    const id = mangaSlug || pieces.length > 1 ? mangaSlug || pieces[0] : "";
    const number = pieces.length > 1 ? pieces.at(-1)! : chapterId;
    if (!id)
      throw new SourceError(
        "PARSE_ERROR",
        `${SOURCE_NAME} could not identify this chapter.`,
        SOURCE_ID,
      );
    const $ = load(
      await http.getText(
        `${seriesPath(id)}/chapter/${encodeURIComponent(number)}`,
      ),
    );
    const urls = $('img[src*="/asura-images/chapters/"]')
      .map((_, el) => $(el).attr("src") || "")
      .get()
      .map((url) => toAbsoluteUrl(url, BASE_URL));
    const unique = [...new Set(urls)];
    if (!unique.length)
      throw new SourceError(
        "PARSE_ERROR",
        `${SOURCE_NAME} returned no readable pages for this chapter.`,
        SOURCE_ID,
      );
    const { limit, offset } = resolvePagination(pagination, {
      limit: unique.length,
    });
    return {
      items: unique
        .slice(offset, offset + limit)
        .map((image_url, i) => ({ index: offset + i + 1, image_url })),
      total: unique.length,
    };
  },
  async getFilters(): Promise<MangaFilter[]> {
    return structuredClone(filters);
  },
  async fetchMangaUpdates(id) {
    return source.fetchChapters(id);
  },
};
export default attachHtmlCatalogue(source, {
  getText: (path) => http.getText(path),
  parse: parseCards,
  path: ({ query, category, filters }) =>
    `/browse/comics?${browseParams(query || "", category, filters)}&page=1`,
  route: /^\/browse\/comics$/,
});
