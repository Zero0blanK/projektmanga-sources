import type {
  Source,
  Mangas,
  Chapters,
  MangaFilter,
  Page,
  MangaDetails,
  FilterValue,
  Option,
  ChapterPagesResult,
  SourceManifest,
} from '../lib/types.js';
import { HttpClient, JSON_HEADERS } from '../lib/http.js';
import { MANGA_STATUS, resolvePagination } from '../lib/parse.js';
import { SourceError, classifyRequestError } from '../lib/sourceError.js';
import { deriveIsNSFW } from '../lib/manifest.js';
import manifest from './manifest.json';

const { source_key: SOURCE_ID, name: SOURCE_NAME, lang: SOURCE_LANG } = manifest as SourceManifest;

const API_URL = 'https://nhentai.net/api/v2';
const IMAGE_SERVER = 'https://i.nhentai.net';
const THUMBNAIL_SERVER = 'https://t.nhentai.net';

const http = new HttpClient({
  sourceId: SOURCE_ID,
  sourceName: SOURCE_NAME,
  baseUrl: API_URL,
  headers: JSON_HEADERS,
  rateLimitMs: 220,
});

interface SearchResult {
  id: number;
  english_title?: string;
  japanese_title?: string;
  thumbnail: string;
}

interface GalleryTag {
  type: string;
  name: string;
}

interface Gallery {
  title: { english?: string; japanese?: string; pretty?: string };
  cover?: { path?: string };
  tags?: GalleryTag[];
  pages?: Array<{ number: number; path: string }>;
  num_pages?: number;
  num_favorites?: number;
  upload_date?: number;
  scanlator?: string;
}

function tagNames(tags: GalleryTag[] | undefined, type: string): string[] {
  return (tags ?? []).filter((tag) => tag.type === type).map((tag) => tag.name);
}

/**
 * The search fields, as free text rather than pick-lists.
 *
 * nhentai has tens of thousands of tags, artists and groups and no endpoint that
 * enumerates them, so any static list would be both enormous and immediately out of date.
 * Its search language already solves this: every field below is a documented `field:value`
 * operator on the same query string, so typing is the interface — the same approach
 * Mihon/Tachiyomi's extension takes.
 *
 * Each accepts a comma-separated list, and a leading `-` excludes:
 *
 *     big breasts, full color, -yaoi   ->   tag:"big breasts" tag:"full color" -tag:yaoi
 *
 * Verified against the API: `tag:"full color"` returns 82,911 results and
 * `tag:"full color" -tag:"yaoi"` returns 79,628, so exclusion genuinely narrows rather
 * than being accepted and ignored.
 */
const QUERY_FIELDS: Array<{ label: string; value: string; operator: string; hint: string }> = [
  { label: 'Tags', value: 'tags', operator: 'tag', hint: 'big breasts, full color, -yaoi' },
  { label: 'Categories', value: 'categories', operator: 'category', hint: 'doujinshi, -manga' },
  { label: 'Artists', value: 'artists', operator: 'artist', hint: 'shindol' },
  { label: 'Groups', value: 'groups', operator: 'group', hint: 'da hootch' },
  { label: 'Parodies', value: 'parodies', operator: 'parody', hint: 'blue archive' },
  { label: 'Characters', value: 'characters', operator: 'character', hint: 'asuna' },
  { label: 'Languages', value: 'languages', operator: 'language', hint: 'english, -chinese' },
];

const SORT_OPTIONS: Option[] = [
  { label: 'Recent', value: 'date' },
  { label: 'Popular (all time)', value: 'popular' },
  { label: 'Popular (this month)', value: 'popular-month' },
  { label: 'Popular (this week)', value: 'popular-week' },
  { label: 'Popular (today)', value: 'popular-today' },
];

/** Multi-word values have to be quoted or the site reads only the first word as the value
 * and the rest as separate free-text terms. */
function quoteTerm(term: string): string {
  return /\s/.test(term) ? `"${term}"` : term;
}

/** Turns one comma-separated field into its `operator:value` terms, honouring a leading
 * `-` on any entry as an exclusion. */
function fieldToTerms(operator: string, raw: string): string[] {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const negated = part.startsWith('-');
      const value = (negated ? part.slice(1) : part).trim();
      return value ? `${negated ? '-' : ''}${operator}:${quoteTerm(value)}` : '';
    })
    .filter(Boolean);
}

/**
 * Assembles the whole search query: the reader's own words plus every filled-in field.
 *
 * `fallback` is used when that produces nothing, because /search needs *some* query — it is
 * a search endpoint, not a listing one, and an empty query returns nothing rather than
 * everything.
 */
function buildQuery(
  freeText: string | undefined,
  filters: Record<string, FilterValue> | undefined,
  fallback: string,
): string {
  const active = filters ?? {};
  const parts: string[] = [];

  const text = typeof freeText === 'string' ? freeText.trim() : '';
  if (text) parts.push(text);

  for (const field of QUERY_FIELDS) {
    const raw = active[field.value];
    if (typeof raw === 'string' && raw.trim()) {
      parts.push(...fieldToTerms(field.operator, raw));
    }
  }

  // Free-form because the site's own syntax here is an operator, not a value: ">50",
  // "<20", "20-30" are all valid and none of them is a list.
  const pages = active.pages;
  if (typeof pages === 'string' && pages.trim()) {
    parts.push(`pages:${pages.trim()}`);
  }

  return parts.join(' ').trim() || fallback;
}

/** One gallery response backs details, thumbnail, chapters and pages — four calls that
 * would otherwise each hit the API for the same document. */
async function getGallery(galleryId: string): Promise<Gallery> {
  const gallery = await http.getJson<Gallery>(`/galleries/${galleryId}/`);
  if (!gallery || typeof gallery !== 'object' || !gallery.title) {
    throw new SourceError(
      'PARSE_ERROR',
      `${SOURCE_NAME} returned unexpected data — it may have changed its API.`,
      SOURCE_ID,
    );
  }
  return gallery;
}

const nhentai: Source = {
  id: SOURCE_ID,
  name: SOURCE_NAME,
  lang: SOURCE_LANG,
  base_url: manifest.base_url,
  isNSFW: deriveIsNSFW(manifest.content_rating),

  async fetchManga(category, pagination, filters): Promise<Mangas[]> {
    try {
      const { limit, offset } = resolvePagination(pagination, { limit: 25 });
      const page = Math.floor(offset / Math.max(1, limit)) + 1;
      const active = filters as Record<string, FilterValue> | undefined;
      const chosenSort = active?.sort;
      const sort =
        typeof chosenSort === 'string' && chosenSort
          ? chosenSort
          : category === 'popular'
            ? 'popular'
            : 'date';

      // "english" is a browse-shaped stand-in for "no query", not a language preference the
      // reader asked for — /search has no way to say "everything", so browsing needs some
      // term. Any filter the reader sets replaces it.
      const json = await http.getJson<{ result?: SearchResult[] }>('/search', {
        params: { query: buildQuery(undefined, active, 'english'), sort, page },
      });

      return (json.result ?? []).map((item) => ({
        source: SOURCE_ID,
        id: String(item.id),
        slug: String(item.id),
        title: item.english_title || item.japanese_title || 'Unknown Title',
        thumbnail_url: `${THUMBNAIL_SERVER}/${item.thumbnail}`,
      }));
    } catch (error) {
      throw classifyRequestError(error, SOURCE_ID, SOURCE_NAME);
    }
  },

  async searchManga(query, pagination, filters): Promise<Mangas[]> {
    try {
      const { limit, offset } = resolvePagination(pagination, { limit: 25 });
      const page = Math.floor(offset / Math.max(1, limit)) + 1;
      const active = filters as Record<string, FilterValue> | undefined;
      const chosenSort = active?.sort;
      const sort = typeof chosenSort === 'string' && chosenSort ? chosenSort : 'date';

      // The typed words and the filter fields go into one query string, so searching
      // "school" with Tags = "full color" narrows rather than discarding one of them.
      const json = await http.getJson<{ result?: SearchResult[] }>('/search', {
        params: { query: buildQuery(query, active, 'english'), sort, page },
      });

      return (json.result ?? []).map((item) => ({
        source: SOURCE_ID,
        id: String(item.id),
        slug: String(item.id),
        title: item.english_title || item.japanese_title || 'Unknown Title',
        thumbnail_url: `${THUMBNAIL_SERVER}/${item.thumbnail}`,
      }));
    } catch (error) {
      throw classifyRequestError(error, SOURCE_ID, SOURCE_NAME);
    }
  },

  async fetchMangaDetails(mangaId: string): Promise<MangaDetails> {
    try {
      const gallery = await getGallery(mangaId);

      const categories = tagNames(gallery.tags, 'category').join(', ');
      const parodies = tagNames(gallery.tags, 'parody').join(', ');
      const characters = tagNames(gallery.tags, 'character').join(', ');

      const description = [
        'Alternative Titles:',
        gallery.title.english ?? '',
        gallery.title.japanese ?? '',
        gallery.title.pretty ?? '',
        '',
        `Parodies: ${parodies}`,
        `Characters: ${characters}`,
        `Categories: ${categories}`,
        `Pages: ${gallery.num_pages ?? 0}`,
        `Favorites: ${gallery.num_favorites ?? 0}`,
      ].join('\n');

      return {
        source: SOURCE_ID,
        id: mangaId,
        slug: mangaId,
        title: gallery.title.english || gallery.title.japanese || gallery.title.pretty || 'Unknown Title',
        thumbnail_url: gallery.cover?.path ? `${THUMBNAIL_SERVER}/${gallery.cover.path}` : '',
        description,
        artist: tagNames(gallery.tags, 'artist'),
        groups: tagNames(gallery.tags, 'group'),
        genres: tagNames(gallery.tags, 'tag'),
        // A gallery is a finished one-shot — there is no such thing as an ongoing one.
        status: MANGA_STATUS.COMPLETED,
        chapters: toChapters(mangaId, gallery),
      };
    } catch (error) {
      throw classifyRequestError(error, SOURCE_ID, SOURCE_NAME);
    }
  },

  async fetchMangaThumbnail(mangaId: string): Promise<string> {
    try {
      const gallery = await getGallery(mangaId);
      return gallery.cover?.path ? `${THUMBNAIL_SERVER}/${gallery.cover.path}` : '';
    } catch {
      return '';
    }
  },

  async fetchChapters(mangaId: string): Promise<Chapters[]> {
    try {
      return toChapters(mangaId, await getGallery(mangaId));
    } catch (error) {
      throw classifyRequestError(error, SOURCE_ID, SOURCE_NAME);
    }
  },

  async fetchChapterPages(chapter_id, _manga_slug, pagination): Promise<ChapterPagesResult<Page>> {
    try {
      const gallery = await getGallery(chapter_id);
      const allPages = gallery.pages ?? [];
      const total = allPages.length;

      if (total === 0) {
        throw new SourceError(
          'PARSE_ERROR',
          `${SOURCE_NAME} returned no readable pages for this gallery.`,
          SOURCE_ID,
        );
      }

      const { limit, offset } = resolvePagination(pagination, { limit: 4 });
      const start = Math.min(offset, total);
      const end = Math.min(start + Math.max(1, limit), total);

      return {
        items: allPages.slice(start, end).map((page, idx) => ({
          index: start + idx + 1,
          image_url: `${IMAGE_SERVER}/${page.path}`,
        })),
        total,
      };
    } catch (error) {
      throw classifyRequestError(error, SOURCE_ID, SOURCE_NAME);
    }
  },

  async getFilters(): Promise<MangaFilter[]> {
    // Text fields rather than option lists — see QUERY_FIELDS for why. `input` is the app's
    // fallback filter control, which renders exactly the free-text box these need.
    return [
      { label: 'Sort by', value: 'sort', type: 'select', options: SORT_OPTIONS },
      ...QUERY_FIELDS.map(
        (field): MangaFilter => ({
          label: `${field.label} (comma-separated, - to exclude)`,
          value: field.value,
          type: 'input',
        }),
      ),
      { label: 'Pages (e.g. >50, <20, 20-30)', value: 'pages', type: 'input' },
    ];
  },

  async fetchMangaUpdates(manga_slug: string): Promise<Chapters[]> {
    return nhentai.fetchChapters(manga_slug);
  },
};

/** A gallery is a single chapter. Kept as a helper so details/chapters/updates all
 * describe it identically. */
function toChapters(mangaId: string, gallery: Gallery): Chapters[] {
  return [
    {
      id: mangaId,
      chapter_number: 0,
      url: `${manifest.base_url}/g/${mangaId}/1`,
      name: '',
      scanlator: gallery.scanlator || 'Unknown',
      language: SOURCE_LANG,
      page_count: gallery.num_pages ?? 0,
      last_page_read: 0,
      release_date: gallery.upload_date ? new Date(gallery.upload_date * 1000).toISOString() : '',
      pages: [],
    },
  ];
}

export default nhentai;
