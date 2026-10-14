import type { MangaFilter, FilterValue } from "../../lib/types.js";
const options = (values: string[]) =>
  values.map((value) => ({ label: value, value }));
const tags = [
  "Action",
  "Adult",
  "Adventure",
  "Comedy",
  "Doujinshi",
  "Drama",
  "Ecchi",
  "Fantasy",
  "Gender Bender",
  "Harem",
  "Hentai",
  "Historical",
  "Horror",
  "Isekai",
  "Josei",
  "Lolicon",
  "Martial Arts",
  "Mature",
  "Mecha",
  "Mystery",
  "Psychological",
  "Romance",
  "School Life",
  "Sci-fi",
  "Seinen",
  "Shotacon",
  "Shoujo",
  "Shoujo Ai",
  "Shounen",
  "Shounen Ai",
  "Slice of Life",
  "Smut",
  "Sports",
  "Supernatural",
  "Tragedy",
  "Yaoi",
  "Yuri",
  "Other",
];
// Native advanced-search form, checked 2026-10-14: https://weebcentral.com/search
export const filters: MangaFilter[] = [
  {
    label: "Sort by",
    value: "sortBy",
    type: "select",
    options: [
      { label: "Default", value: "" },
      ...options([
        "Best Match",
        "Alphabet",
        "Popularity",
        "Subscribers",
        "Recently Added",
        "Latest Updates",
      ]),
    ],
  },
  {
    label: "Order",
    value: "order",
    type: "select",
    options: options(["Descending", "Ascending"]),
  },
  ...[
    ["official", "Official translation"],
    ["anime", "Anime adaptation"],
    ["adult", "Adult content"],
  ].map(([value, label]): MangaFilter => ({
    label,
    value,
    type: "select",
    options: options(["Any", "True", "False"]),
  })),
  {
    label: "Series status",
    value: "included_status",
    type: "multi",
    options: options(["Ongoing", "Complete", "Hiatus", "Canceled"]),
  },
  {
    label: "Series type",
    value: "included_type",
    type: "multi",
    options: options(["Manga", "Manhwa", "Manhua", "OEL"]),
  },
  { label: "Tags", value: "tags", type: "tri-state", options: options(tags) },
];
export function searchParams(
  query: string,
  category: string | undefined,
  active: Record<string, FilterValue> = {},
) {
  const params = new URLSearchParams({
    sort: query
      ? "Best Match"
      : category === "latest"
        ? "Latest Updates"
        : "Popularity",
    order: "Descending",
  });
  if (query) params.set("text", query);
  for (const filter of filters.filter((filter) => filter.type === "select")) {
    const value = active[filter.value];
    if (
      typeof value === "string" &&
      value &&
      filter.options?.some((option) => option.value === value)
    )
      params.set(filter.value === "sortBy" ? "sort" : filter.value, value);
  }
  for (const filter of filters.filter((filter) => filter.type === "multi")) {
    const values = active[filter.value];
    if (Array.isArray(values))
      for (const value of new Set(values))
        if (filter.options?.some((option) => option.value === value))
          params.append(filter.value, value);
  }
  const selected = active.tags;
  if (selected && typeof selected === "object" && !Array.isArray(selected)) {
    for (const side of ["include", "exclude"] as const)
      for (const value of new Set(selected[side] ?? []))
        if (tags.includes(value))
          params.append(
            side === "include" ? "included_tag" : "excluded_tag",
            value,
          );
  }
  return params;
}
