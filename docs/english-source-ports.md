# English source ports

References use Keiyoushi revision `780153a29642a57364e894bc0850c4e76619c7de` (Apache-2.0). These are curated maintained adapters; no measured popularity ranking is claimed.

| Source | Engine | Upstream |
| --- | --- | --- |
| Arena Scans | themesia | [arenascans](https://github.com/keiyoushi/extensions-source/tree/780153a29642a57364e894bc0850c4e76619c7de/src/en/arenascans) |
| Aster Scans | themesia | [asterscans](https://github.com/keiyoushi/extensions-source/tree/780153a29642a57364e894bc0850c4e76619c7de/src/en/asterscans) |
| Athrea Scans | themesia | [athreascans](https://github.com/keiyoushi/extensions-source/tree/780153a29642a57364e894bc0850c4e76619c7de/src/en/athreascans) |
| Scythe Scans | themesia | [erosscans](https://github.com/keiyoushi/extensions-source/tree/780153a29642a57364e894bc0850c4e76619c7de/src/en/erosscans) |
| King of Shojo | themesia | [kingofshojo](https://github.com/keiyoushi/extensions-source/tree/780153a29642a57364e894bc0850c4e76619c7de/src/en/kingofshojo) |
| Lagoon Scans | themesia | [lagoonscans](https://github.com/keiyoushi/extensions-source/tree/780153a29642a57364e894bc0850c4e76619c7de/src/en/lagoonscans) |
| Madara Scans | themesia | [madarascans](https://github.com/keiyoushi/extensions-source/tree/780153a29642a57364e894bc0850c4e76619c7de/src/en/madarascans) |
| Manga Trend | themesia | [mangatrend](https://github.com/keiyoushi/extensions-source/tree/780153a29642a57364e894bc0850c4e76619c7de/src/en/mangatrend) |
| Rackus | themesia | [rackus](https://github.com/keiyoushi/extensions-source/tree/780153a29642a57364e894bc0850c4e76619c7de/src/en/rackus) |
| Raven Scans | themesia | [ravenscans](https://github.com/keiyoushi/extensions-source/tree/780153a29642a57364e894bc0850c4e76619c7de/src/en/ravenscans) |
| Violet Scans | themesia | [violetscans](https://github.com/keiyoushi/extensions-source/tree/780153a29642a57364e894bc0850c4e76619c7de/src/en/violetscans) |
| Manhua Plus | madara | [manhuaplus](https://github.com/keiyoushi/extensions-source/tree/780153a29642a57364e894bc0850c4e76619c7de/src/en/manhuaplus) |
| MangaRead.org | madara | [mangareadorg](https://github.com/keiyoushi/extensions-source/tree/780153a29642a57364e894bc0850c4e76619c7de/src/en/mangareadorg) |
| LHTranslation | madara | [lhtranslation](https://github.com/keiyoushi/extensions-source/tree/780153a29642a57364e894bc0850c4e76619c7de/src/en/lhtranslation) |
| Zinmanga | madara | [zinmanga](https://github.com/keiyoushi/extensions-source/tree/780153a29642a57364e894bc0850c4e76619c7de/src/en/zinmanga) |
| GalaxyDegenScans | madara | [galaxydegenscans](https://github.com/keiyoushi/extensions-source/tree/780153a29642a57364e894bc0850c4e76619c7de/src/en/galaxydegenscans) |
| S2Manga | madara | [s2manga](https://github.com/keiyoushi/extensions-source/tree/780153a29642a57364e894bc0850c4e76619c7de/src/en/s2manga) |
| Manga District | madara | [mangadistrict](https://github.com/keiyoushi/extensions-source/tree/780153a29642a57364e894bc0850c4e76619c7de/src/en/mangadistrict) |
| Mangafree | madara | [mangafree](https://github.com/keiyoushi/extensions-source/tree/780153a29642a57364e894bc0850c4e76619c7de/src/en/mangafree) |
| Flame Comics | Next data routes | See [Flame port](flame-comics-port.md) |

Catalogue requests and excerpts were observed for the 19 theme sites during this task. Minimal public catalogue excerpts are stored in tests/fixtures/english-ports; scripts, advertising and unrelated page content are excluded. Parser tests combine those excerpts with synthetic detail/chapter/page fixtures. Full live chapter-reader acceptance for every source has not been established.

MangaThemesia ports retain per-site catalogue directories, native title/page/yearx parameters, paid-chapter exclusions and static filter choices read from catalogue forms. Madara ports reuse the existing details/reader parser and add native continuation, validated source identities and the documented POST chapter endpoint for MangaRead, LHTranslation and GalaxyDegenScans. Manga District uses /series/ URLs. Manhua Plus uses .read-container reader images. All network calls remain brokered by the app sandbox.

Each source has a local SVG monogram icon, static filters, manifest and self-contained bundle. Existing adapters retain their defaults; shared-engine bundle changes have patch version bumps. Sources found blocked, parked or incompatible during candidate selection were excluded.

## Second wave (2026-10-30)

References use Keiyoushi revision `dbf6c05d` (Apache-2.0). Candidates were the widely used English Keiyoushi extensions on engines this repository has or now has, plus popular single-site readers. Every listed source passed `npm run smoke` against its live site (browse, search, details, chapter list, a chapter's pages and the first page image) on 2026-10-30, and `tests/english-wave-2.test.mjs` checks each one offline. Popularity is judged, not measured: Keiyoushi publishes no install counts.

| Engine | Sources |
| --- | --- |
| Madara (`madaraSite.ts`) | MangaOwl.io, Mangasushi, ManhuaHot, ManhwaReads, Lily Manga, ManhuaNext, ManhwaNex, Manga Eclipse, Sleepy Translations, Tritinia Scans, Cocomic, Yaksha Comics |
| MangaThemesia (`themesiaSite.ts`) | Eva Scans, Rokari Comics, Thunder Scans |
| MangaBox (`mangaBox.ts`, new) | MangaBat, Mangakakalot (kakamanga.com), Manganato (manganato.gg) |
| Keyoapp (`keyoapp.ts`, new) | Grim Scans, Mist Scans, Kewn Scans, Writer Scans, Timeless Toons |
| Iken (`iken.ts`, new) | Vortex Scans, Hive Toons, Nyx Scans, Ken Comics, Orion Scans, Sana Scans, Hijala Scans |
| Own port (`htmlSite.ts` or JSON) | MangaPill, MangaKatana, TCB Scans, Dynasty Scans, Demonic Scans |

Mangakakalot and Manganato answer search only after Cloudflare's browser check; everything else works directly. In the desktop app, "open the source in a browser" passes the check once and the sandbox reuses the cookies.

Left out after checking the live sites (Toonily, Manhwatop, ManhuaUS, MangaTown and MangaHere were added later, in the third wave): Webtoon.xyz, ToonGod, MangaGG, Webtoon Scan, Setsu Scans, DragonTea, Brainrot Comics, Rage Scans and MeiToon (every request challenged or refused); KunManga, ZazaManga, Zinmanga.net (title pages refuse the chapter request), Toonizy (catalogue moved to the site root), TopManhua and TopManhua.net (images refused), BunManga (too slow), Hades Scans (empty catalogue), Comic Asura (catalogue gone), Rena Scans (unreachable), Magus Toon (images refused), Rizz Fables (custom JSON catalogue, not the theme); MangaFox (licensed removals, one request per page image); MangaBuddy, MangaForest and Comick mirrors (down).

Engine fixes made alongside, in every source on those engines (patch versions bumped): chapter numbers come from the "Chapter/Episode" word rather than the first number in a name ("Vol. 2 Chapter 15" is 15); a prologue or extra without a number no longer fails a MangaThemesia chapter list; a card without a title or with an off-site link is skipped rather than failing a catalogue page; Madara accepts chapter and title links without a trailing slash, any title directory (`serie`, `read`, `gl`, `webtoons`…), and the paginated `ajax/chapters/?t=N` listing. Zinmanga is drafted: its image CDN answers 404 for every page.

## Third wave (2026-10-30)

Added on request, with the same Keiyoushi revision `dbf6c05d`; `tests/source-wave-3.test.mjs` checks each one offline, together with the ten Japanese raw sites in `docs/japanese-source-ports.md`.

| Source | How |
| --- | --- |
| MangaHere | Own port. The long-strip reader's image list and the page reader's key are in Dean Edwards "packed" scripts, which `lib/packer.ts` decodes as text without running them; the page reader then asks `chapterfun.ashx` for two pages a call. Mature titles need the site's `isAdult=1` cookie, which every request sends. |
| MangaTown | Own port: one reader page per image, listed in the reader's page `<select>`. Licensed titles keep their details with a note that the site removed the chapters. |
| Toonily, Manhwatop, ManhuaUS | Madara (`madaraSite.ts`) with the `ajax/chapters/` chapter list; Toonily's titles live under `serie/`. |

MangaHere and MangaTown passed `npm run smoke` on 2026-10-30. Toonily, Manhwatop and ManhuaUS answer every request with Cloudflare's browser check, so they couldn't be smoke-tested; they work once the desktop app's "open in browser" has passed the check, and their descriptions say so. Their genre filters can't be read past the check, so they offer order and status only.
