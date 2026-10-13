# V2 source acceptance and feasibility

Observed on 2026-10-12 from this Windows development environment. HTTP accessibility is
regional and temporary; these observations do not establish universal availability.
Live acceptance fetched bounded HTML/API metadata and page URLs, without downloading
image files, authenticating, or solving challenges.

## Accepted adapters

| Addition          | Canonical origin            | Language              | Evidence                                                                                                                                                                               |
| ----------------- | --------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MangaDex editions | https://api.mangadex.org    | es, pt-br, fr, id, ru | All five passed browse, search, filters, details, chapters and pages through the actual application sandbox and shared schemas. Sample reader totals: 20, 18, 35, 40, 20 respectively. |
| LeerCapitulo      | https://www.leercapitulo.co | es                    | `.com` redirects to `.co`. Catalogue, search, filter form, full chapter rows and lazy reader images are server-rendered. Sandbox sample reader: 17 pages.                              |
| HentaiFox         | https://hentaifox.com       | all                   | Browse/search galleries, gallery metadata, a synthetic chapter and ordered page URLs passed the sandbox. Sample gallery: 43 pages. Adult source.                                       |

MangaDex editions share a factory, with independent caches and language-specific requests.
The English source retains its original key and chapter IDs. Editions namespace chapter IDs
with the edition key and decode them for the upstream reader endpoint. Edition libraries
and progress remain independent. API version stays 1.

MangaDex language codes and list-query fields were checked against its
[language documentation](https://gitlab.com/mangadex-pub/mangadex-api-docs/-/raw/main/3-enumerations.md)
and [OpenAPI specification](https://api.mangadex.org/docs/api.yaml).

The app's parent sandbox now spaces MangaDex API dispatches by 250 ms across all edition
instances in that process, with 1,600 ms spacing for AtHome reader metadata. Waiting is
abort-aware and remains inside existing request/call timeouts. This follows the official
[global and endpoint limits](https://gitlab.com/mangadex-pub/mangadex-api-docs/-/raw/main/2-limitations.md).
Independent application processes and other clients sharing the public IP still share
upstream allowances; process-local pacing cannot coordinate those clients. This pacing
change passed extension typecheck/build and the repeated seven-source sandbox acceptance.
MangaDex requests identify the client as `ProjektManga-Sources/<version>`, in accordance
with its non-spoofed User-Agent requirement.

New gallery and chapter adapters namespace chapter IDs by source. HentaiFox and LeerCapitulo
also decode their earlier unprefixed IDs so existing reader links remain usable. An unnamed
HentaiFox catalogue entry encountered in live acceptance now uses its gallery ID as an explicit
untitled label, retaining pagination rather than failing shared-schema validation.

LeerCapitulo's catalogue exposes alphabetical sorting, genre, theme, type and status.
The adapter uses that native catalogue; its category argument does not promise an upstream
popularity ranking. HentaiFox uses its native newest-gallery listing and keyword search.
No tag-filter syntax is advertised without demonstrated upstream support.

## Deferred requested sites

| Item          | Origin                | Language                        | Observed blocker and disposition                                                                                                                                 |
| ------------- | --------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S02 Komiku    | https://komiku.org    | id                              | Main and api.komiku.org return HTTP 403 with a challenge. Complete offline-tested draft; live acceptance remains unavailable.                                    |
| S03 Sushiscan | https://sushiscan.net | fr                              | HTTP 403 with a challenge. Complete MangaThemesia draft, including French dates and script/DOM reader variants; unpublished pending live acceptance.             |
| S06 IMHentai  | https://imhentai.xxx  | en, ja, es, fr, ko, de, ru, all | HTTP 403 with a challenge. Complete gallery draft with native language queries and ordered metadata/reader-page extraction; unpublished pending live acceptance. |

Komiku now has a complete draft adapter, with offline catalogue/search/detail/chapter/page
fixtures, arbitrary pagination, Indonesian dates, duplicate/image-ad filtering and namespaced
chapter IDs. Its paths and selectors were checked against the current primary implementation:
[Keiyoushi Komiku](https://github.com/keiyoushi/extensions-source/blob/main/src/id/komiku/src/eu/kanade/tachiyomi/extension/id/komiku/Komiku.kt)
and [its native filter contract](https://github.com/keiyoushi/extensions-source/blob/main/src/id/komiku/src/eu/kanade/tachiyomi/extension/id/komiku/Filters.kt),
observed 2026-10-12. The separate Komiku.com/komiku.asia source was identified and excluded;
it is not substituted for komiku.org. The documented api.komiku.org catalogue also returned 403.
The draft compiles and its offline test passes; fixture markup represents the documented parser
contract and is not claimed to be captured live HTML. The draft stays out of the 13-entry index.

Sushiscan uses the current [SushiScan implementation](https://github.com/keiyoushi/extensions-source/blob/main/src/fr/sushiscan/src/eu/kanade/tachiyomi/extension/fr/sushiscan/SushiScan.kt)
and [MangaThemesia contract](https://github.com/keiyoushi/extensions-source/blob/main/lib-multisrc/mangathemesia/src/eu/kanade/tachiyomi/multisrc/mangathemesia/MangaThemesia.kt),
including accented titles, French dates, decimal chapters, native filters, lazy images,
literal reader JSON and base64-script metadata. It does not execute retrieved JavaScript.

IMHentai follows the primary [IMHentai implementation](https://github.com/keiyoushi/extensions-source/blob/main/src/all/imhentai/src/eu/kanade/tachiyomi/extension/all/imhentai/IMHentai.kt)
and [GalleryAdults contract](https://github.com/keiyoushi/extensions-source/blob/main/lib-multisrc/galleryadults/src/eu/kanade/tachiyomi/multisrc/galleryadults/GalleryAdults.kt).
Search language flags use the documented native names (`jp` for Japanese, `kr` for Korean).
Page metadata validates format, index, directory and media host; missing metadata requests
the actual corresponding reader page. No guessed thumbnail loader or authenticated favourites
are implemented. Both drafts pass synthetic contract fixtures, not captured live markup.

A bounded recheck of all four origins above on 2026-10-12 still returned HTTP 403 with
challenge markers. The three new draft bundles compile but stay out of the 13-entry index.
Re-evaluate after upstream accessibility changes and pass live sandbox methods before listing.

## S07 candidate evaluation, in requested order

| Candidate   | Observed origin         | Accessibility and methods                                                                                                                                                                                                               | Language and conclusion                                                                                                                                                            |
| ----------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MangaFire   | https://mangafire.to    | HTTP 200 but only a 2.6 KB shell with Cloudflare verification parameters and no title links. Requires JavaScript verification to establish catalogue/reader behavior in this environment.                                               | Language editions unverified. Deferred; HTTP 200 alone is not acceptance.                                                                                                          |
| ReManga     | https://remanga.org     | Homepage and `/manga/the-boxer_/main` return HTTP 200 with server-rendered title metadata and Next hydration. Observed API origin `https://api.remanga.org`; no chapter-reader links present in inspected title HTML.                   | Russian catalogue established by the primary site. Promising candidate; next work must verify chapter/API contracts and authentication requirements before adapter implementation. |
| SlimeRead   | https://slimeread.com   | Direct request timed out at connection establishment (`UND_ERR_CONNECT_TIMEOUT`) with a 15-second bound. No redirect or canonical alternative was observed.                                                                             | Language and methods unverified. Deferred; a local timeout does not establish permanent site failure.                                                                              |
| MangaKatana | https://mangakatana.com | Homepage and `/manga/ichi-the-witch.27430/c101` return HTTP 200. Reader exposes 17 `#imgs` images and a page-URL array. Browse/detail/reader appear compatible with plain HTTP. Search and pagination still need contract verification. | English catalogue. Best demonstrated reader feasibility of these four; suitable for the next adapter once all required methods are verified.                                       |

## Reproducible gates

`npm run check` regenerates bundles/index and checks TypeScript. `npm test` validates
offline contracts, including language parameters and chapter-ID isolation.

For a bounded live check, pass explicit keys to `npm run smoke -- <keys>`. For the actual
permission-restricted application sandbox and shared response schemas, first build the
application extensions and schemas, then run `npm run smoke:sandbox -- <keys>`.
The sibling app defaults to `../MangaWebsite`; `PROJEKT_MANGA_APP_DIR` can select another
checkout. These commands never install extensions into a user profile.

There are two new accepted site adapters, three complete unpublished site drafts and five
language editions, counted separately.
Remote publication is not performed by these validation commands.
