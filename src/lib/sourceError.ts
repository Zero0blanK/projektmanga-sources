import type { SourceErrorCode } from './types.js';
import { CLOUDFLARE_PATTERNS, CAPTCHA_PATTERNS } from './detectionPatterns.js';

/**
 * Thrown by a source instead of silently returning an empty/fake result, so the app can
 * tell "this manga has no chapters" apart from "the source is unreachable / blocking us /
 * changed its layout".
 *
 * Worth knowing when reading logs: the sandbox IPC boundary
 * (`apps/extensions/sandbox/runner.ts`) forwards only `error.message` back to the server —
 * `code`, `reason` and `detail` do not survive the trip, so the server sees a plain Error.
 * `message` is therefore written to stand on its own as end-user text, and the structured
 * fields are kept for the day that boundary learns to carry them.
 */
export class SourceError extends Error {
  code: SourceErrorCode;
  sourceId: string;
  statusCode?: number;
  /** Short label for the *specific* failure within `code` — "Cloudflare challenge"
   * rather than just "Blocked". */
  reason?: string;
  /** The underlying technical message, kept separate from `message`, which is written
   * for the end user. */
  detail?: string;
  /** Request URL with the query string stripped — some sources put tokens there. */
  url?: string;

  constructor(
    code: SourceErrorCode,
    message: string,
    sourceId: string,
    options?: {
      statusCode?: number;
      cause?: unknown;
      reason?: string;
      detail?: string;
      url?: string;
    },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'SourceError';
    this.code = code;
    this.sourceId = sourceId;
    this.statusCode = options?.statusCode;
    this.reason = options?.reason;
    this.detail = options?.detail;
    this.url = options?.url;
  }
}

/** Names the specific block, so "Blocked" isn't the whole story. */
export function describeBlock(body: string, status?: number): string {
  if (/ddos-guard/i.test(body)) {
    return 'DDoS-Guard challenge';
  }
  if (CLOUDFLARE_PATTERNS.some((pattern) => pattern.test(body))) {
    return 'Cloudflare challenge';
  }
  if (CAPTCHA_PATTERNS.some((pattern) => pattern.test(body))) {
    return 'CAPTCHA required';
  }
  return status === 403 ? 'Forbidden (403)' : 'Service unavailable (503)';
}

/** Strips the query string — some sources carry API tokens there, and the path alone is
 * what is diagnostic. */
export function safeUrl(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = new URL(raw);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return raw.split('?')[0];
  }
}

/**
 * Classifies a non-2xx HTTP response. `bodySnippet` is the first few KB of the body —
 * enough for the Cloudflare/CAPTCHA patterns, without dragging a megabyte of HTML into
 * an error object.
 */
export function classifyHttpStatus(
  status: number,
  bodySnippet: string,
  sourceId: string,
  sourceName: string,
  url?: string,
): SourceError {
  const safe = safeUrl(url);
  const detail = `HTTP ${status} from ${safe ?? sourceName}`;

  if (status === 404) {
    return new SourceError('NOT_FOUND', `Not found on ${sourceName}.`, sourceId, {
      statusCode: status,
      reason: 'HTTP 404',
      detail,
      url: safe,
    });
  }

  if (status === 429) {
    return new SourceError(
      'RATE_LIMITED',
      `Too many requests to ${sourceName}. Please wait and try again.`,
      sourceId,
      { statusCode: status, reason: 'HTTP 429', detail, url: safe },
    );
  }

  if (status === 401 || status === 403 || status === 503) {
    const reason = status === 401 ? 'Unauthorized (401)' : describeBlock(bodySnippet, status);
    return new SourceError(
      'BLOCKED',
      `${sourceName} blocked this request (anti-bot protection). Try again later.`,
      sourceId,
      { statusCode: status, reason, detail, url: safe },
    );
  }

  if (status >= 500) {
    return new SourceError('UPSTREAM_ERROR', `${sourceName} returned a server error.`, sourceId, {
      statusCode: status,
      reason: `HTTP ${status}`,
      detail,
      url: safe,
    });
  }

  return new SourceError(
    'UPSTREAM_ERROR',
    `${sourceName} returned an unexpected response (${status}).`,
    sourceId,
    { statusCode: status, reason: `HTTP ${status}`, detail, url: safe },
  );
}

/**
 * Classifies anything thrown while making a request or parsing its result.
 *
 * The sandbox fetch shim rethrows the *parent's* failure as a `TypeError` carrying only a
 * message string — the undici error code never crosses the IPC boundary — so the network
 * branches match on message text rather than on `error.code`. The two sandbox-specific
 * messages are worth naming explicitly: both mean this extension's own `allowed_hosts` is
 * wrong, which no amount of retrying fixes.
 */
export function classifyRequestError(
  error: unknown,
  sourceId: string,
  sourceName: string,
  url?: string,
): SourceError {
  if (error instanceof SourceError) {
    return error;
  }

  const detail = error instanceof Error ? error.message : String(error);
  const safe = safeUrl(url);

  const allowlistMatch = /Host "([^"]+)" is not in this source/.exec(detail);
  if (allowlistMatch) {
    return new SourceError(
      'BLOCKED',
      `${sourceName} tried to contact ${allowlistMatch[1]}, which this extension is not allowed to reach. Its allowed_hosts list needs updating.`,
      sourceId,
      { reason: 'Host missing from allowed_hosts', detail, url: safe },
    );
  }

  if (/Blocked by outbound URL validation/i.test(detail)) {
    return new SourceError(
      'BLOCKED',
      `A request from ${sourceName} was blocked because it resolved to a non-public address.`,
      sourceId,
      { reason: 'Blocked by the app SSRF guard', detail, url: safe },
    );
  }

  if (/timed out|timeout/i.test(detail)) {
    return new SourceError('TIMEOUT', `${sourceName} took too long to respond. Try again.`, sourceId, {
      reason: 'Request timed out',
      detail,
      url: safe,
    });
  }

  if (/Too many redirects/i.test(detail)) {
    return new SourceError('UPSTREAM_ERROR', `${sourceName} redirected too many times.`, sourceId, {
      reason: 'Redirect loop',
      detail,
      url: safe,
    });
  }

  if (/fetch failed|network|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN/i.test(detail)) {
    return new SourceError(
      'NETWORK_ERROR',
      `Could not reach ${sourceName}. Check your internet connection or try again later.`,
      sourceId,
      { reason: 'No response from host', detail, url: safe },
    );
  }

  // Not a network failure — most likely a selector or JSON-shape assumption that no
  // longer matches what the source actually returned.
  const reason = /json|unexpected token/i.test(detail)
    ? 'Malformed JSON response'
    : /no matching|selector|element/i.test(detail)
      ? 'Expected elements missing from page'
      : 'Unexpected response shape';

  return new SourceError(
    'PARSE_ERROR',
    `${sourceName} returned unexpected data — it may have changed its layout.`,
    sourceId,
    { cause: error, reason, detail },
  );
}
