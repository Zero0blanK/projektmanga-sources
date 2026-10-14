import { createThemesiaSite } from "../../lib/themesiaSite.js";
import type { MangaFilter, SourceManifest } from "../../lib/types.js";
import manifest from "./manifest.json";
import filters from "./filters.json";
export default createThemesiaSite(
  manifest as SourceManifest,
  filters as MangaFilter[],
  "/comics/",
  {
    cards: `.utao .uta .imgu, .listupd .bs .bsx:not(:has(.novelabel)), .listo .bs .bsx:not(:has(.novelabel))`,
    chapterRows: `#chapterlist li:not(:has(svg)):has(a[href]):not(:has(a[href="#"]))`,
  },
);
