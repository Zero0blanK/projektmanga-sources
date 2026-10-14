# Flame Comics

Reference: Keiyoushi `extensions-source` revision
`780153a29642a57364e894bc0850c4e76619c7de`,
[FlameComics.kt](https://github.com/keiyoushi/extensions-source/blob/780153a29642a57364e894bc0850c4e76619c7de/src/en/flamecomics/src/eu/kanade/tachiyomi/extension/en/flamecomics/FlameComics.kt),
[Dto.kt](https://github.com/keiyoushi/extensions-source/blob/780153a29642a57364e894bc0850c4e76619c7de/src/en/flamecomics/src/eu/kanade/tachiyomi/extension/en/flamecomics/Dto.kt),
and the adjacent `build.gradle.kts`. Apache-2.0 attribution is retained in
`THIRD_PARTY_NOTICES.md` and `licenses/keiyoushi-Apache-2.0.txt`.

The TypeScript port uses the upstream Next data routes, discovers the current build
identifier, and retries once after a deployment changes it. Search matches titles and
alternate titles locally, matching upstream's complete browse-list model. The app's
native cursors slice that list without downloading it again for every page. Added local
sort, type and status filters operate on the returned series metadata.

Numeric title IDs and source-prefixed chapter IDs are validated before building URLs.
Reader and cover URLs use the upstream `cdn.flamecomics.xyz` image layout. Responses
are checked before conversion. The icon is an original SVG flame symbol, not an upstream logo.

Offline tests cover pagination end boundaries, duplicate IDs, contextual cursors,
alternate-title search, filter combinations, details, chapter ordering, page slicing,
foreign URLs/IDs, malformed responses and deployment build refresh.
