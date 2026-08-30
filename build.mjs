/**
 * Builds every source in src/ into a single self-contained ESM bundle, then regenerates
 * index.json from the per-source manifest.json files.
 *
 * Why the bundles have to be single files: the app downloads one URL per source and
 * `import()`s it inside a sandboxed child process that has no network and a filesystem
 * allowlist covering only its own bundle directory. Nothing is installed for it — every
 * dependency has to already be in the file.
 *
 * Why `platform: 'node'` rather than the `'neutral'` in the app's own docs: the sandbox
 * child *is* Node, and cheerio's dependencies reference a few node builtins. Marking them
 * external (which platform:'node' does) keeps them as plain `node:` imports the child can
 * resolve, instead of esbuild trying — and failing — to polyfill them. Loading a builtin
 * is not what `--permission` gates; performing a denied operation is, and nothing here
 * does.
 *
 * A manifest declares as little as possible: everything the app can work out — the URLs,
 * the numeric version code, the bundle hash, the NSFW boolean — is derived here so two
 * hand-maintained fields can never contradict each other. `docs/repository-format.md`
 * documents every field this writes, and `schema/` carries the same contract as JSON
 * Schema for editors and for the app's own validation.
 */
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(ROOT, 'src');
const DIST_DIR = path.join(ROOT, 'dist');
const ICONS_DIR = path.join(DIST_DIR, 'icons');

/**
 * The shape of index.json itself. Bump it only for a change that would make an older app
 * misread the file — renaming or removing a field, or changing what one means. Adding an
 * optional field is not a bump: readers are expected to ignore what they don't know.
 * The app should refuse a `format_version` above the one it was written for.
 */
const INDEX_FORMAT_VERSION = 1;

/**
 * The extension contract in `src/lib/types.ts` that every bundle here compiles against —
 * Mihon calls the same idea `extensionLib`. Bump it when that interface changes in a way
 * that a source built against the old one cannot satisfy, so an older app can skip a
 * source it would only fail to drive.
 */
const EXTENSION_API_VERSION = 1;

/** The app rejects any bundle above this; fail here instead of at install time. */
const MAX_BUNDLE_BYTES = 10 * 1024 * 1024;
/** Icons are decoration in a list — anything this big is a mistake, not an icon. */
const MAX_ICON_BYTES = 512 * 1024;

const CONTENT_RATINGS = ['safe', 'mixed', 'nsfw'];
const REQUIRED_MANIFEST_FIELDS = [
  'source_key',
  'name',
  'lang',
  'version',
  'base_url',
  'allowed_hosts',
  'content_rating',
];
/** Anything outside this set is a typo. Silently ignoring it would drop the field from
 * the listing with no error anywhere. */
const KNOWN_MANIFEST_KEYS = new Set([
  ...REQUIRED_MANIFEST_FIELDS,
  '$schema',
  'homepage',
  'description',
  'draft',
  'draft_reason',
]);

/** In preference order: the first one found is the source's icon. */
const ICON_FILES = ['icon.svg', 'icon.png', 'icon.webp'];

const SEMVER = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
/** BCP-47 enough for our purposes: `en`, `pt-BR`, `zh-Hant`. `all` is the wildcard Mihon
 * uses for a source that serves every language from one endpoint. */
const LANG = /^([a-z]{2,3}(-[A-Za-z0-9]{2,8})*|all)$/;
const SOURCE_KEY = /^[a-z0-9][a-z0-9-]*$/;
/** A bare hostname: no scheme, no port, no path, no wildcard. */
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

class BuildError extends Error {}

function fail(where, message) {
  throw new BuildError(`${where}: ${message}`);
}

/**
 * A single sortable integer, the thing the app actually compares to decide "newer".
 * `major * 1e6 + minor * 1e3 + patch`, which is why each part is capped at 999 — the
 * same trick Android's versionCode conventions use. Derived, never authored: two
 * hand-written version fields drift the first time someone bumps one of them.
 */
function versionCodeOf(where, version) {
  const match = SEMVER.exec(String(version));
  if (!match) {
    fail(where, `version "${version}" must be major.minor.patch with each part 0-999`);
  }
  const [, major, minor, patch] = match;
  return Number(major) * 1_000_000 + Number(minor) * 1_000 + Number(patch);
}

/** The rule `src/lib/manifest.ts` applies at runtime. Keep the two in step: `mixed` is
 * deliberately not NSFW, so a general catalogue with an adult corner stays visible under
 * a "hide NSFW sources" setting and gets badged instead. */
function deriveIsNSFW(contentRating) {
  return contentRating === 'nsfw';
}

/** Exact match or subdomain — the same rule the sandbox and the smoke runner enforce. */
function hostCoveredBy(hostname, allowedHosts) {
  return allowedHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

function requireHttpsUrl(where, field, value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(where, `${field} "${value}" is not a URL`);
  }
  if (url.protocol !== 'https:') {
    fail(where, `${field} must be https (got "${value}")`);
  }
  return url;
}

async function readRepoConfig() {
  const config = JSON.parse(await readFile(path.join(ROOT, 'repo.config.json'), 'utf8'));

  const fromEnv = process.env.RAW_BASE_URL?.trim();
  const rawBaseUrl = (fromEnv || String(config.raw_base_url || '').trim()).replace(/\/+$/, '');
  if (!rawBaseUrl) {
    fail('repo.config.json', 'missing "raw_base_url" (and no RAW_BASE_URL in the environment)');
  }

  // A tunnel URL is http-only often enough that we only warn there; the published one has
  // to be https, because the app refuses to fetch anything else.
  if (!fromEnv) {
    requireHttpsUrl('repo.config.json', 'raw_base_url', rawBaseUrl);
  }

  const repository = config.repository ?? {};
  if (!repository.name || typeof repository.name !== 'string') {
    fail('repo.config.json', 'repository.name is required — the app labels installed sources with it');
  }
  for (const [field, value] of Object.entries({
    website: repository.website,
    ...(repository.contact ?? {}),
  })) {
    if (value !== undefined) {
      requireHttpsUrl('repo.config.json', `repository.${field}`, value);
    }
  }
  if (repository.badge_label !== undefined && String(repository.badge_label).length > 6) {
    fail('repo.config.json', 'repository.badge_label is a chip in the UI — keep it to 6 characters');
  }

  return { rawBaseUrl, repository, usingEnvBase: Boolean(fromEnv) };
}

function validateManifest(dir, manifest) {
  const where = `src/${dir}/manifest.json`;

  // Unknown keys first: a misspelled required field should be reported as the typo it is,
  // not as the absence of the field it was meant to be.
  for (const key of Object.keys(manifest)) {
    if (!KNOWN_MANIFEST_KEYS.has(key)) {
      fail(where, `unknown field "${key}" — check the spelling against docs/repository-format.md`);
    }
  }
  for (const field of REQUIRED_MANIFEST_FIELDS) {
    if (manifest[field] === undefined) {
      fail(where, `missing "${field}"`);
    }
  }

  if (manifest.source_key !== dir) {
    fail(
      where,
      `declares source_key "${manifest.source_key}" — it must match the directory name, since the bundle is published as dist/${dir}.js`,
    );
  }
  if (!SOURCE_KEY.test(manifest.source_key)) {
    fail(where, `source_key "${manifest.source_key}" must be lowercase letters, digits and dashes`);
  }
  if (typeof manifest.name !== 'string' || manifest.name.trim() === '') {
    fail(where, 'name must be a non-empty string');
  }
  if (!LANG.test(manifest.lang)) {
    fail(where, `lang "${manifest.lang}" must be a BCP-47 code like "en" or "pt-BR", or "all"`);
  }
  if (!CONTENT_RATINGS.includes(manifest.content_rating)) {
    fail(where, `content_rating must be one of ${CONTENT_RATINGS.join(', ')}`);
  }
  if (manifest.description !== undefined) {
    if (typeof manifest.description !== 'string' || manifest.description.length > 200) {
      fail(where, 'description must be a string of at most 200 characters');
    }
  }

  const baseUrl = requireHttpsUrl(where, 'base_url', manifest.base_url);
  if (manifest.homepage !== undefined) {
    requireHttpsUrl(where, 'homepage', manifest.homepage);
  }

  if (!Array.isArray(manifest.allowed_hosts) || manifest.allowed_hosts.length === 0) {
    fail(where, 'needs at least one allowed_hosts entry');
  }
  if (manifest.allowed_hosts.length > 20) {
    fail(where, `allowed_hosts has ${manifest.allowed_hosts.length} entries — the app allows at most 20`);
  }
  for (const host of manifest.allowed_hosts) {
    if (typeof host !== 'string' || !HOSTNAME.test(host)) {
      fail(where, `allowed_hosts entry "${host}" must be a bare lowercase hostname — no scheme, port, path or wildcard`);
    }
  }
  if (new Set(manifest.allowed_hosts).size !== manifest.allowed_hosts.length) {
    fail(where, 'allowed_hosts has duplicate entries');
  }
  // Catches the commonest install-time failure there is: an allowlist that doesn't cover
  // the source's own base_url, so every request throws.
  if (!hostCoveredBy(baseUrl.hostname, manifest.allowed_hosts)) {
    fail(where, `base_url host "${baseUrl.hostname}" is not covered by allowed_hosts`);
  }

  if (manifest.draft !== undefined && typeof manifest.draft !== 'boolean') {
    fail(where, 'draft must be true or false');
  }
  if (manifest.draft && !manifest.draft_reason) {
    fail(where, 'draft sources need a draft_reason — it is the only record of why this is held back');
  }

  return versionCodeOf(where, manifest.version);
}

/** Every directory under src/ that holds an index.ts — src/lib is shared code, not a
 * source, and has none. */
async function discoverSources() {
  const entries = await readdir(SRC_DIR, { withFileTypes: true });
  const sources = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dir = path.join(SRC_DIR, entry.name);
    const entryPoint = path.join(dir, 'index.ts');
    const manifestPath = path.join(dir, 'manifest.json');

    const hasEntry = await stat(entryPoint).then(
      () => true,
      () => false,
    );
    if (!hasEntry) {
      continue;
    }

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const versionCode = validateManifest(entry.name, manifest);

    let icon = null;
    for (const candidate of ICON_FILES) {
      const iconPath = path.join(dir, candidate);
      const info = await stat(iconPath).catch(() => null);
      if (info) {
        if (info.size > MAX_ICON_BYTES) {
          fail(`src/${entry.name}/${candidate}`, `is ${(info.size / 1024).toFixed(0)} KB — icons are capped at 512 KB`);
        }
        icon = { path: iconPath, ext: path.extname(candidate) };
        break;
      }
    }

    sources.push({ dir: entry.name, entryPoint, manifest, versionCode, icon });
  }

  const keys = sources.map((source) => source.dir);
  if (new Set(keys).size !== keys.length) {
    fail('src/', 'two sources share a source_key');
  }

  return sources.sort((a, b) => a.dir.localeCompare(b.dir));
}

/**
 * Deletes anything in dist/ that this build didn't produce.
 *
 * Without it, deleting or renaming a source leaves its bundle sitting at a live raw URL:
 * gone from the listing, still installed and still updating for anyone who had it. The
 * CI check only catches files that *changed*, never ones that should no longer exist.
 */
async function pruneDist(expected) {
  const removed = [];

  for (const [dir, keep] of [
    [DIST_DIR, expected.bundles],
    [ICONS_DIR, expected.icons],
  ]) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory()) {
        continue; // dist/icons, handled by its own pass
      }
      if (!keep.has(entry.name)) {
        await rm(path.join(dir, entry.name));
        removed.push(path.relative(ROOT, path.join(dir, entry.name)).replaceAll('\\', '/'));
      }
    }
  }

  return removed;
}

async function main() {
  const { rawBaseUrl, repository, usingEnvBase } = await readRepoConfig();
  const sources = await discoverSources();

  if (sources.length === 0) {
    fail(SRC_DIR, 'no sources found');
  }

  await mkdir(ICONS_DIR, { recursive: true });

  const listing = [];
  const expected = { bundles: new Set(), icons: new Set() };

  for (const source of sources) {
    const bundleName = `${source.dir}.js`;
    const outfile = path.join(DIST_DIR, bundleName);
    expected.bundles.add(bundleName);

    await build({
      entryPoints: [source.entryPoint],
      outfile,
      bundle: true,
      format: 'esm', // required — the sandbox imports the bundle as an ES module
      platform: 'node',
      target: 'node20',
      minify: true,
      legalComments: 'none',
      logLevel: 'warning',
    });

    const bytes = await readFile(outfile);
    if (bytes.byteLength > MAX_BUNDLE_BYTES) {
      fail(
        `dist/${bundleName}`,
        `is ${(bytes.byteLength / 1024 / 1024).toFixed(2)} MB — the app refuses bundles over 10 MB`,
      );
    }

    const sha256 = createHash('sha256').update(bytes).digest('hex');
    console.log(
      `${source.dir.padEnd(12)} v${String(source.manifest.version).padEnd(8)} ${String(source.versionCode).padStart(8)}  ${source.manifest.content_rating.padEnd(5)} ${(bytes.byteLength / 1024).toFixed(0).padStart(5)} KB  sha256:${sha256.slice(0, 12)}${source.manifest.draft ? '  [draft — not listed]' : ''}`,
    );

    // A draft source is still built (so it keeps compiling and can be smoke-tested) but
    // stays out of index.json: publishing a source that is known to fail every call is
    // worse than not offering it. See its manifest's draft_reason.
    if (source.manifest.draft) {
      console.log(`             ${source.manifest.draft_reason}`);
      continue;
    }

    let iconUrl;
    if (source.icon) {
      const iconName = `${source.dir}${source.icon.ext}`;
      await writeFile(path.join(ICONS_DIR, iconName), await readFile(source.icon.path));
      expected.icons.add(iconName);
      iconUrl = `${rawBaseUrl}/dist/icons/${iconName}`;
    }

    listing.push({
      source_key: source.manifest.source_key,
      name: source.manifest.name,
      lang: source.manifest.lang,
      version: source.manifest.version,
      version_code: source.versionCode,
      api_version: EXTENSION_API_VERSION,
      ...(source.manifest.description ? { description: source.manifest.description } : {}),
      entry_url: `${rawBaseUrl}/dist/${bundleName}`,
      ...(iconUrl ? { icon_url: iconUrl } : {}),
      base_url: source.manifest.base_url,
      homepage: source.manifest.homepage ?? source.manifest.base_url,
      allowed_hosts: source.manifest.allowed_hosts,
      content_rating: source.manifest.content_rating,
      isNSFW: deriveIsNSFW(source.manifest.content_rating),
      bundle: { sha256, size: bytes.byteLength },
    });
  }

  const removed = await pruneDist(expected);
  for (const file of removed) {
    console.log(`removed stale ${file}`);
  }

  const index = {
    format_version: INDEX_FORMAT_VERSION,
    repository,
    sources: listing,
  };
  await writeFile(path.join(ROOT, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8');

  const withoutIcons = listing.filter((entry) => !entry.icon_url).map((entry) => entry.source_key);

  console.log(`\nindex.json written: format ${INDEX_FORMAT_VERSION}, api ${EXTENSION_API_VERSION}, ${listing.length} source(s) at ${rawBaseUrl}/`);
  if (usingEnvBase) {
    console.log('Built against RAW_BASE_URL from the environment — do not commit this index.json.');
  }
  if (withoutIcons.length > 0) {
    console.log(`No icon for: ${withoutIcons.join(', ')} — drop an icon.svg/png/webp in the source directory.`);
  }
  console.log("Remember: bump a source's manifest version when you change its code, or the app has nothing to detect an update by.");
}

main().catch((error) => {
  console.error(error instanceof BuildError ? `build failed — ${error.message}` : error);
  process.exitCode = 1;
});
