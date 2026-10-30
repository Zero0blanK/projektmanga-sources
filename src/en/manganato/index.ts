// Manganato: the MangaBox site design (see lib/mangaBox.ts).
import { createMangaBoxSite } from "../../lib/mangaBox.js";
import type { SourceManifest } from "../../lib/types.js";
import manifest from "./manifest.json";
export default createMangaBoxSite(manifest as SourceManifest);
