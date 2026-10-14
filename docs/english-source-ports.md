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
