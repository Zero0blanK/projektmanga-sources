# Japanese publisher sources

Ten sources use the public GigaViewer catalogue and reader contract: Comic Days,
Comic Action, Comic Gardo, Kurage Bunch, Shonen Jump+, Tonari no Young Jump, MagComi,
Comic Ogyaaa!!, Comic Trail and Comic Seasons.

References are the corresponding `src/ja/<source>/` implementations in
[Keiyoushi extensions-source](https://github.com/keiyoushi/extensions-source/tree/780153a29642a57364e894bc0850c4e76619c7de/src/ja),
and the shared
[GigaViewer engine](https://github.com/keiyoushi/extensions-source/tree/780153a29642a57364e894bc0850c4e76619c7de/lib-multisrc/gigaviewer/src/eu/kanade/tachiyomi/multisrc/gigaviewer)
at revision `780153a29642a57364e894bc0850c4e76619c7de`.
Apache-2.0 attribution is retained in `THIRD_PARTY_NOTICES.md` and the local license.

The TypeScript port translates collection IDs and queries into brokered GraphQL
requests, sorts catalogue lists, uses context-bound cursors for app pagination and
provides each publisher's collection filters. Shonen Jump+ uses its upstream series
HTML catalogue and GraphQL search. Reading data remains owned by the app.

Only anonymously readable chapters are returned; purchase-only or unavailable
products are omitted. Unscrambled free chapter images are supported. GigaViewer
`choJuGiga: baku` images require a tile transformation that the current URL-only source
contract does not support. Those chapters report the limitation clearly. A live check on
2026-10-14 found `baku` on every sampled free episode (30/30 across Shonen Jump+, Comic
Days, Tonari no Young Jump, MagComi, Kurage Bunch and Comic Action), so all ten sources
are `draft: true` and unlisted until the source contract can carry descrambled pages. These ports
do not claim authenticated purchase support or complete compatibility with every
publisher chapter.

Deterministic tests for all ten sources cover catalogue continuation/end, search,
query-bound cursors, collection validation, chapter availability, metadata, page
slicing, source-prefixed chapter identities, foreign identifiers and scrambled-page
errors. These tests establish contract behavior; they do not establish that every
publisher is currently reachable from every region or network.

## Raw manga sites (2026-10-30)

Ten listed sources read Japanese raw manga from aggregator sites, whose images are plain
files (the publisher sites above scramble theirs). References are the matching
`src/ja/<upstream>/` extensions in Keiyoushi revision `dbf6c05d` (Apache-2.0). Each passed
`npm run smoke` against its live site on 2026-10-30, and `tests/source-wave-3.test.mjs`
checks each offline.

| Source | Upstream | How |
| --- | --- | --- |
| MangaRW | `mangarw` | `htmlSite.ts`; chapters from the site's chapter API (`<option>` list) |
| MiuRaw | `miuraw` | `htmlSite.ts`; pages through the site's own image proxy, as its reader loads them |
| MangaKuro | `mangakuro` | `htmlSite.ts`; pages from the image-list endpoint keyed by the chapter's id |
| Rawkuma | `rawkuma` ("natsuid") | WordPress REST API for listing, search and details; the theme's chapter list |
| Raw1001 | `raw1001` | `liliana.ts` (new): ranking/catalogue pages and the image-list endpoint |
| RawOtaku | `rawotaku` ("mangareader") | `htmlSite.ts`; chapter keys carry the reader id the image endpoint needs |
| RawDevArt, RawUwU | `rawdevartart`, `rawuwu` | `spaRaw.ts` (new): the sites' shared `/spa/` JSON API |
| Love4u | `welovemangaone` ("fmreader") | `htmlSite.ts`; the title is base64-encoded, so the breadcrumb's copy is used |
| NihonKuni | `mangagun` ("fmreader") | `htmlSite.ts`; the chapter list repeats links, so keys are de-duplicated |

Left out after checking: SoraRaw (scrambled images), KissLove/KLZ9 (its API wants a
signature built from a key in the site's scripts), RawINU (a DDoS-check page that has to be
answered), Kumaraw and HachiRaw (Cloudflare's browser check), NicoManga (pages are an
obfuscated script payload) and Kmansin09 (its image host doesn't resolve).
