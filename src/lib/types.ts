/**
 * The extension contract, vendored.
 *
 * This is a type-only mirror of `shared/types/extension.ts` in the ProjektManga
 * repository, which is the canonical definition. It lives here rather than being imported
 * so this repository builds with no dependency on the app — `npm install && npm run build`
 * is all a clone needs. Nothing here emits code, so the copy costs nothing at runtime.
 *
 * The one deliberate divergence: the app types `MangaDetails.status` as its Prisma
 * `MangaStatus` enum. Mirroring that would drag Prisma into this repository for a single
 * union, so `status` is a plain `string` here and the app validates it at the boundary
 * where an installed source's response is parsed.
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
  release_date: string;
  page_count?: number;
  language?: string;
  pages: Page[];

  /** App-side bookkeeping. A source never sets these — the app fills them in from its own
   * database once the chapter has been stored, read, filtered or de-duplicated. They are
   * listed here only so this type stays assignable to the app's. */
  is_read?: boolean;
  is_bookmark?: boolean;
  is_filtered?: boolean;
  is_duplicate?: boolean;
  last_page_read: number;
  fetched_at?: string;
}

export interface Page {
  index: number;
  image_url: string | undefined;

  /** App-side bookkeeping, as on `Chapters`: the download worker fills these in after it
   * has fetched the image. A source returns `index` and `image_url` and nothing else. */
  local_path?: string;
  retryable?: boolean;
  hash?: string;
  fileSize?: number;
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

/** Only these four render. The app's filter UI switches on exactly this union
 * (`src/features/discover/components/CustomInput.tsx`,
 * `src/components/common/Dropdown/Dropdown.tsx`); a source that returns anything else
 * produces a filter the reader silently drops. */
export interface MangaFilter {
  label: string;
  value: string;
  type: 'input' | 'select' | 'multi' | 'tri-state';
  options?: Option[];
}

export interface Source {
  id: string;
  name: string;
  lang: string;
  base_url: string;
  isNSFW: boolean;

  /** Optional origins, when a source splits its traffic across more than one. Declare every
   * host any of these point at in `allowed_hosts`, exactly as for `base_url`. */
  api_url?: string;
  image_server?: string;
  thumbnail_server?: string;

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

  /** Optional. A download-oriented variant of `fetchChapterPages` that can report progress
   * and honour cancellation. The app falls back to `fetchChapterPages` when a source
   * doesn't implement it, so this is purely an optimisation.
   *
   * `signal` is a real `AbortSignal` here — the app passes it in across the sandbox
   * boundary rather than the source constructing one, which is why this works where
   * `fetch(url, { signal })` does not. */
  fetchChapterPagesForDownload?(
    chapter_id: string,
    options?: {
      onProgress?: (current: number, total: number) => void;
      signal?: AbortSignal;
      maxRetries?: number;
      fallbackUrls?: boolean;
    },
  ): Promise<Page[]>;

  /** Optional. How the app's download worker should retry this source's images. */
  getRetryStrategy?(): {
    maxRetries: number;
    delayMs: number;
    backoffMultiplier: number;
    pageRetryable: boolean;
  };

  /** Optional. Shaping hints for the download worker.
   *
   * `requestsPerSecond` is advisory only: the host enforces the manifest's `rate_limit_ms`
   * regardless of what this returns, since an installed source cannot be trusted to
   * throttle itself. `bytesPerSecond` and `concurrent` are the dimensions the manifest
   * does not carry, and are the reason to implement this at all. */
  getRateLimitInfo?(): {
    requestsPerSecond: number;
    bytesPerSecond?: number;
    concurrent?: number;
  };
}

/** The elevated capability, injected as a global by the sandbox runner — and *only* when
 * the source's manifest sets `requires_browser_fetch: true`. It asks the app to fetch a URL
 * in a real browser on the source's behalf, applying the app's anti-detection stack
 * (proxy rotation, fingerprinting, Cloudflare clearance) and returning the rendered HTML.
 *
 * Reach for it only when a site cannot be read any other way: it is far slower than
 * `fetch`, it is capped by a small global browser pool shared across every source that
 * requests it, and the app warns the user before installing a source that declares it.
 * `allowed_hosts` applies here exactly as it does to `fetch`. */
declare global {
  // eslint-disable-next-line no-var
  var __browserFetch: undefined | ((url: string, opts?: { waitSelector?: string }) => Promise<string>);
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

  /** Minimum milliseconds between this source's requests, enforced by the app on the
   * trusted side of the sandbox. A source that rate-limits itself internally should
   * declare the same number here: the internal limiter keeps the source well-behaved, and
   * this one is what actually holds once the source is code the app didn't write.
   * Optional; the app applies a conservative default when absent. */
  rate_limit_ms?: number;

  /** Requests the elevated `__browserFetch` capability (see the `Source` interface). The
   * runner injects that global only for sources that set this, and the app shows the user
   * a warning before installing one. Set it only for a site that genuinely cannot be read
   * with plain `fetch` — an active Cloudflare challenge, typically. */
  requires_browser_fetch?: boolean;

  /** `Referer` the app should send when it fetches this source's images through its proxy.
   * Defaults to `homepage`, then `base_url`. Set it only when a site rejects those. */
  referer?: string;

  /** Built but held out of `index.json`; `draft_reason` is then required. */
  draft?: boolean;
  draft_reason?: string;
}
