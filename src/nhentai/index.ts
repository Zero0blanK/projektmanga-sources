import type {
  Source,
  Mangas,
  Chapters,
  MangaFilter,
  Page,
  MangaDetails,
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

  async fetchManga(category, pagination): Promise<Mangas[]> {
    try {
      const { limit, offset } = resolvePagination(pagination, { limit: 25 });
      const page = Math.floor(offset / Math.max(1, limit)) + 1;
      const sort = category === 'popular' ? 'popular' : 'date';

      const json = await http.getJson<{ result?: SearchResult[] }>('/search', {
        params: { query: 'english', sort, page },
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

  async searchManga(query, pagination): Promise<Mangas[]> {
    try {
      const { limit, offset } = resolvePagination(pagination, { limit: 25 });
      const page = Math.floor(offset / Math.max(1, limit)) + 1;

      const json = await http.getJson<{ result?: SearchResult[] }>('/search', {
        params: { query: query || 'english', sort: 'date', page },
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
    return [];
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
