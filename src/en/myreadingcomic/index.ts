// MyReadingComic: Yiimanga theme. Generated from the Keiyoushi extension
// src/en/myreadingcomic @ efa93f5a35 (Apache-2.0); see THIRD_PARTY_NOTICES.md.
import { createYiimangaSite } from "../../lib/yiimanga.js";
import type { MangaFilter, SourceManifest } from "../../lib/types.js";
import manifest from "./manifest.json";
import filters from "./filters.json";
export default createYiimangaSite(manifest as SourceManifest, filters as MangaFilter[], {"mangaPath":"comic","searchParam":"q","popularPath":"porn-comics"});
