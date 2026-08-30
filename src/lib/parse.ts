/** Plain-string status vocabulary. The app stores whatever string a source returns; these
 * are the values it knows how to render. */
export const MANGA_STATUS = {
  ONGOING: 'ONGOING',
  COMPLETED: 'COMPLETED',
  HIATUS: 'HIATUS',
  CANCELLED: 'CANCELLED',
  UNKNOWN: 'UNKNOWN',
} as const;

/** Resolves a scraped href/src against a source's base URL. */
export function toAbsoluteUrl(url: string, baseUrl: string): string {
  if (!url) {
    return '';
  }
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url;
  }
  if (url.startsWith('//')) {
    return `https:${url}`;
  }
  if (url.startsWith('/')) {
    return `${baseUrl}${url}`;
  }
  return `${baseUrl}/${url}`;
}

export function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Fuzzy-matches a scraped status label against MANGA_STATUS. */
export function mapMangaStatus(raw: string): string {
  const normalized = raw.trim().toLowerCase();

  if (normalized.includes('ongoing')) {
    return MANGA_STATUS.ONGOING;
  }
  if (normalized.includes('complete')) {
    return MANGA_STATUS.COMPLETED;
  }
  if (normalized.includes('hiatus')) {
    return MANGA_STATUS.HIATUS;
  }
  if (normalized.includes('cancel')) {
    return MANGA_STATUS.CANCELLED;
  }

  return MANGA_STATUS.UNKNOWN;
}

function parseRelativeDateToIso(raw: string): string {
  const text = raw.replace(/\u00A0/g, ' ').toLowerCase();
  const matches = [...text.matchAll(/(\d+)\s*(year|month|week|day|hour|minute|second)s?/g)];
  if (matches.length === 0) {
    return '';
  }

  const now = Date.now();
  let deltaMs = 0;

  for (const match of matches) {
    const amount = Number.parseInt(match[1], 10);
    if (!Number.isFinite(amount) || amount <= 0) {
      continue;
    }

    switch (match[2]) {
      case 'year':
        deltaMs += amount * 365 * 24 * 60 * 60 * 1000;
        break;
      case 'month':
        deltaMs += amount * 30 * 24 * 60 * 60 * 1000;
        break;
      case 'week':
        deltaMs += amount * 7 * 24 * 60 * 60 * 1000;
        break;
      case 'day':
        deltaMs += amount * 24 * 60 * 60 * 1000;
        break;
      case 'hour':
        deltaMs += amount * 60 * 60 * 1000;
        break;
      case 'minute':
        deltaMs += amount * 60 * 1000;
        break;
      case 'second':
        deltaMs += amount * 1000;
        break;
      default:
        break;
    }
  }

  if (deltaMs <= 0) {
    return '';
  }

  return new Date(now - deltaMs).toISOString();
}

/** Parses either an absolute date string or a relative one ("3 days ago") into ISO-8601.
 * Returns '' when neither form matches — an empty release date is how the app already
 * represents "unknown", so a wrong guess is worse than none. */
export function parseDateToIso(raw: string): string {
  if (!raw) {
    return '';
  }

  const cleaned = raw
    .replace(/\u00A0/g, ' ')
    .replace(/\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\./gi, '$1')
    .replace(/\ba\.m\./i, 'AM')
    .replace(/\bp\.m\./i, 'PM')
    .trim();

  const parsed = new Date(cleaned);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }

  return parseRelativeDateToIso(cleaned);
}

/** Normalizes the `pagination` argument. The app's sandbox transport passes whatever the
 * caller gave it, including `undefined` — a source that reads `pagination.limit`
 * unguarded crashes on those calls. */
export function resolvePagination(
  pagination: { limit: number; offset: number } | undefined,
  defaults: { limit: number; offset?: number },
): { limit: number; offset: number } {
  const limit = Number.isFinite(pagination?.limit) ? Number(pagination?.limit) : defaults.limit;
  const offset = Number.isFinite(pagination?.offset) ? Number(pagination?.offset) : (defaults.offset ?? 0);
  return { limit: Math.max(0, limit), offset: Math.max(0, offset) };
}
