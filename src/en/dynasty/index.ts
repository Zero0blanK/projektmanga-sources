// Dynasty Scans: series, their chapters and pages through the site's own JSON (the
// `.json` form of each page). Endpoints and fields follow the Keiyoushi extension
// (Apache-2.0); see THIRD_PARTY_NOTICES.md. Anthologies, doujins and issues, which the
// site also hosts, are not browsed here.
import { load } from "cheerio/slim";
import { HttpClient, JSON_HEADERS, NAV_HEADERS } from "../../lib/http.js";
import { TTLCache } from "../../lib/cache.js";
import { deriveIsNSFW } from "../../lib/manifest.js";
import {
  MANGA_STATUS,
  chapterNumberFromName,
  mapMangaStatus,
  normalizeText,
  resolvePagination,
} from "../../lib/parse.js";
import { collectSequentialPages } from "../../lib/sequentialPagination.js";
import { SourceError } from "../../lib/sourceError.js";
import type {
  Chapters,
  Mangas,
  Source,
  SourceManifest,
} from "../../lib/types.js";
import manifest from "./manifest.json";

const SOURCE = manifest as SourceManifest;
const BASE = SOURCE.base_url;
const PERMALINK = /^[a-z0-9_]{1,200}$/;
const CHAPTER_PREFIX = `${SOURCE.source_key}:`;

interface Tag {
  type: string;
  name: string;
  permalink: string;
}
interface ChapterRow {
  title?: string;
  permalink?: string;
  released_on?: string;
  tags?: Tag[];
  header?: string;
}
interface Series {
  name: string;
  permalink: string;
  cover?: string | null;
  description?: string | null;
  tags?: Tag[];
  taggings?: ChapterRow[];
}

const http = new HttpClient({
  sourceId: SOURCE.source_key,
  sourceName: SOURCE.name,
  baseUrl: BASE,
  headers: { ...JSON_HEADERS, Referer: `${BASE}/` },
  rateLimitMs: 400,
});
const series = new TTLCache<string, Series>(30_000, 40);

const fail = (message: string): never => {
  throw new SourceError(
    "PARSE_ERROR",
    `${SOURCE.name}: ${message}`,
    SOURCE.source_key,
  );
};
const checked = (value: string, what: string) =>
  PERMALINK.test(value) ? value : fail(`Invalid ${what} identifier`);
const absolute = (path?: string | null) =>
  path ? new URL(path, BASE).href : "";

function seriesOf(id: string) {
  return series.getOrSet(id, () =>
    http.getJson<Series>(`/series/${checked(id, "title")}.json`),
  );
}

function chaptersOf(data: Series): Chapters[] {
  let volume = "";
  const rows: Chapters[] = [];
  for (const row of data.taggings ?? []) {
    // Volume headings sit between the chapters they group.
    if (row.header) {
      volume = row.header;
      continue;
    }
    if (!row.permalink || !PERMALINK.test(row.permalink) || !row.title)
      continue;
    const scanlators = (row.tags ?? []).filter(
      (tag) => tag.type === "Scanlator",
    );
    rows.push({
      id: `${CHAPTER_PREFIX}${row.permalink}`,
      name:
        volume && !row.title.includes(volume)
          ? `${volume} ${row.title}`
          : row.title,
      url: `${BASE}/chapters/${row.permalink}`,
      chapter_number: chapterNumberFromName(row.title, 0),
      scanlator: scanlators.map((tag) => tag.name).join(", ") || undefined,
      release_date: row.released_on
        ? new Date(`${row.released_on}T00:00:00Z`).toISOString()
        : "",
      language: SOURCE.lang,
      last_page_read: 0,
      pages: [],
    });
  }
  return rows.sort((a, b) => b.chapter_number - a.chapter_number);
}

/** The latest releases, one card per series. */
async function latest(page: number): Promise<Mangas[]> {
  const data = await http.getJson<{ chapters?: ChapterRow[] }>(
    `/chapters/added.json?page=${page - 1}`,
  );
  const cards = new Map<string, Mangas>();
  for (const chapter of data.chapters ?? []) {
    const tag = chapter.tags?.find((entry) => entry.type === "Series");
    if (!tag || !PERMALINK.test(tag.permalink) || cards.has(tag.permalink))
      continue;
    cards.set(tag.permalink, {
      id: tag.permalink,
      slug: tag.permalink,
      title: tag.name,
      source: SOURCE.source_key,
      thumbnail_url: "",
    });
  }
  return [...cards.values()];
}

/** Series matching `query`, from the site's search page. */
async function search(query: string, page: number): Promise<Mangas[]> {
  const url = new URL("/search", BASE);
  url.searchParams.set("q", query);
  url.searchParams.append("classes[]", "Series");
  url.searchParams.set("page", String(page));
  const $ = load(await http.getText(url.href, { headers: NAV_HEADERS }));
  return $("a.name[href^='/series/']")
    .toArray()
    .flatMap((el) => {
      const id = ($(el).attr("href") ?? "").slice("/series/".length);
      const title = normalizeText($(el).text());
      return PERMALINK.test(id) && title
        ? [
            {
              id,
              slug: id,
              title,
              source: SOURCE.source_key,
              thumbnail_url: "",
            },
          ]
        : [];
    });
}

const source: Source = {
  id: SOURCE.source_key,
  name: SOURCE.name,
  lang: SOURCE.lang,
  base_url: BASE,
  isNSFW: deriveIsNSFW(SOURCE.content_rating),
  // The site has no popularity ranking: both orders are its latest releases.
  async fetchManga(_category, pagination) {
    return collectSequentialPages(
      resolvePagination(pagination, { limit: 30 }),
      SOURCE.source_key,
      latest,
    );
  },
  async searchManga(query = "", pagination) {
    if (!query.trim()) return source.fetchManga("latest", pagination);
    return collectSequentialPages(
      resolvePagination(pagination, { limit: 30 }),
      SOURCE.source_key,
      (page) => search(query.trim(), page),
    );
  },
  async fetchMangaDetails(id) {
    const data = await seriesOf(id);
    const tags = data.tags ?? [];
    const statuses = tags
      .filter((tag) => tag.type === "Status")
      .map((tag) => tag.name);
    return {
      id,
      slug: id,
      source: SOURCE.source_key,
      url: `${BASE}/series/${id}`,
      title: data.name || fail("Missing title metadata"),
      thumbnail_url: absolute(data.cover),
      description: normalizeText(load(data.description ?? "").text()),
      author: tags
        .filter((tag) => tag.type === "Author")
        .map((tag) => tag.name),
      genres: tags
        .filter((tag) => tag.type === "General")
        .map((tag) => tag.name),
      status: statuses.length
        ? mapMangaStatus(statuses.join(" ").replace(/licensed/i, ""))
        : MANGA_STATUS.UNKNOWN,
      chapters: chaptersOf(data),
    };
  },
  async fetchMangaThumbnail(id) {
    try {
      return absolute((await seriesOf(id)).cover);
    } catch {
      return "";
    }
  },
  async fetchChapters(id) {
    return chaptersOf(await seriesOf(id));
  },
  async fetchChapterPages(chapterId, _slug, pagination) {
    if (!chapterId.startsWith(CHAPTER_PREFIX))
      return fail("Invalid chapter identifier");
    const permalink = checked(
      chapterId.slice(CHAPTER_PREFIX.length),
      "chapter",
    );
    const data = await http.getJson<{ pages?: Array<{ url?: string }> }>(
      `/chapters/${permalink}.json`,
    );
    const images = (data.pages ?? [])
      .map((page) => absolute(page.url))
      .filter(Boolean);
    if (images.length === 0) return fail("This chapter has no pages");
    const { limit, offset } = resolvePagination(pagination, {
      limit: images.length,
    });
    const start = Math.min(offset, images.length);
    return {
      items: images
        .slice(start, start + Math.max(1, limit))
        .map((image_url, index) => ({ index: start + index + 1, image_url })),
      total: images.length,
    };
  },
  async getFilters() {
    return [];
  },
  async fetchMangaUpdates(id) {
    series.clear();
    return source.fetchChapters(id);
  },
};

export default source;
