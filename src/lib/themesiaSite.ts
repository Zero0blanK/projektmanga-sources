import {
  createMangaThemesiaSource,
  type MangaThemesiaConfig,
} from "./mangaThemesia.js";
import type { MangaFilter, SourceManifest } from "./types.js";

/** ProjektManga MangaThemesia site preset: the native catalogue form, filters and chapter
 * row rules shared by our English theme sources. */
export function createThemesiaSite(
  manifest: SourceManifest,
  filters: MangaFilter[],
  cataloguePath: string,
  selectors?: MangaThemesiaConfig["selectors"],
) {
  return createMangaThemesiaSource({
    manifest,
    filters,
    cataloguePath,
    selectors: {
      chapterRows:
        '#chapterlist li:has(a[href]):not(:has(a[href="#"])):not(:has(.locked-badge)):not(:has(a[data-bs-target])):not(:has(a[data-coin])), div.bxcl li:has(a[href]):not(:has(a[href="#"]))',
      ...selectors,
    },
    catalogueRoute: new RegExp(
      `^${cataloguePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:page/\\d+/)?$`,
    ),
    buildCatalogueUrl(category, query, active, page) {
      const url = new URL(cataloguePath, manifest.base_url);
      url.searchParams.set("page", String(page));
      if (query) url.searchParams.set("title", query);
      url.searchParams.set(
        "order",
        category === "popular" ? "popular" : "update",
      );
      for (const key of ["status", "type", "order", "author", "year"])
        if (typeof active[key] === "string" && active[key])
          url.searchParams.set(
            key === "year" ? "yearx" : key,
            String(active[key]),
          );
      if (Array.isArray(active.genre))
        for (const genre of active.genre)
          url.searchParams.append("genre[]", genre);
      return url;
    },
  });
}
