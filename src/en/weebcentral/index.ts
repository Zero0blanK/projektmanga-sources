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
import { filters, searchParams } from "./filters.js";

const SOURCE_ID = manifest.source_key;
const SOURCE_NAME = manifest.name;
const BASE_URL = manifest.base_url;
const PAGE_SIZE = 32;
const http = new HttpClient({
  sourceId: SOURCE_ID,
  sourceName: SOURCE_NAME,
  baseUrl: BASE_URL,
  rateLimitMs: 250,
});

function parseCards(html: string): Mangas[] {
  const $ = load(html);
  const cards = $('a[href*="/series/"]')
    .map((_, el) => {
      const link = $(el);
      const href = link.attr("href") || "";
      const match = href.match(/\/series\/([0-9A-HJKMNP-TV-Z]{26})(?:\/|$)/i);
      if (!match) return null;
      const id = match[1].toUpperCase();
      const image = link.find("img").first();
      const title = normalizeText(
        image.attr("alt")?.replace(/\s+cover$/i, "") || link.text(),
      );
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

function parseChapters(html: string): Chapters[] {
  const $ = load(html);
  const links = $('a[href^="/chapters/"]');
  // The list is newest first, so an unnumbered chapter's position counts down from the
  // total rather than up from 1.
  const total = links.length;
  return links
    .map((index, el) => {
      const link = $(el);
      const href = link.attr("href") || "";
      const id = href.split("/").filter(Boolean).at(-1) || "";
      if (!id) return null;
      const label = link
        .find("span")
        .filter((_, el) => $(el).children().length === 0)
        .map((_, el) => normalizeText($(el).text()))
        .get()
        .find(Boolean);
      const name = label || normalizeText(link.text());
      const date = link.find("time").attr("datetime") || "";
      // A digit must come first: "[\d.]+" matched the "." in "Episode. 85", which parsed
      // as NaN and fell back to list position, numbering every chapter backwards.
      const number = Number.parseFloat(name.match(/\d+(?:\.\d+)?/)?.[0] || "");
      return {
        id,
        name,
        url: toAbsoluteUrl(href, BASE_URL),
        chapter_number: Number.isFinite(number) ? number : total - index,
        scanlator: "Unknown",
        language: manifest.lang,
        last_page_read: 0,
        release_date: parseDateToIso(date),
        page_count: 0,
        pages: [],
      } as Chapters;
    })
    .get()
    .filter((chapter): chapter is Chapters => chapter !== null);
}

async function fetchText(path: string): Promise<string> {
  return http.getText(path);
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
    const params = searchParams("", category, active);
    return collectPaged(
      { limit, offset, sitePageSize: PAGE_SIZE },
      async (page) =>
        parseCards(
          await fetchText(
            `/search/data?${params}&limit=${PAGE_SIZE}&offset=${(page - 1) * PAGE_SIZE}`,
          ),
        ),
    );
  },
  async searchManga(query, pagination, active) {
    if (!query?.trim()) return [];
    const { limit, offset } = resolvePagination(pagination, {
      limit: PAGE_SIZE,
    });
    const params = searchParams(query?.trim() || "", undefined, active);
    return collectPaged(
      { limit, offset, sitePageSize: PAGE_SIZE },
      async (page) =>
        parseCards(
          await fetchText(
            `/search/data?${params}&limit=${PAGE_SIZE}&offset=${(page - 1) * PAGE_SIZE}`,
          ),
        ),
    );
  },
  async fetchMangaDetails(id): Promise<MangaDetails> {
    const $ = load(await fetchText(`/series/${encodeURIComponent(id)}`));
    const title = normalizeText($("h1").first().text());
    const image = $('img[src*="/cover/"]').first();
    const chapters = await source.fetchChapters(id);
    const label = (name: string) =>
      normalizeText(
        $("li")
          .filter((_, el) => $(el).find("strong").text().includes(`${name}:`))
          .first()
          .text()
          .replace(new RegExp(`^.*${name}:`), ""),
      );
    // Series facts are `<li><strong>Label:</strong> …</li>` rows. Lists are links when the
    // site links them (tags, authors) and plain comma-separated text otherwise.
    const row = (...names: string[]) =>
      $("li").filter((_, el) => {
        const strong = normalizeText($(el).find("strong").first().text()).replace(/:$/, "");
        return names.includes(strong);
      });
    const list = (...names: string[]) => {
      const item = row(...names).first();
      const links = item
        .find("a")
        .map((_, el) => normalizeText($(el).text()))
        .get()
        .filter(Boolean);
      if (links.length) return [...new Set(links)];
      const text = normalizeText(item.text()).replace(/^[^:]*:/, "");
      return [...new Set(text.split(",").map((part) => normalizeText(part)).filter(Boolean))];
    };
    const description = normalizeText(
      row("Description").find("p").first().text() ||
        $('[class*="description"], [id*="description"]').first().text(),
    );
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
      url: toAbsoluteUrl(`/series/${encodeURIComponent(id)}`, BASE_URL),
      title,
      thumbnail_url: toAbsoluteUrl(
        image.attr("src") || image.attr("data-src") || "",
        BASE_URL,
      ),
      description,
      // Weeb Central lists writers and artists together as "Author(s)".
      author: list("Author(s)", "Author", "Authors"),
      artist: list("Artist(s)", "Artist", "Artists"),
      genres: list("Tags(s)", "Tags", "Genres", "Genre(s)"),
      status: mapMangaStatus(label("Status")),
      chapters,
    };
  },
  async fetchMangaThumbnail(id) {
    try {
      const $ = load(await fetchText(`/series/${encodeURIComponent(id)}`));
      return toAbsoluteUrl(
        $('img[src*="/cover/"]').first().attr("src") || "",
        BASE_URL,
      );
    } catch {
      return "";
    }
  },
  async fetchChapters(id) {
    return parseChapters(
      await fetchText(`/series/${encodeURIComponent(id)}/full-chapter-list`),
    );
  },
  async fetchChapterPages(
    chapterId,
    _slug,
    pagination,
  ): Promise<ChapterPagesResult<Page>> {
    // The chapter shell loads the image fragment separately through HTMX.
    const $ = load(
      await fetchText(
        `/chapters/${encodeURIComponent(chapterId)}/images?is_prev=False`,
      ),
    );
    const urls = $("img[src], img[data-src]")
      .map((_, el) => $(el).attr("src") || $(el).attr("data-src") || "")
      .get()
      .filter(
        (url) =>
          /\.(?:png|jpe?g|webp)(?:\?|$)/i.test(url) &&
          !url.includes("/static/images/"),
      )
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
  getText: fetchText,
  parse: parseCards,
  path: ({ query, category, filters }) =>
    `/search/data?${searchParams(query || "", category, filters)}&limit=32&offset=0`,
  route: /^\/search\/data$/,
  next: (text) => {
    const $ = load(text);
    return $("[hx-get]")
      .toArray()
      .map((el) => $(el).attr("hx-get"))
      .find(
        (value) =>
          value?.startsWith("/search/data?") && value.includes("offset="),
      );
  },
});
