import { createMadaraSite } from "../../lib/madaraSite.js";
import type { MangaFilter, SourceManifest } from "../../lib/types.js";
import manifest from "./manifest.json";
import filters from "./filters.json";
export default createMadaraSite(
  manifest as SourceManifest,
  filters as MangaFilter[],
  false,
);
