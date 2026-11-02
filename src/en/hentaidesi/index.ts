// Hentai Desi: MangaThemesia theme. Generated from the Keiyoushi extension
// src/en/hentaidesi @ efa93f5a35 (Apache-2.0); see THIRD_PARTY_NOTICES.md.
import { createThemesiaSite } from "../../lib/themesiaSite.js";
import type { MangaFilter, SourceManifest } from "../../lib/types.js";
import manifest from "./manifest.json";
import filters from "./filters.json";
export default createThemesiaSite(manifest as SourceManifest, filters as MangaFilter[], "/manga/");
