import { createMangaThemesiaSource } from "../lib/mangaThemesia.js";
import { normalizeText, parseDateToIso } from "../lib/parse.js";
import type { SourceManifest } from "../lib/types.js";
import manifest from "./manifest.json";
export function parseFrenchDate(value: string): string {
  const months: Record<string, string> = {
    janvier: "January",
    février: "February",
    mars: "March",
    avril: "April",
    mai: "May",
    juin: "June",
    juillet: "July",
    août: "August",
    septembre: "September",
    octobre: "October",
    novembre: "November",
    décembre: "December",
  };
  const text = normalizeText(value).toLowerCase();
  const absolute = text.match(/^(\d{1,2})\s+(\p{L}+)\s+(\d{4})$/u);
  if (absolute) {
    const month = Object.keys(months).indexOf(absolute[2]),
      day = Number(absolute[1]),
      year = Number(absolute[3]);
    if (month < 0) return "";
    const date = new Date(Date.UTC(year, month, day));
    return date.getUTCFullYear() === year &&
      date.getUTCMonth() === month &&
      date.getUTCDate() === day
      ? date.toISOString()
      : "";
  }
  return parseDateToIso(
    text.replace(/\b\p{L}+\b/gu, (word) => months[word] ?? word),
  );
}
export default createMangaThemesiaSource({
  manifest: manifest as SourceManifest,
  cataloguePath: "/catalogue/",
  parseDate: parseFrenchDate,
  selectors: {
    author: ".infotable tr:contains(Auteur) td:last-child",
    artist: ".infotable tr:contains(Artiste) td:last-child",
    status: ".infotable tr:contains(Statut) td:last-child",
  },
});
