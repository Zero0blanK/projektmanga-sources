// Read Berserk Manga: MangaCatalog theme. Generated from the Keiyoushi extension
// src/en/readberserkmanga @ efa93f5a35 (Apache-2.0); see THIRD_PARTY_NOTICES.md.
import { createMangaCatalogSite } from "../../lib/mangaCatalog.js";
import type { SourceManifest } from "../../lib/types.js";
import manifest from "./manifest.json";
export default createMangaCatalogSite(manifest as SourceManifest, {
  "titles": [
    {
      "title": "Berserk",
      "slug": "berserk"
    },
    {
      "title": "Guidebook",
      "slug": "berserk-official-guidebook"
    },
    {
      "title": "Colored",
      "slug": "berserk-colored"
    },
    {
      "title": "Duranki",
      "slug": "duranki"
    },
    {
      "title": "Gigantomakhia",
      "slug": "gigantomakhia"
    },
    {
      "title": "Futatabi",
      "slug": "futatabi"
    },
    {
      "title": "Berserk Spoilers & RAW",
      "slug": "berserk-spoilers-raw"
    }
  ],
  "layout": "card"
});
