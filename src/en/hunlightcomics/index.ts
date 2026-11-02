// Hunlight Comics: Madara theme. Generated from the Keiyoushi extension
// src/en/hunlightcomics @ efa93f5a35 (Apache-2.0); see THIRD_PARTY_NOTICES.md.
import { createMadaraSite } from "../../lib/madaraSite.js";
import type { MangaFilter, SourceManifest } from "../../lib/types.js";
import manifest from "./manifest.json";
import filters from "./filters.json";
export default createMadaraSite(manifest as SourceManifest, filters as MangaFilter[], true, ".reading-content img", "m", {"browse":"ajax"});
