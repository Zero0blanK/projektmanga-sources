import type { MangaFilter, FilterValue } from "../../lib/types.js";
import genres from "./genres.json";
const options = (values: string[]) =>
  values.map((value) => ({ label: value, value }));
// Native browse controls and genre slugs, checked 2026-10-14: https://asurascans.com/browse/comics
export const filters: MangaFilter[] = [
  {
    label: "Sort by",
    value: "sortBy",
    type: "select",
    options: [
      { label: "Default", value: "" },
      { label: "Latest update", value: "update" },
      { label: "Popular", value: "popular" },
      { label: "Rating", value: "rating" },
      { label: "A–Z", value: "name" },
      { label: "Newest", value: "newest" },
    ],
  },
  {
    label: "Order",
    value: "order",
    type: "select",
    options: [
      { label: "Default", value: "" },
      { label: "Descending", value: "desc" },
      { label: "Ascending", value: "asc" },
    ],
  },
  {
    label: "Status",
    value: "status",
    type: "select",
    options: options([
      "all",
      "ongoing",
      "completed",
      "hiatus",
      "dropped",
      "axed",
    ]),
  },
  {
    label: "Type",
    value: "type",
    type: "select",
    options: [
      { label: "All", value: "all" },
      { label: "Manhwa", value: "manhwa" },
      { label: "Manhua", value: "manhua" },
      { label: "Mangatoon", value: "manga" },
    ],
  },
  { label: "Genres", value: "genres", type: "multi", options: genres },
  { label: "Author", value: "author", type: "input" },
  { label: "Artist", value: "artist", type: "input" },
  { label: "Minimum chapters", value: "min_chapters", type: "input" },
];
export function browseParams(
  query: string,
  category: string | undefined,
  active: Record<string, FilterValue> = {},
) {
  const params = new URLSearchParams({
    sort: category === "popular" ? "popular" : "update",
  });
  if (query) params.set("q", query);
  for (const filter of filters.filter((filter) => filter.type === "select")) {
    const value = active[filter.value];
    if (
      typeof value === "string" &&
      value &&
      value !== "all" &&
      filter.options?.some((option) => option.value === value)
    )
      params.set(filter.value === "sortBy" ? "sort" : filter.value, value);
  }
  if (!params.has("order"))
    params.set("order", params.get("sort") === "name" ? "asc" : "desc");
  const chosen = active.genres;
  if (Array.isArray(chosen)) {
    const valid = [
      ...new Set(
        chosen.filter((value) => genres.some((genre) => genre.value === value)),
      ),
    ];
    if (valid.length) params.set("genres", valid.join(","));
  }
  for (const key of ["author", "artist"])
    if (typeof active[key] === "string" && active[key].trim())
      params.set(key, active[key].trim());
  const minimum = Number(active.min_chapters);
  if (Number.isSafeInteger(minimum) && minimum > 0)
    params.set("min_chapters", String(minimum));
  return params;
}
