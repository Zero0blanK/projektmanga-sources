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

/**
 * A chapter's number from its name. The number after "Chapter"/"Ch."/"Episode"/"Ep." (in
 * the languages these sources cover) wins, so "Vol. 2 Chapter 15" is 15, not 2; without
 * one, the last number in the name ("Season 2 - 10" is 10); without any, `fallback`.
 * A chapter whose name has no number (a prologue, an extra) gets the fallback rather than
 * failing the whole chapter list.
 */
export function chapterNumberFromName(name: string, fallback = 0): number {
  const keyword = name.match(
    /(?:chapitre|cap[ií]tulo|cap\.|chapter|chap\.?|ch\.?|episode|ep\.?|bab|#)\s*(\d+(?:[.,]\d+)?)/i,
  );
  const numbers = name.match(/\d+(?:[.,]\d+)?/g);
  const raw = keyword?.[1] ?? numbers?.[numbers.length - 1];
  if (!raw) return fallback;
  const value = Number(raw.replace(',', '.'));
  return Number.isFinite(value) ? value : fallback;
}

/** A Japanese relative date ("3日前", "5時間前", "2週間前") as an ISO string, or "". */
export function jaRelativeDateToIso(raw: string | undefined): string {
  const match = raw?.match(/(\d+)\s*(秒|分|時間|日|週間|ヶ月|か月|年)前/);
  if (!match) return "";
  const amount = Number(match[1]);
  const date = new Date();
  switch (match[2]) {
    case "秒": date.setSeconds(date.getSeconds() - amount); break;
    case "分": date.setMinutes(date.getMinutes() - amount); break;
    case "時間": date.setHours(date.getHours() - amount); break;
    case "日": date.setDate(date.getDate() - amount); break;
    case "週間": date.setDate(date.getDate() - amount * 7); break;
    case "ヶ月":
    case "か月": date.setMonth(date.getMonth() - amount); break;
    case "年": date.setFullYear(date.getFullYear() - amount); break;
  }
  return date.toISOString();
}

/** A Japanese series status: 連載中 is ongoing, 完結 completed. */
export function jaStatus(raw: string | undefined): string {
  if (!raw) return MANGA_STATUS.UNKNOWN;
  if (raw.includes("連載中")) return MANGA_STATUS.ONGOING;
  if (raw.includes("完結")) return MANGA_STATUS.COMPLETED;
  if (raw.includes("休載")) return MANGA_STATUS.HIATUS;
  return mapMangaStatus(raw);
}
