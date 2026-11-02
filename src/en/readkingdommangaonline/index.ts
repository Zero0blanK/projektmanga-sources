// Read Kingdom Manga Online: MangaCatalog theme. Generated from the Keiyoushi extension
// src/en/readkingdommangaonline @ efa93f5a35 (Apache-2.0); see THIRD_PARTY_NOTICES.md.
import { createMangaCatalogSite } from "../../lib/mangaCatalog.js";
import type { SourceManifest } from "../../lib/types.js";
import manifest from "./manifest.json";
export default createMangaCatalogSite(manifest as SourceManifest, {
  "titles": [
    {
      "title": "Kingdom",
      "slug": "kingdom"
    },
    {
      "title": "Li Mu",
      "slug": "li-mu"
    },
    {
      "title": "Meng Wu & Chu Zi",
      "slug": "meng-wu-and-chu-zi-one-shot"
    }
  ]
});
