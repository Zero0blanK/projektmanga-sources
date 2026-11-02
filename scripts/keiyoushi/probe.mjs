// Every function of one built source, called the way the app's sandbox calls it.
// Usage (cwd = projektmanga-sources): node scripts/keiyoushi/probe.mjs <source_key>  → one JSON line
// Live: a few dozen requests to that one site. Used to accept generated and hand ports.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const key = process.argv[2];
const { allowlistedFetch } = await import(pathToFileURL(path.join(ROOT, 'scripts/allowlisted-fetch.mjs')).href);
const { discoverSourceDirectories } = await import(pathToFileURL(path.join(ROOT, 'scripts/source-layout.mjs')).href);
const manifest = (await discoverSourceDirectories(ROOT)).map((s) => s.manifest).find((m) => m.source_key === key);
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => allowlistedFetch(input, init, manifest.allowed_hosts, realFetch);
const source = (await import(pathToFileURL(path.join(ROOT, 'dist', `${key}.js`)).href)).default;

const LIMIT = 20;
const STEP_MS = 45_000;
const BLOCK = /\b(403|503|429|520|521|522|523|525|526)\b|cloudflare|challenge|just a moment|captcha|forbidden|blocked|anti-bot|ddos/i;
const out = { key, lang: manifest.lang, checks: [] };
const add = (name, status, detail = '') => out.checks.push({ name, status, detail: String(detail).slice(0, 220) });
const timed = (fn) => {
  let t;
  return Promise.race([fn(), new Promise((_, rej) => (t = setTimeout(() => rej(new Error(`timed out after ${STEP_MS / 1000}s`)), STEP_MS)))]).finally(() => clearTimeout(t));
};
const failure = (e) => {
  const msg = String(e?.message ?? e);
  return BLOCK.test(msg) ? ['BLOCKED', msg] : /took too long|timed out/i.test(msg) ? ['SLOW', msg] : ['FAIL', msg];
};

/** Copy of apps/extensions/sandbox/runner.ts sourceCataloguePage. */
async function page(search, value, pagination = {}, filters) {
  const limit = pagination.limit ?? 20;
  const native = search ? source.searchMangaPage : source.fetchMangaPage;
  if (typeof native === 'function') return native.call(source, value, pagination, filters);
  const offset = Number((pagination.cursor ?? 'legacy:0').slice('legacy:'.length));
  const method = search ? source.searchManga : source.fetchManga;
  const rows = await method.call(source, value, { limit: limit + 1, offset }, filters);
  if (!Array.isArray(rows)) throw new Error('Source returned an invalid catalogue');
  const items = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  return { items, hasMore, ...(hasMore ? { nextCursor: `legacy:${offset + items.length}` } : {}) };
}

/** Pages through a list the way "load more" does and judges it. */
async function walk(name, search, value, filters, pages) {
  const seen = new Set();
  const steps = [];
  let cursor;
  try {
    for (let i = 0; i < pages; i += 1) {
      const result = await timed(() => page(search, value, { limit: LIMIT, ...(cursor ? { cursor } : {}) }, filters));
      const ids = result.items.map((m) => m.id);
      const fresh = ids.filter((id) => !seen.has(id)).length;
      ids.forEach((id) => seen.add(id));
      steps.push({ n: ids.length, fresh, hasMore: result.hasMore, items: i === 0 ? result.items : undefined });
      if (!result.hasMore || !result.nextCursor) break;
      cursor = result.nextCursor;
    }
  } catch (e) {
    const [status, msg] = failure(e);
    add(name, status, `page ${steps.length + 1}: ${msg}`);
    return { steps, failed: true };
  }
  const summary = steps.map((s) => `${s.n}${s.hasMore ? '+' : ''}${s.fresh < s.n ? `(${s.n - s.fresh} rep)` : ''}`).join(' → ');
  const [first, ...rest] = steps;
  if (!first.n) add(name, 'EMPTY', 'first page empty');
  else if (!first.hasMore && first.n >= LIMIT) add(name, 'FAIL', `full first page but no more: ${summary}`);
  else if (rest.some((s) => s.fresh === 0 && s.n > 0)) add(name, 'FAIL', `a later page repeated earlier titles: ${summary}`);
  else if (rest.some((s) => s.n === 0 && s.hasMore)) add(name, 'FAIL', `empty page that still says more: ${summary}`);
  else if (pages > 1 && first.hasMore && rest.length && rest[rest.length - 1].n === 0) add(name, 'WARN', `last page empty (end of catalogue): ${summary}`);
  else add(name, 'ok', summary);
  return { steps, first: first.items ?? [] };
}

const ids = (items) => new Set(items.map((m) => m.id));
const differs = (a, b) => a.length !== b.length || a.some((m) => !b.some((x) => x.id === m.id));

let caps = null;
try {
  caps = typeof source.getCapabilities === 'function' ? await timed(() => source.getCapabilities()) : null;
} catch (e) {
  add('capabilities', ...failure(e));
}

const popular = await walk('popular', false, 'popular', undefined, 3);
const latest = caps && caps.latest === false ? (add('latest', 'n/a', 'source has no latest list'), null) : await walk('latest', false, 'latest', undefined, 3);
const base = popular.first?.length ? popular.first : latest?.first ?? [];

let filters = [];
try {
  filters = (await timed(() => source.getFilters())) ?? [];
  add('getFilters', 'ok', `${filters.length} filters`);
} catch (e) {
  add('getFilters', ...failure(e));
}

if (base.length) {
  // Search: a distinctive word (or a whole title, for scripts without spaces) from a real title.
  const words = (t) => (t.match(/[A-Za-zÀ-ÿ]{5,}/g) ?? []).filter((w) => !/^(chapter|season|volume|manga|manhwa|comic)$/i.test(w));
  let term;
  let target;
  for (const m of base.slice(0, 8)) {
    const w = words(m.title ?? '').sort((a, b) => b.length - a.length)[0];
    if (w) { term = w; target = m; break; }
  }
  if (!term) { target = base[0]; term = target.title; }
  const fold = (s) => (s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const search = await walk(`search "${term}"`, true, term, undefined, 2);
  if (search.first?.length) {
    const matching = search.first.filter((m) => fold(m.title).includes(fold(term))).length;
    if (!matching && !search.first.some((m) => m.id === target.id)) {
      const last = out.checks[out.checks.length - 1];
      last.status = 'FAIL';
      last.detail = `results do not contain the term: ${search.first.slice(0, 3).map((m) => m.title).join(' | ')}`;
    }
  }

  // Every filter, one at a time, on its first real option; sort options each on their own.
  for (const f of filters) {
    const options = (f.options ?? []).filter((o) => o.value !== '' && !/^(all|any|default|none)$/i.test(o.label));
    const isSort = /^(sort|order|orderby|sortby|sort_by|m_orderby)$/i.test(f.value) || /^(sort|order)/i.test(f.label);
    let tries;
    if (f.type === 'input') tries = [];
    else if (f.type === 'checkbox') tries = [{ label: 'on', value: true }];
    // A common option (Action, Manhwa) can leave a catalogue's top page unchanged, so a
    // filter is only called ignored when its last option changes nothing either.
    else tries = isSort ? options : [...new Set([options[0], options[options.length - 1]])].filter(Boolean);
    if (!tries.length) { add(`filter ${f.label}`, 'n/a', `${f.type} filter`); continue; }
    for (const [index, o] of tries.entries()) {
      if (!isSort && index > 0 && out.checks[out.checks.length - 1].status === 'ok') break;
      if (!isSort && index > 0) out.checks.pop();
      const value = f.type === 'multi' ? [o.value] : f.type === 'tri-state' ? { include: [o.value] } : o.value;
      const name = `${isSort ? 'sort' : 'filter'} ${f.label}=${o.label}`;
      const res = await walk(name, false, 'popular', { [f.value]: value }, 2);
      const last = out.checks[out.checks.length - 1];
      if (!res.failed && res.first?.length && !isSort && !differs(res.first, base) && last.status === 'ok') {
        last.status = 'FAIL';
        last.detail = `same titles as with no filter: ${last.detail}`;
      }
      if (!res.failed && res.first && !res.first.length && last.status === 'EMPTY') last.status = 'WARN';
    }
  }

  // Reading: details, chapters, pages and the first image.
  let read = false;
  for (const m of base.slice(0, 3)) {
    try {
      const details = await timed(() => source.fetchMangaDetails(m.id));
      if (!details?.title) throw new Error('details without a title');
      const chapters = await timed(() => source.fetchChapters(m.id));
      if (!chapters?.length) continue;
      add('details', 'ok', `${details.title.slice(0, 40)} · ${details.genres?.length ?? 0} genres · cover ${details.thumbnail_url ? 'yes' : 'NO'}`);
      add('chapters', 'ok', `${chapters.length} chapters`);
      const pages = await timed(() => source.fetchChapterPages(chapters[0].id, m.slug, { limit: 3, offset: 0 }));
      if (!pages?.items?.length) { add('chapter pages', 'FAIL', 'no pages'); read = true; break; }
      add('chapter pages', 'ok', `${pages.total} pages`);
      const image = pages.items[0].image_url;
      const response = await realFetch(image, { headers: { Referer: `${manifest.base_url}/`, ...(pages.items[0].headers ?? {}) }, signal: AbortSignal.timeout(30000) });
      const head = Buffer.from(await response.arrayBuffer()).subarray(0, 16);
      const isImage = /^image\//.test(response.headers.get('content-type') ?? '') || head[0] === 0xff || head.subarray(1, 4).toString() === 'PNG' || head.subarray(8, 12).toString() === 'WEBP' || head.subarray(0, 3).toString() === 'GIF';
      add('page image', response.ok && isImage ? 'ok' : 'FAIL', `${response.status} ${response.headers.get('content-type')}`);
      read = true;
      break;
    } catch (e) {
      add('reading', ...failure(e));
      read = true;
      break;
    }
  }
  if (!read) add('chapters', 'FAIL', 'none of the first 3 titles has chapters');
}

process.stdout.write(JSON.stringify(out) + '\n');
process.exit(0);
