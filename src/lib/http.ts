import { classifyHttpStatus, classifyRequestError, SourceError } from './sourceError.js';

/**
 * The one way a source in this repository talks to the network.
 *
 * Inside the app's sandbox the process has **no** real network access: `runner.ts`
 * replaces the global `fetch` with a shim that proxies every call back to the parent over
 * IPC. So `fetch` is the only thing that works here — axios, `node:https` or any library
 * that opens its own socket will fail — and this client is what the axios layer in
 * `apps/extensions/config/axios.config.ts` becomes once that constraint is applied:
 * rate limiting, retries, timeouts and error classification, all on top of plain `fetch`.
 *
 * Two shim behaviours shape the implementation:
 * - `init.signal` is not forwarded, so a timeout cannot actually abort the parent's
 *   request. `withTimeout` therefore *races* rather than aborts: the caller stops waiting,
 *   and the orphaned response is discarded when it eventually arrives.
 * - Only string request bodies survive the trip. Nothing here sends a body, but keep it in
 *   mind before adding a POST.
 */

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;
/** Response bodies can be megabytes of HTML; only a slice is ever useful for classifying
 * a block page. */
const ERROR_BODY_SNIPPET_BYTES = 4_000;

const FALLBACK_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0';

/** The header set `config/req.config.ts` calls a "navigation" request in the monorepo.
 * Sources here are scraping pages a browser would load, so they send what a browser
 * sends — minus the per-request user-agent rotation, which needs state the sandbox has no
 * way to keep. */
export const NAV_HEADERS: Record<string, string> = {
  'User-Agent': FALLBACK_UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
};

export const JSON_HEADERS: Record<string, string> = {
  'User-Agent': FALLBACK_UA,
  Accept: 'application/json,text/plain;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

export interface HttpClientOptions {
  sourceId: string;
  sourceName: string;
  baseUrl: string;
  headers?: Record<string, string>;
  /** Minimum gap between two requests from this client, in ms. */
  rateLimitMs?: number;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface RequestOptions {
  params?: Record<string, unknown>;
  headers?: Record<string, string>;
  /** Overrides the default `key=value` serialization — MangaDex needs `includes[]=x`
   * style arrays. */
  paramsSerializer?: (params: Record<string, unknown>) => string;
  timeoutMs?: number;
  /** Set to 0 to disable retries for a request that is allowed to fail fast (e.g.
   * probing whether a next page exists). */
  maxRetries?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Races the request against a timer. See the note at the top of the file on why this
 * cannot be a real abort. */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout of ${timeoutMs}ms exceeded${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function defaultSerializeParams(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => search.append(key, String(item)));
      continue;
    }
    search.append(key, String(value));
  }
  return search.toString();
}

export class HttpClient {
  private readonly sourceId: string;
  private readonly sourceName: string;
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly rateLimitMs: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  /** Requests are chained onto this promise so the configured interval is respected
   * across concurrent callers, not just sequential ones. */
  private tail: Promise<void> = Promise.resolve();

  constructor(options: HttpClientOptions) {
    this.sourceId = options.sourceId;
    this.sourceName = options.sourceName;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.headers = options.headers ?? NAV_HEADERS;
    this.rateLimitMs = options.rateLimitMs ?? 0;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  resolveUrl(path: string, params?: Record<string, unknown>, serializer?: RequestOptions['paramsSerializer']): string {
    const absolute = /^https?:\/\//i.test(path);
    const base = absolute ? path : `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    if (!params || Object.keys(params).length === 0) {
      return base;
    }
    const query = (serializer ?? defaultSerializeParams)(params);
    if (!query) {
      return base;
    }
    return base.includes('?') ? `${base}&${query}` : `${base}?${query}`;
  }

  /** Serializes requests to at most one per `rateLimitMs`, with jitter so a source never
   * sees a perfectly periodic cadence. */
  private schedule<T>(run: () => Promise<T>): Promise<T> {
    const result = this.tail.then(run);
    this.tail = result.then(
      async () => {
        if (this.rateLimitMs > 0) {
          await sleep(this.rateLimitMs + Math.random() * this.rateLimitMs * 0.3);
        }
      },
      async () => {
        if (this.rateLimitMs > 0) {
          await sleep(this.rateLimitMs);
        }
      },
    );
    return result;
  }

  /**
   * Performs the request and returns the successful `Response`. Any non-2xx status or
   * transport failure is thrown as a classified `SourceError`; a 5xx, a 429 or a network
   * failure is retried with exponential backoff and full jitter first.
   */
  async get(path: string, options: RequestOptions = {}): Promise<Response> {
    const url = this.resolveUrl(path, options.params, options.paramsSerializer);
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const maxRetries = options.maxRetries ?? this.maxRetries;
    const headers = { ...this.headers, ...(options.headers ?? {}) };

    let lastError: SourceError | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        // Full jitter on top of exponential backoff, so retries from one source do not
        // all land back on the origin in lockstep.
        const backoff = DEFAULT_RETRY_DELAY_MS * 2 ** (attempt - 1);
        await sleep(Math.random() * backoff);
      }

      try {
        const response = await this.schedule(() =>
          withTimeout(fetch(url, { method: 'GET', headers }), timeoutMs, ` fetching ${path}`),
        );

        if (response.ok) {
          return response;
        }

        // Read a slice of the body so a 403/503 can be told apart from a Cloudflare
        // challenge page. `text()` on an error response is cheap relative to the retry.
        const body = await response.text().catch(() => '');
        lastError = classifyHttpStatus(
          response.status,
          body.slice(0, ERROR_BODY_SNIPPET_BYTES),
          this.sourceId,
          this.sourceName,
          url,
        );
      } catch (error) {
        lastError = classifyRequestError(error, this.sourceId, this.sourceName, url);
      }

      const retryable =
        lastError.code === 'NETWORK_ERROR' ||
        lastError.code === 'TIMEOUT' ||
        lastError.code === 'RATE_LIMITED' ||
        (lastError.code === 'UPSTREAM_ERROR' && (lastError.statusCode ?? 0) >= 500);

      if (!retryable) {
        throw lastError;
      }
    }

    throw lastError ?? new SourceError('NETWORK_ERROR', `Could not reach ${this.sourceName}.`, this.sourceId);
  }

  async getText(path: string, options: RequestOptions = {}): Promise<string> {
    const response = await this.get(path, options);
    return response.text();
  }

  async getJson<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.get(path, options);
    const raw = await response.text();
    try {
      return JSON.parse(raw) as T;
    } catch (error) {
      throw classifyRequestError(error, this.sourceId, this.sourceName, this.resolveUrl(path));
    }
  }
}
