# Source framework

ProjektManga owns its source engines. The source-separation and shared-theme layout was
inspired by Keiyoushi, but the TypeScript engines, cursor model and sandbox rules are our own.
Extensions remain JavaScript bundles with API version 1. No Android runtime, WebView,
cookie store or user database is added to an extension.

## Catalogue contract

New adapters expose `getCapabilities`, `fetchMangaPage` and `searchMangaPage` in addition
to the existing offset methods. A native page returns `{ items, hasMore, nextCursor? }`.
Clients must use `hasMore`, including when the current page is short or full, and send
the opaque continuation cursor with the same category/query/filter context.

`SourcePageRequest.limit` is an integer from 1 through 100, defaulting to 30 for direct
adapter calls; the HTTP API defaults to 20. A normal call reads one upstream page.
Komiku's metadata fallback can inspect one additional page. When the requested limit is smaller than that page, the cursor
also carries a position within the page. A short result can therefore still have more.
Do not increment an application offset to construct a native cursor.

`nativeCatalogue.ts` provides the common request/parser boundary. Cursors contain an
upstream position and a SHA-256 fingerprint of the source, query, category and filters;
they carry no personal data. The fingerprint binds context, not authorization. Treat
tokens as untrusted: decoding, size, limits, routes, origins and continuation URLs are
validated before use. Tokens are limited to 1024 characters. HTML tokens retain only
the native pathname and pagination parameters, reconstructing other filters from the
current request. HTTP stays in the existing brokered `HttpClient` and cache.

Native ports include HentaiFox, WeebCentral, LeerCapitulo, Asura, all MangaDex editions,
IMHentai, Komiku, Sushi-Scan and Akaza Scans. HentaiFox follows its actual next URL, so
native continuation can reach pages beyond the old offset collector's 50-page bound.
WeebCentral follows HTMX continuation. MangaDex uses its API's total count. Older
offset methods retain their compatibility behavior and bounded sequential scans.
Komiku follows native HTMX links when supplied; when metadata is missing from a full
page, it verifies one page ahead and treats empty, repeated or 404 results as the end.

Capabilities describe actual behavior. Fixed language editions do not advertise a
language filter. URL resolution is optional and is not advertised by these ports.
Adapters never persist reading progress; the legacy chapter shape still supplies
`last_page_read: 0` and `pages: []` for compatibility. This change does not introduce a
new personal-progress contract.

## Shared website engines

The existing Madara engine remains available. `mangaThemesia.ts` is a complete shared
engine covering catalogue requests, details, chapter lists, image URL metadata and
filters. Sources configure their manifest, catalogue route, selectors, date parser and
optional static filters. Sushi-Scan supplies French labels and dates; Akaza Scans uses
the standard theme selectors and 42 native genre choices captured on 2026-10-14.
Theme differences must be configured explicitly, with fixtures for any override.

Source keys, manga IDs and chapter IDs stay stable for existing ports. New sources
must remain drafts until catalogue/search, pagination, details, chapter and image-host
acceptance completes in the production sandbox. Offline synthetic fixtures are not
live acceptance. Akaza Scans passed bounded live acceptance through the restricted
sandbox with the app's public-URL guard: 19 catalogue titles, one matching search result,
six filter groups, three chapters on the sampled title, 13 reader pages and a WebP
image prefix whose MIME/signature matched the declared image host. It is included in
the local index. This sampled acceptance does not verify every title or future site changes.

## Upstream references and attribution

The architecture follows the current [KeiSource contributor guide](https://github.com/keiyoushi/extensions-source/blob/main/CONTRIBUTING.md#keisource).
Request, selector and continuation contracts were compared with
[WeebCentral](https://github.com/keiyoushi/extensions-source/blob/main/src/en/weebcentral/src/eu/kanade/tachiyomi/extension/en/weebcentral/WeebCentral.kt),
[Komiku](https://github.com/keiyoushi/extensions-source/blob/main/src/id/komiku/src/eu/kanade/tachiyomi/extension/id/komiku/Komiku.kt),
[MangaThemesia](https://github.com/keiyoushi/extensions-source/blob/main/lib-multisrc/mangathemesia/src/eu/kanade/tachiyomi/multisrc/mangathemesia/MangaThemesia.kt),
and the [Akaza Scans declaration](https://github.com/keiyoushi/extensions-source/blob/main/src/en/akazascans/build.gradle.kts).
The host-specific pagination metadata for published ports was also checked against
the native websites. See `THIRD_PARTY_NOTICES.md` for retained upstream attribution.

## Verification

`npm test` exercises synthetic adapter fixtures without scraping websites or accessing
an application database. Native tests cover page splitting, full and short terminal
pages, direct deep continuation, filter/query binding, invalid cursors, foreign next
links, errors, legacy identities and the concrete shared-theme source. `npm run check`
typechecks and rebuilds bundles and hashes. Bump every affected source version when
its source or bundled shared implementation changes.

After building the app's server, schemas and sandbox, `node scripts/accept-akazascans.mjs --live`
repeats the bounded live gate without installing an extension or accessing a library database.
It checks the first reader image prefix only, cancels the response afterward and never downloads
an entire chapter. This command is deliberately separate from offline tests and CI.
