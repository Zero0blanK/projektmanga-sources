import { createThemesiaSite } from "../../lib/themesiaSite.js";
import type { MangaFilter, SourceManifest } from "../../lib/types.js";
import manifest from "./manifest.json";
import filters from "./filters.json";
export default createThemesiaSite(
  manifest as SourceManifest,
  filters as MangaFilter[],
  "/series/",
);
