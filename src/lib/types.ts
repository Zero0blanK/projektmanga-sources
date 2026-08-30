/**
 * The extension contract, vendored.
 *
 * This is a type-only mirror of `packages/types/src/extension.ts` in the ProjektManga
 * monorepo. It lives here rather than being imported so this repository builds with no
 * dependency on the app's workspace packages — `npm install && npm run build` is all a
 * clone needs. Nothing here emits code, so the copy costs nothing at runtime.
 *
 * Keep it in sync when the app's `Source` interface changes: a mismatch shows up as a
 * source that installs fine and then returns data the reader can't render.
 */

export interface Mangas {
  id: string;
  slug: string;
  title: string;
  source: string;
  thumbnail_url: string;
}

export interface MangaDetails extends Mangas {
  author?: string[];
  artist?: string[];
  groups?: string[];
  description: string;
  genres: string[];
  status: string;
  chapters: Chapters[];
}

export interface Chapters {
  id: string;
  name: string;
  url: string;
  chapter_number: number;
  scanlator?: string;
  is_read?: boolean;
  is_bookmark?: boolean;
  last_page_read: number;
  fetched_at?: string;
  release_date: string;
  page_count?: number;
  language?: string;
  pages: Page[];
}

export interface Page {
  index: number;
  image_url: string | undefined;
}

export interface ChapterPagesResult<T> {
  items: T[];
  total: number;
}

export type Pagination = { limit: number; offset: number };

/** A tri-state filter's selections — "include this genre" vs "exclude it". */
export type TriStateFilterValue = { include?: string[]; exclude?: string[] };
export type FilterValue = string | number | boolean | string[] | TriStateFilterValue;
export type Option = { label: string; value: string };

export interface MangaFilter {
  label: string;
  value: string;
  type: 'input' | 'select' | 'checkbox' | 'radio' | 'multi' | 'tri-state';
  options?: Option[];
}

export interface Source {
  id: string;
  name: string;
  lang: string;
  base_url: string;
  isNSFW: boolean;

  fetchManga(
    category?: string,
    pagination?: Pagination,
    filters?: Record<string, FilterValue>,
  ): Promise<Mangas[]>;

  searchManga(
    query?: string,
    pagination?: Pagination,
    filters?: Record<string, FilterValue>,
  ): Promise<Mangas[]>;

  fetchMangaDetails(manga_id: string): Promise<MangaDetails>;

  fetchMangaThumbnail?(manga_id: string): Promise<string>;

  fetchChapters(manga_id: string): Promise<Chapters[]>;

  fetchChapterPages(
    chapter_id: string,
    manga_slug?: string,
    pagination?: Pagination,
  ): Promise<ChapterPagesResult<Page>>;

  getFilters(): Promise<MangaFilter[]>;

  /** Returns the source's current chapter list so the caller can diff it against what it
   * already stored. Extensions must never persist anything themselves. */
  fetchMangaUpdates(manga_slug: string): Promise<Chapters[]>;
}

export type SourceErrorCode =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'NOT_FOUND'
  | 'BLOCKED'
  | 'RATE_LIMITED'
  | 'PARSE_ERROR'
  | 'UPSTREAM_ERROR';

/** How much adult content a source carries.
 *
 *  - `safe`  — no adult content.
 *  - `mixed` — general catalogue that also carries adult titles. Shown by default; the
 *              app is expected to badge it, not hide it.
 *  - `nsfw`  — adult site. This is the only rating that sets `isNSFW` in the index, i.e.
 *              the only one a "hide NSFW sources" setting hides.
 *
 * Mirrors Mihon's `CONTENT_WARNING_SAFE / _MIXED / _NSFW`, which exists for the same
 * reason: one boolean cannot say "an aggregator with an adult corner" without either
 * hiding half the catalogue or under-warning the user. */
export type ContentRating = 'safe' | 'mixed' | 'nsfw';

/** The metadata half of an `index.json` entry. Each source declares one of these in its
 * own `manifest.json`; `build.mjs` reads them to generate the index, and the source
 * itself reads the same file so the two can never disagree.
 *
 * `build.mjs` validates every field below and rejects keys that appear here but are not
 * in `KNOWN_MANIFEST_KEYS`, so a typo fails the build instead of silently vanishing from
 * the listing. The generated entry carries more than this — `entry_url`, `version_code`,
 * `api_version`, `icon_url`, `isNSFW` and the bundle hash are all derived. See
 * `docs/repository-format.md`. */
export interface SourceManifest {
  /** Must equal the source's directory name: the bundle is published as `dist/<key>.js`. */
  source_key: string;
  name: string;
  /** BCP-47 code (`en`, `pt-BR`), or `all` for a source that is language-agnostic. */
  lang: string;
  /** `major.minor.patch`, each part 0-999. Bump it whenever the source's code changes. */
  version: string;
  base_url: string;
  /** Where a human should be sent to see the site, when that differs from `base_url` —
   * an API-backed source points `base_url` at the API. Optional; defaults to `base_url`. */
  homepage?: string;
  allowed_hosts: string[];
  content_rating: ContentRating;
  /** One line for the install listing. Optional, 200 characters max. */
  description?: string;
  /** Built but held out of `index.json`; `draft_reason` is then required. */
  draft?: boolean;
  draft_reason?: string;
}
