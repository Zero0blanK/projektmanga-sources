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
"Just a moment…" challenge (HTTP 403, verified 2026-08-30). Its port here uses plain
`fetch`, so every call fails.

`__browserFetch` is the intended way out, but it is not a flag flip: the source has to be
rewritten to call it for the challenged requests, and its manifest has to declare
`requires_browser_fetch: true`. Until someone does that and verifies it against the live
site, the source stays held out of `index.json` by `"draft": true`. The code is otherwise
complete and still built and testable (`npm run smoke kissmanga`).

The general rule, of which this is one case: **a site behind an active Cloudflare challenge
cannot be read with plain `fetch`** — it needs `__browserFetch` and the manifest flag that
unlocks it. Sites that merely check for browser-shaped headers need neither; every request
here already sends what a browser sends.

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
(`src/lib/types.ts` — a copy of the app's `shared/types/extension.ts`). The sandbox
validates it by checking that `fetchManga` is a function, so that method is effectively
mandatory. It must be a **single self-contained file**: nothing is installed for it.

Only these methods are ever called — the runner allowlists them:

```
fetchManga  searchManga  fetchMangaDetails  fetchMangaThumbnail
fetchChapters  fetchChapterPages  getFilters  fetchMangaUpdates
fetchChapterPagesForDownload  getRetryStrategy  getRateLimitInfo
```

The three on the last line are optional and exist for the app's download worker:
`fetchChapterPagesForDownload` is a `fetchChapterPages` that can report progress and be
cancelled, and the other two return retry and shaping hints. Implement none of them and the
app falls back to `fetchChapterPages` — they buy better downloads, they are not required to
have a working source.

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
- **`__browserFetch` is the one exception to "only `fetch`",** and only if your manifest sets
  `requires_browser_fetch: true`. It hands a URL to the app, which loads it in a real browser
  with its anti-detection stack (proxy rotation, fingerprinting, Cloudflare clearance) and
  returns the rendered HTML. You still get no browser and no socket of your own — you are
  asking the app to do it for you. It is much slower than `fetch`, it queues behind a small
  browser pool shared by every source that requests it, `allowed_hosts` applies to it
  unchanged, and the app warns the user before installing a source that declares it. Use it
  for a site plain `fetch` genuinely cannot read, not to save yourself writing a parser.
- **Never assume `pagination` is present.** The app passes through whatever the caller
  gave, `undefined` included — use `resolvePagination()`.
- Pure-JS parsing libraries are fine. `cheerio/slim` is already used by three sources and
  keeps a bundle around 210 KB; the cap is 10 MB.

### Errors

Throw `SourceError` with one of the documented codes rather than a bare `Error`, so the
app can render "this source is blocking us" instead of an empty result. `src/lib/http.ts`
already classifies HTTP statuses and transport failures for you.

One caveat: the sandbox IPC boundary currently forwards only `error.message` back to the
server, so `code`, `reason` and `detail` are dropped in transit and a repo-installed
source's failure reaches the UI as a generic error. Every message here is therefore
written to stand on its own as end-user text.

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
  "content_rating": "mixed",
  "rate_limit_ms": 250
}
```

`rate_limit_ms` is optional but worth setting: it is the throttle the *app* enforces, on its
side of the sandbox, and it defaults to a deliberately slow 1000 ms. Set it to whatever your
source already limits itself to internally — the internal limiter keeps you polite, this one
is what still holds once your code is something the app didn't write. Two further optional
fields are documented above: `requires_browser_fetch` and `referer`.

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

- **No anti-detection layer inside the source.** No proxy rotation, no user-agent rotation,
  no Puppeteer or Playwright fallback, no circuit breaker — none of it can run in the
  sandbox, which has neither a browser nor a socket. Requests send static browser-shaped
  headers and that's it. The app still *has* that stack, on its own side of the boundary; a
  source reaches it only by declaring `requires_browser_fetch` and calling `__browserFetch`,
  and none of the sources here currently do.
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
