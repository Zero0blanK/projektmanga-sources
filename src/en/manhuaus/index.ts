// ManhuaUS: Madara theme. Directory, chapter listing and reader settings follow the
// Keiyoushi extension for this site (Apache-2.0); see THIRD_PARTY_NOTICES.md.
import { createMadaraSite } from "../../lib/madaraSite.js";
import type { MangaFilter, SourceManifest } from "../../lib/types.js";
import manifest from "./manifest.json";
import filters from "./filters.json";
export default createMadaraSite(
  manifest as SourceManifest,
  filters as MangaFilter[],
  true,
  ".reading-content img",
  "manga",
);
