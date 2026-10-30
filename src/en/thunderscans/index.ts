// Thunder Scans: MangaThemesia theme. Catalogue path follows the Keiyoushi extension for
// this site (Apache-2.0); see THIRD_PARTY_NOTICES.md.
import { createThemesiaSite } from "../../lib/themesiaSite.js";
import type { MangaFilter, SourceManifest } from "../../lib/types.js";
import manifest from "./manifest.json";
import filters from "./filters.json";
export default createThemesiaSite(
  manifest as SourceManifest,
  filters as MangaFilter[],
  "/comics/",
);
