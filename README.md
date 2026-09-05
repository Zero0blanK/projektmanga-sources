# ProjektManga sources

Installable manga sources for [ProjektManga](https://github.com/Zero0blanK/ProjektManga),
published as a static extension repository.

The app doesn't clone anything and needs no GitHub token. It fetches plain files over
HTTPS from this repository's raw URLs: an `index.json` listing, and one built JavaScript
bundle per source.

```
index.json          ──► the app lists what's installable
dist/<source>.js    ──► the app downloads, hashes and sandboxes the one you install
dist/icons/<source> ──► optional, shown in the listing
```

**[`docs/repository-format.md`](docs/repository-format.md) documents every field in
`index.json` and in a source's `manifest.json`** — what you author, what the build derives,
and which of the three version numbers to bump when.

---

## Quick start

1. Create the GitHub repository and push this directory to it.
2. Point `repo.config.json`'s `raw_base_url` at it — that single value becomes every
   source's `entry_url`:

   ```json
   { "raw_base_url": "https://raw.githubusercontent.com/<you>/<repo>/main" }
   ```

3. Build and commit:

   ```bash
   npm install
   npm run build      # bundles every source, regenerates index.json
   git add dist index.json && git commit -m "build" && git push
   ```

4. In the app: **Settings → Extensions**, add

   ```
   https://raw.githubusercontent.com/<you>/<repo>/main/index.json
   ```

   then install a source from the listing.

`dist/` is committed on purpose — the raw URLs in `index.json` point straight at it, so an
unbuilt commit publishes stale code. CI fails the build if the two disagree.

---

## What's here

| Source | Key | Rating | Status |
| --- | --- | --- | --- |
| MangaDex | `mangadex` | mixed | published — browse, search, details, chapters, pages, filters |
| MangaGeko | `mangageko` | mixed | published — browse, search, details, chapters, pages |
| MangaTX | `mangatx` | mixed | published — browse, search, details, chapters, pages |
| Nhentai | `nhentai` | nsfw | published — browse, search, details, pages |
| Kissmanga | `kissmanga` | mixed | **draft, not listed** — see below |

`mixed` means a general catalogue that also carries adult titles: badged, not hidden. Only
`nsfw` sets `isNSFW` in the listing. See
[Content rating](docs/repository-format.md#content-rating).

All four published sources were verified end to end against the live sites, both directly
and running inside the app's real sandbox process. Re-run that check any time with
`npm run smoke`.

### Why Kissmanga is a draft

`kissmanga.in` answers every plain HTTP request with Cloudflare's interactive
"Just a moment…" challenge (HTTP 403, verified 2026-08-30). The version bundled in the app
gets around this with Puppeteer and a stealth plugin. A sandboxed extension has neither —
it has no browser and no network of its own, only a proxied `fetch` — so the source would
install and then fail every call.

The code is complete and correct, and it is still built and testable
(`npm run smoke kissmanga`). It is simply held out of `index.json` by `"draft": true` in
its manifest. Flip that to `false` and rebuild if the site stops challenging.

This is the general rule, not a Kissmanga quirk: **a site behind an active Cloudflare
challenge cannot work as a sandboxed extension.** Sites that merely check for
browser-shaped headers are fine — every request here sends what a browser sends.

---

## Layout

```
index.json              generated — the listing the app fetches
repo.config.json        raw base URL + the repository's own name and contact details
build.mjs               esbuild, manifest validation, index generation
docs/                   the repository format, field by field
schema/                 JSON Schema for index.json and manifest.json
src/
  lib/                  shared code: fetch client, cache, error classes, Madara factory
  <source>/
    manifest.json       the source's metadata — see docs/repository-format.md
    icon.svg            optional, published as dist/icons/<source>.svg
    index.ts            the Source implementation
dist/<source>.js        built bundles (committed)
dist/icons/             built icons (committed)
scripts/smoke.mjs       live end-to-end check
```

`build.mjs` also deletes anything in `dist/` it didn't just produce, so removing a source
takes its bundle off the raw URL instead of leaving it live and installable.

Each source's `manifest.json` is the single source of truth for its metadata: `build.mjs`
reads it to generate `index.json`, and the source itself imports it for its own `id`,
`name` and `base_url`, so the listing and the running code can never disagree.

---

## Writing a source

### The contract

The bundle must be an **ES module with a default export** implementing `Source`
(`src/lib/types.ts` — a copy of the app's `packages/types/src/extension.ts`). The sandbox
validates it by checking that `fetchManga` is a function, so that method is effectively
mandatory. It must be a **single self-contained file**: nothing is installed for it.

Only these methods are ever called — the runner allowlists them:

```
fetchManga  searchManga  fetchMangaDetails  fetchMangaThumbnail
fetchChapters  fetchChapterPages  getFilters  fetchMangaUpdates
```

### What your code may and may not do

The sandbox child runs under `--permission` with **no network grant at all** and a
filesystem allowlist covering only its own bundle directory. Before your bundle loads, the
global `fetch` is replaced with a shim that proxies every call to the parent over IPC.

- **Use `fetch`, and only `fetch`.** `axios`, `node:https`, anything that opens its own
  socket — the process genuinely has no network. Use `src/lib/http.ts`, which layers rate
  limiting, retries, timeouts and error classification on top of it.
- **Request bodies must be strings.** A `FormData`, `Blob` or stream body silently becomes
  `null`.
- **Timeouts race, they don't abort.** `init.signal` isn't forwarded, so the parent's
  request keeps running; the caller just stops waiting.
- **Declare every host you touch in `allowed_hosts`,** including hosts you only reach via a
  redirect. Matching is exact or suffix (`example.com` also permits `cdn.example.com`), 1
  to 20 entries. A request to anything else throws. Image URLs you merely *return* don't
  need to be listed — the app fetches those itself.
- **Redirects are followed by the parent** (5 hops max) and every hop is re-validated
  against your allowlist and the app's SSRF guard.
- **Never persist anything.** Extensions report data; storing it is the server's job.
- **Never assume `pagination` is present.** The app passes through whatever the caller
  gave, `undefined` included — use `resolvePagination()`.
- Pure-JS parsing libraries are fine. `cheerio/slim` is already used by three sources and
  keeps a bundle around 210 KB; the cap is 10 MB.

### Errors

Throw `SourceError` with one of the documented codes rather than a bare `Error`, so the
app can render "this source is blocking us" instead of an empty result. `src/lib/http.ts`
already classifies HTTP statuses and transport failures for you.

`code`, `reason`, `detail`, `statusCode` and `url` all survive the sandbox boundary, so a
repo-installed source is classified exactly like one bundled with the app: the server maps
the code onto an HTTP status and a user-facing message. The runner validates `code` against
the known set before forwarding it, since it arrives from extension code — an unrecognised
value is dropped rather than passed through to pick a status code.

Write each message to stand on its own as end-user text anyway. It is what the user actually
reads when a code doesn't map to something more specific.

### Adding one

```bash
mkdir src/mysource
# write src/mysource/manifest.json and src/mysource/index.ts
npm run typecheck
npm run build
npm run smoke mysource
```

`build.mjs` picks up any `src/<dir>/index.ts` automatically. `source_key` must equal the
directory name — the bundle is published as `dist/<dir>.js`.

The manifest is seven required fields; point `$schema` at `../../schema/manifest.schema.json`
and the editor will fill them in for you:

```json
{
  "$schema": "../../schema/manifest.schema.json",
  "source_key": "mysource",
  "name": "My Source",
  "lang": "en",
  "version": "1.0.0",
  "description": "One line for the install listing.",
  "base_url": "https://mysource.example",
  "allowed_hosts": ["mysource.example"],
  "content_rating": "mixed"
}
```

Don't add `entry_url`, `version_code`, `isNSFW` or a hash — the build derives those, and
rejects any field it doesn't know so a typo fails the build instead of quietly dropping out
of the listing. Add an `icon.svg` (or `.png`/`.webp`) beside the manifest and it gets
published too.

---

## Updating a source

**Bump `version` in the source's `manifest.json` whenever you change its code**, then
rebuild and push. The build turns it into the `version_code` integer the app actually
compares.

A rebuild published without a bump still gets picked up — `bundle.sha256` in the listing
changes with the bytes — but nothing in the UI can tell the user what they got, so bump it.

Three things the app does with what you publish here, worth knowing before you push:

- **`bundle.sha256` is verified** against the downloaded file at install and at update. A
  listing that disagrees with the bytes at `entry_url` is refused, not installed — which is
  exactly the state `npm run build` without committing `dist/` leaves you in, and why CI
  fails that commit.
- **A lower version is ignored.** Publishing a version older than the one a user has
  installed is treated as no update rather than a downgrade, so a rollback needs a *higher*
  version carrying the reverted code, not a re-published older one.
- **A bad publish rolls itself back.** On update the new bundle is staged beside the live
  one and loaded in a real sandbox first; if it fails to load or answer `getFilters()`, it
  is discarded and the working version keeps serving. You will see the failure in the app's
  update log rather than in a broken source.

Two other version numbers exist and are bumped for different reasons:
`api_version` when the extension contract in `src/lib/types.ts` changes incompatibly, and
`format_version` when `index.json` itself changes shape. Both live at the top of
`build.mjs`; [the format doc](docs/repository-format.md#three-versions-and-when-to-bump-them)
explains which is which.

---

## The development loop

Every URL involved must be **publicly resolvable** — the app's SSRF guard rejects
localhost, RFC1918 and other reserved ranges, on the index URL, on every `entry_url`, and
on every request a source makes. There is no development bypass. Two ways to live with it:

**A tunnel** (fastest iteration — no commit, no CDN cache):

```bash
npx serve . --listen 8080
cloudflared tunnel --url http://localhost:8080
RAW_BASE_URL=https://random-words-1234.trycloudflare.com npm run build
```

Add `<tunnel>/index.json` as the repository. The tunnel hostname changes on every restart,
so re-run the build and re-add the repository when it does.

**GitHub raw** (nothing extra to install): `raw.githubusercontent.com` is CDN-cached for a
few minutes, so a fresh push isn't visible immediately. Either pin `raw_base_url` to a
commit SHA instead of `main` (those URLs are immutable) or bump `version` every push so
it's obvious when you're still looking at the old bundle.

Use the tunnel while writing a scraper, GitHub raw once it's stable.

### Checking a source works

```bash
npm run smoke              # every published source
npm run smoke mangadex     # one, including drafts
```

This loads the built bundle exactly as the sandbox does — dynamic `import()`, default
export, `fetchManga` check — and enforces the same `allowed_hosts` rule on every request,
so a missing host shows up here rather than after installing. It does not reproduce the
Node permission flags, so it can't catch a bundle that quietly relies on real network
access; nothing here does.

### Against a running app

```bash
curl -X POST http://localhost:4000/api/extensions/repositories \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://raw.githubusercontent.com/<you>/<repo>/main/index.json"}'

curl http://localhost:4000/api/extensions/repositories

curl -X POST http://localhost:4000/api/extensions/installed \
  -H 'Content-Type: application/json' \
  -d '{"repository_id":"<id>","source_key":"mangadex"}'

# after a push: re-read the index, then pull the new bundle
curl -X POST http://localhost:4000/api/extensions/repositories/<id>/refresh
curl -X POST http://localhost:4000/api/extensions/installed/<installed_id>/update
```

The server needs **Node 25 or newer**, or the sandbox refuses to start: `--allow-net` only
became a gated permission in 25.0.0, so on anything older the "sandbox" would have real
network access.

### A note on source keys

These keys are the same as the app's own bundled sources. That is deliberate — the desktop
installer ships no bundled sources, so these *are* its sources. In a dev server that does
have them, a bundled source always wins and the installed one is dropped with a warning, so
you'll be testing the bundled code without noticing. Test these against the desktop build,
or rename the key while you work.

---

## Differences from the sources bundled in the app

These are ports, not copies. What changed, and why:

- **No anti-detection layer.** No proxy rotation, no user-agent rotation, no Puppeteer or
  Playwright fallback, no circuit breaker — none of it can run in the sandbox. Requests
  send static browser-shaped headers and that's it.
- **`fetch` instead of axios**, with the retry/rate-limit/timeout behaviour reimplemented
  in `src/lib/http.ts`.
- **No environment overrides.** The sandbox child is spawned with an empty environment, so
  the app's `EXT_SOURCE_*_BASE_URL` / `_RATE_LIMIT_MS` / `_CACHE_TTL_MS` variables have no
  effect. Those values are constants in each source now.
- **MangaDex `fetchMangaDetails` returns `source: "mangadex"`**, the source id, where the
  bundled version returned the display name `"MangaDex"` — every other source and
  everything downstream keys off the id.
- **Search implemented for MangaTX and Nhentai**, which returned an empty list in the
  bundled versions. Both verified against the live sites.
- **MangaTX also returns `author`**, read from the same detail block the bundled version
  only read `artist` from. Its `genres` stays empty because those pages carry no genre list
  at all — checked, not assumed.
- **`pagination` is defensively defaulted** everywhere, since the sandbox transport can
  pass `undefined` through.
- **Content ratings replace the hardcoded `isNSFW` boolean.** The bundled MangaDex,
  MangaGeko and MangaTX all set `isNSFW: true`, which under a "hide NSFW sources" setting
  hides three general catalogues. Here they are `content_rating: "mixed"` — badged, still
  listed — and only Nhentai is `nsfw`. Each source's `isNSFW` is derived from its rating by
  `src/lib/manifest.ts`, so the listing and the running source always agree.
