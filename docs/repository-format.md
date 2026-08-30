# The repository format

What an app downloads from this repository, what every field in it means, and which of
them you write by hand.

There are exactly two kinds of file, both served over plain HTTPS from raw URLs:

```
index.json              the listing — what is installable, and where to get it
dist/<source_key>.js    one self-contained ES module per source
dist/icons/<key>.svg    optional, referenced from the listing
```

`index.json` is **generated**. `npm run build` writes it from the per-source
`manifest.json` files plus `repo.config.json`, and `build.mjs` is the authoritative
definition of the format — `schema/index.schema.json` and `schema/manifest.schema.json`
carry the same contract as JSON Schema, for editor autocompletion and for the app to
validate against, and are updated alongside it.

The guiding rule: **a manifest declares only what cannot be worked out.** URLs, the
numeric version code, the bundle hash and the NSFW boolean are all derived at build time,
so there is no second copy of anything to fall out of step.

---

## Root of `index.json`


| Field            | Type   | Meaning                                                                         |
| ---------------- | ------ | ------------------------------------------------------------------------------- |
| `format_version` | int    | Shape of this file. See[Three versions](#three-versions-and-when-to-bump-them). |
| `repository`     | object | Who publishes this. Copied verbatim from`repo.config.json`.                     |
| `sources`        | array  | One entry per installable source, sorted by`source_key`. Drafts are absent.     |

`repository` carries `name` (required — it is how an installed source is attributed in the
UI), and optionally `badge_label` (a chip of at most 6 characters), `description`,
`website`, and `contact`, a free-form object of https URLs (`issues`, `discord`, whatever
applies).

## A source entry

Authored fields come from that source's `manifest.json`. Derived ones are computed by
`build.mjs` and must not be added to a manifest — it rejects unknown keys.


| Field            | Source   | Meaning                                                                                                                                                                  |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `source_key`     | authored | Stable identity, equal to the source's directory name.`(repository, source_key)` is what an installed source is keyed by, so **never reuse a key for a different site.** |
| `name`           | authored | Display name.                                                                                                                                                            |
| `lang`           | authored | BCP-47 (`en`, `pt-BR`) or `all`.                                                                                                                                         |
| `version`        | authored | `major.minor.patch`, each part 0–999. Display this one.                                                                                                                 |
| `version_code`   | derived  | `major*1e6 + minor*1e3 + patch`. **Compare this**, never the string.                                                                                                     |
| `api_version`    | derived  | Extension contract the bundle implements.                                                                                                                                |
| `description`    | authored | Optional, one line, ≤ 200 characters.                                                                                                                                   |
| `entry_url`      | derived  | `<raw_base_url>/dist/<source_key>.js`.                                                                                                                                   |
| `icon_url`       | derived  | Present only when the source ships an icon.                                                                                                                              |
| `base_url`       | authored | Where the source's own requests go — the API origin for an API-backed source.                                                                                           |
| `homepage`       | authored | Where to send a human. Defaults to`base_url`.                                                                                                                            |
| `allowed_hosts`  | authored | Every host the source may reach.                                                                                                                                         |
| `content_rating` | authored | `safe` \| `mixed` \| `nsfw`.                                                                                                                                             |
| `isNSFW`         | derived  | `content_rating === 'nsfw'`.                                                                                                                                             |
| `rate_limit_ms`  | authored | Minimum gap between the source's requests, enforced by the app. Defaults to 1000.                                                                                        |
| `requires_browser_fetch` | authored | Whether the source asks for the elevated`__browserFetch` capability. Defaults to false.                                                                          |
| `referer`        | authored | Optional. `Referer` for image proxying; falls back to `homepage`, then `base_url`.                                                                                       |
| `bundle`         | derived  | `{ sha256, size }` of the file at `entry_url`.                                                                                                                           |

### The derivations, in full

- **`version_code`** — one sortable integer, which is why each semver part is capped at
  999. Two hand-maintained version fields drift the first time someone bumps one of them.
- **`isNSFW`** — true only for `content_rating: "nsfw"`. `src/lib/manifest.ts` applies the
  same rule at runtime, so a source reports the same thing in the listing and once
  installed.
- **`homepage`** — falls back to `base_url`. It exists because they genuinely differ:
  MangaDex's `base_url` is `https://api.mangadex.org`, which is not a page anyone should be
  sent to.
- **`entry_url` / `icon_url`** — `repo.config.json`'s `raw_base_url`, or `RAW_BASE_URL` from
  the environment for tunnel builds.
- **`bundle`** — see [Integrity](#integrity-and-update-detection).

### Content rating

One boolean cannot describe a general catalogue that also carries adult titles: flag it and
you hide half the library behind a "hide NSFW sources" setting, don't and you under-warn
the reader. So there are three ratings, matching Mihon's `CONTENT_WARNING_*`:


| Rating  | Meaning                                           | Expected UI                              |
| ------- | ------------------------------------------------- | ---------------------------------------- |
| `safe`  | No adult content.                                 | Nothing.                                 |
| `mixed` | General catalogue that also carries adult titles. | Badge it. Do **not** hide it.           |
| `nsfw`  | Adult site.                                       | Hidden by a "hide NSFW sources" setting. |

`isNSFW` is kept alongside it for readers that predate the rating; prefer
`content_rating`, which is strictly more informative.

---

## The manifest

`src/<source_key>/manifest.json` — the only file you edit for metadata. It is also
imported by the source's own `index.ts`, which is why the running source and the listing
can never disagree about `id`, `name`, `lang`, `base_url` or NSFW status.

```json
{
  "$schema": "../../schema/manifest.schema.json",
  "source_key": "mangadex",
  "name": "MangaDex",
  "lang": "en",
  "version": "1.0.0",
  "description": "Scanlation library with an official API, filters and per-chapter groups.",
  "base_url": "https://api.mangadex.org",
  "homepage": "https://mangadex.org",
  "allowed_hosts": ["api.mangadex.org"],
  "content_rating": "mixed",
  "rate_limit_ms": 250
}
```

Required: `source_key`, `name`, `lang`, `version`, `base_url`, `allowed_hosts`,
`content_rating`. Optional: `$schema`, `description`, `homepage`, `rate_limit_ms`,
`requires_browser_fetch`, `referer`, `draft`, `draft_reason`.

### The three capability fields

| Field                    | Default              | What it does                                                                                                                                                                                                                              |
| ------------------------ | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rate_limit_ms`          | `1000`               | Minimum gap between this source's requests, **enforced by the app**, outside the sandbox. A source that throttles itself internally should declare the same number: the internal limiter is courtesy, this one is the one that still holds. |
| `requires_browser_fetch` | `false`              | Unlocks `__browserFetch`. The runner injects that global only for sources that set this, and the app warns the user before installing one. See[Elevated capability](#elevated-capability).                                                  |
| `referer`                | `homepage`,`base_url` | `Referer` the app sends when proxying this source's images. Set it only when a site rejects the default.                                                                                                                                   |

All three are written into the source's `index.json` entry — `rate_limit_ms` and
`requires_browser_fetch` always, resolved to their defaults, so a reader gets one number and
one boolean off the listing rather than reimplementing these rules. `referer` is omitted
when absent.

They are optional *in the index too*, so a repository built before these fields existed
still validates. A reader that finds them missing should apply the defaults in this table —
in particular it should throttle at its own conservative default, not leave the source
unthrottled.

### Elevated capability

`requires_browser_fetch: true` asks the app to expose `__browserFetch(url, opts)` to the
bundle: the source hands over a URL, and the app loads it in a real browser with its
anti-detection stack — proxy rotation, fingerprinting, Cloudflare clearance — and returns
the rendered HTML.

The source still has no browser and no socket. It is asking the app to do something on its
behalf, which is exactly why it is gated:

- `allowed_hosts` applies to it unchanged, and the app re-validates every redirect hop.
- Calls queue behind a small browser pool shared by *every* source that requests it, so this
  is much slower than `fetch` and does not scale with how often you call it.
- The app tells the user a source wants this before they install it. A source that declares
  it and doesn't need it is asking users to accept a warning for nothing.

Declare it for a site plain `fetch` genuinely cannot read — an active Cloudflare challenge is
the case it exists for. Do not declare it to avoid writing a parser.

### What the build rejects

Every one of these fails `npm run build` rather than shipping:

- an unknown field — a typo would otherwise vanish silently from the listing;
- `source_key` that isn't the directory name, or isn't lowercase/digits/dashes;
- a `version` that isn't `x.y.z` with parts under 1000;
- a `lang` that isn't BCP-47 or `all`;
- a `base_url` or `homepage` that isn't https;
- `allowed_hosts` that is empty, over 20 entries, duplicated, or holds anything but a bare
  lowercase hostname (no scheme, port, path or wildcard);
- **`allowed_hosts` that doesn't cover `base_url`** — the commonest install-time failure
  there is, since every request would then throw;
- a `content_rating` outside the three values;
- a `rate_limit_ms` that isn't a whole number of milliseconds from 0 to 60000 — the cap
  catches seconds entered as milliseconds, which would otherwise stall the source;
- a `requires_browser_fetch` that isn't a boolean, or a `referer` that isn't https;
- `draft: true` with no `draft_reason`;
- a bundle over 10 MB or an icon over 512 KB.

### Drafts

`"draft": true` keeps a source out of `index.json` while still building and smoke-testing
it, so it keeps compiling. `draft_reason` is then required — it is the only record of why
the source is held back and what would have to change. `npm run smoke <key>` still runs it.

---

## Icons

Drop `icon.svg`, `icon.png` or `icon.webp` (first match wins, 512 KB cap) into the source's
directory. The build copies it to `dist/icons/<source_key><ext>` and emits `icon_url`; with
no icon file the field is simply absent and a reader should render its own fallback.

The icons here are **placeholder monograms**, not the sites' logos. Replace one with the
real thing only if you have the right to redistribute it.

---

## Integrity and update detection

`entry_url` points at a branch URL, so the bytes behind it change in place. That makes
`bundle` the load-bearing part of an entry rather than a nicety:

```
sha256   the file at entry_url must hash to this, or refuse to run it
size     bytes — check before reading the body to bound the download
```

What a reader should do:

1. Fetch `index.json`. Refuse a `format_version` above what it understands. Skip entries
   whose `api_version` it can't drive.
2. An update is available when the listed `version_code` is greater than the installed one,
   **or** when `bundle.sha256` differs from the installed bundle's hash. The second case is
   the one that catches a rebuild published without a version bump.
3. On download, hash the bytes and compare to `bundle.sha256` before importing them. A
   mismatch means a stale CDN copy or a tampered file — neither should run.

`raw.githubusercontent.com` caches for a few minutes, so step 3 will legitimately fail
right after a push. Retry, or pin `raw_base_url` to a commit SHA, whose URLs are immutable.

---

## Three versions, and when to bump them

Three independent numbers, each answering a different question. Confusing them is the
usual way a format like this rots.


|                            | Where                                  | Bump when                                                          | Effect                                   |
| -------------------------- | -------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------- |
| `version` / `version_code` | a source's`manifest.json`              | that source's code changes                                         | that one source shows an update          |
| `api_version`              | `EXTENSION_API_VERSION` in `build.mjs` | `src/lib/types.ts` changes so an old bundle can't satisfy it       | older apps skip sources they can't drive |
| `format_version`           | `INDEX_FORMAT_VERSION` in `build.mjs`  | `index.json` renames or removes a field, or changes what one means | older apps refuse the whole repository   |

**Adding an optional field is not a `format_version` bump.** Readers are required to
ignore fields they don't know, which is what keeps this format extensible: every field
added since v1 can be introduced without breaking a single installed client.

`api_version` is this repository's equivalent of Mihon's `extensionLib`, and exists for the
same reason — it is the only thing that lets the extension contract change without every
old app trying, and failing, to run new bundles.

---

## Known gaps

Honest list of what this format deliberately does not do yet.

- **No signing.** Mihon pins a repository's APK signing key and refuses anything else.
  Here there is nothing to verify *who* wrote a bundle — only `bundle.sha256`, which proves
  the bytes match the listing, not their origin. The substitute is containment: the sandbox
  has no network of its own, a filesystem allowlist, and `allowed_hosts`. Add signing before
  ever listing a source you did not write.
- **One source per bundle.** Mihon ships one APK exposing many sources — its MangaDex
  extension declares 61, one per language. Here `entry_url` is derived from the directory
  name, so the relationship is fixed at 1:1 and a multi-language site needs one directory,
  one bundle and one key per language. Expressing 1:N needs the app to pass a variant key
  into the bundle at load time; until that exists, the format shouldn't pretend to offer it.
- **No `updated_at`.** A build timestamp would change `index.json` on every run and break
  CI's "committed output matches the sources" check. Git history already records it.
- **No declared *feature* capabilities.** Whether a source supports search or filters is
  discoverable only by calling it. A declared list nobody verifies would rot; deriving one
  honestly means loading each bundle at build time, which is a job for the smoke runner.
  `requires_browser_fetch` is not an exception to this — it is a *permission* the app grants
  or withholds, so declaring it falsely gets you nothing but a warning shown to your users.
- **`requires_browser_fetch` is declared, not verified.** The build cannot tell whether a
  source that declares it actually calls `__browserFetch`, or whether one that omits it
  needed it. The first is harmless noise; the second shows up as a source that installs and
  then fails against a challenged site, which is exactly the Kissmanga case.

---

## Field mapping to Mihon / keiyoushi

For anyone reading both formats. Mihon's index nests everything under
`extensionList.extensions[]`, one entry per *APK*, each containing a `sources[]` array.


| Here                                          | Mihon                             | Note                                                                  |
| --------------------------------------------- | --------------------------------- | --------------------------------------------------------------------- |
| `repository.name` / `badge_label` / `contact` | `name` / `badgeLabel` / `contact` | Same idea.                                                            |
| —                                            | `signingKey`                      | No equivalent; see[Known gaps](#known-gaps).                          |
| `format_version`                              | —                                | Mihon's index has no schema version.                                  |
| `source_key`                                  | `sources[].id`                    | Theirs is a 64-bit hash of name+lang+version; ours is a readable key. |
| `version` / `version_code`                    | `versionName` / `versionCode`     | Same split, same reason.                                              |
| `api_version`                                 | `extensionLib`                    | Same role.                                                            |
| `entry_url`                                   | `resources.apkUrl` / `jarUrl`     | JS module vs signed APK.                                              |
| `icon_url`                                    | `resources.iconUrl`               | Same.                                                                 |
| `homepage`                                    | `sources[].homeUrl`               | Same.                                                                 |
| `content_rating`                              | `contentWarning`                  | `safe`/`mixed`/`nsfw` ↔ `CONTENT_WARNING_SAFE`/`_MIXED`/`_NSFW`.     |
| `allowed_hosts`                               | —                                | No equivalent — Mihon extensions do arbitrary networking.            |
| `bundle.sha256`                               | —                                | Unnecessary there: their URLs are immutable release assets.           |
