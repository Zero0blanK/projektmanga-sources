/**
 * Exercises built bundles against the live sites, the way the app would.
 *
 * This is the only honest way to check a scraper: selectors compile fine and still match
 * nothing. It deliberately mirrors two things the app's sandbox does, so a bundle that
 * passes here has no excuse to fail there:
 *
 *  - the bundle is loaded with a dynamic `import()` and must default-export an object
 *    whose `fetchManga` is a function;
 *  - every outbound request is checked against that source's `allowed_hosts` (exact match
 *    or subdomain), and a request to anything else is refused — the same rule
 *    `spawnSandboxedSource.ts` enforces.
 *
 * It does NOT reproduce the sandbox's Node permission flags, so a bundle that quietly
 * relies on real network access would pass here and fail there. Nothing in this repository
 * does — everything goes through `fetch`.
 *
 * Usage:
 *   node scripts/smoke.mjs                 # every source
 *   node scripts/smoke.mjs mangadex        # just one
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const only = process.argv.slice(2);

const realFetch = globalThis.fetch;

function installAllowlist(allowedHosts) {
  globalThis.fetch = async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const { hostname } = new URL(href);
    const allowed = allowedHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
    if (!allowed) {
      throw new TypeError(`Host "${hostname}" is not in this source's allowlist`);
    }
    return realFetch(input, init);
  };
}

function preview(value) {
  if (Array.isArray(value)) {
    return `${value.length} item(s)`;
  }
  if (value && typeof value === 'object') {
    return JSON.stringify(value).slice(0, 160);
  }
  return String(value);
}

async function step(label, fn) {
  const startedAt = Date.now();
  try {
    const result = await fn();
    console.log(`  ok   ${label.padEnd(22)} ${preview(result)} (${Date.now() - startedAt}ms)`);
    return { ok: true, result };
  } catch (error) {
    console.log(`  FAIL ${label.padEnd(22)} ${error?.message ?? error}`);
    return { ok: false, error };
  }
}

async function smokeOne(entry) {
  console.log(`\n=== ${entry.source_key} (${entry.name})`);
  installAllowlist(entry.allowed_hosts);

  const bundleUrl = pathToFileURL(path.join(ROOT, 'dist', `${entry.source_key}.js`)).href;
  const mod = await import(bundleUrl);
  const source = mod.default;

  if (!source || typeof source.fetchManga !== 'function') {
    console.log('  FAIL bundle does not default-export a valid Source');
    return false;
  }
  if (source.id !== entry.source_key) {
    console.log(`  WARN bundle id "${source.id}" does not match index.json source_key`);
  }

  const results = [];

  const browse = await step('fetchManga(popular)', () =>
    source.fetchManga('popular', { limit: 5, offset: 0 }, {}),
  );
  results.push(browse.ok && Array.isArray(browse.result) && browse.result.length > 0);

  const first = browse.ok ? browse.result?.[0] : undefined;
  if (first) {
    console.log(`       first: ${first.id} — ${first.title}`);
  }

  results.push((await step('getFilters()', () => source.getFilters())).ok);
  results.push((await step('searchManga()', () => source.searchManga('a', { limit: 5, offset: 0 }, {}))).ok);

  if (!first) {
    return results.every(Boolean);
  }

  const details = await step('fetchMangaDetails()', () => source.fetchMangaDetails(first.id));
  if (details.ok) {
    const value = details.result;
    console.log(
      `       title="${value.title}" status=${value.status} genres=${value.genres?.length ?? 0} chapters=${value.chapters?.length ?? 0} cover=${value.thumbnail_url ? 'yes' : 'MISSING'}`,
    );
    results.push(Boolean(value.title) && value.title !== 'No Title');
  } else {
    results.push(false);
  }

  // A title can legitimately have no chapters (MangaDex delists licensed series, for
  // one), so an empty list on the first result is not proof the parser is broken. Walk a
  // few candidates before calling it a failure.
  let chapters = { ok: false, result: [] };
  let chapterManga = first;
  for (const candidate of browse.result.slice(0, 3)) {
    chapterManga = candidate;
    chapters = await step(`fetchChapters(${candidate.id.slice(0, 12)})`, () =>
      source.fetchChapters(candidate.id),
    );
    if (chapters.ok && chapters.result?.length > 0) {
      break;
    }
  }
  results.push(chapters.ok && chapters.result?.length > 0);

  const chapter = chapters.ok ? chapters.result?.[0] : undefined;
  if (chapter) {
    console.log(
      `       chapter: id=${chapter.id} number=${chapter.chapter_number} date=${chapter.release_date || 'none'}`,
    );
    const pages = await step('fetchChapterPages()', () =>
      source.fetchChapterPages(chapter.id, chapterManga.slug, { limit: 3, offset: 0 }),
    );
    if (pages.ok) {
      console.log(`       total=${pages.result.total} first=${pages.result.items?.[0]?.image_url}`);
    }
    results.push(pages.ok && pages.result?.items?.length > 0);
  }

  return results.every(Boolean);
}

async function main() {
  // Read the manifests rather than index.json, so a draft source (built but deliberately
  // unlisted) can still be tested by name.
  const dirs = await readdir(path.join(ROOT, 'src'), { withFileTypes: true });
  const entries = [];
  for (const dir of dirs) {
    if (!dir.isDirectory()) {
      continue;
    }
    const manifestPath = path.join(ROOT, 'src', dir.name, 'manifest.json');
    const manifest = await readFile(manifestPath, 'utf8').then(JSON.parse, () => null);
    if (!manifest) {
      continue;
    }
    if (only.length === 0 ? !manifest.draft : only.includes(manifest.source_key)) {
      entries.push(manifest);
    }
  }

  const failed = [];
  for (const entry of entries) {
    const ok = await smokeOne(entry).catch((error) => {
      console.log(`  FAIL ${error?.message ?? error}`);
      return false;
    });
    if (!ok) {
      failed.push(entry.source_key);
    }
  }

  globalThis.fetch = realFetch;

  console.log(`\n${entries.length - failed.length}/${entries.length} source(s) fully passed.`);
  if (failed.length > 0) {
    console.log(`Needs attention: ${failed.join(', ')}`);
    process.exitCode = 1;
  }
}

main();
