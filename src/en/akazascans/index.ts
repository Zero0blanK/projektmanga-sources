import { createMangaThemesiaSource } from "../../lib/mangaThemesia.js";
import type { MangaFilter, SourceManifest } from "../../lib/types.js";
import manifest from "./manifest.json";
import filters from "./filters.json";
export default createMangaThemesiaSource({
  manifest: manifest as SourceManifest,
  filters: filters as MangaFilter[],
});
