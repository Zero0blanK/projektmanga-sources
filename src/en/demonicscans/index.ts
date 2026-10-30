// Demonic Scans. Page shapes and selectors follow the Keiyoushi "MangaDemon" extension
// (Apache-2.0); see THIRD_PARTY_NOTICES.md.
import { createHtmlSite, lazyImage } from "../../lib/htmlSite.js";
import {
  chapterNumberFromName,
  mapMangaStatus,
  normalizeText,
  parseDateToIso,
} from "../../lib/parse.js";
import type {
  FilterValue,
  MangaFilter,
  SourceManifest,
} from "../../lib/types.js";
import manifest from "./manifest.json";

const filters: MangaFilter[] = [
  {
    label: "Sort",
    value: "orderby",
    type: "select",
    options: [
      { label: "Views", value: "VIEWS DESC" },
      { label: "Bookmarks", value: "Bookmarks DESC" },
      { label: "Name", value: "NAME ASC" },
    ],
  },
  {
    label: "Status",
    value: "status",
    type: "select",
    options: [
      { label: "All", value: "all" },
      { label: "Ongoing", value: "ongoing" },
      { label: "Completed", value: "completed" },
    ],
  },
];

function advanced(page: number, active: Record<string, FilterValue>) {
  const url = new URL("/advanced.php", manifest.base_url);
  url.searchParams.set("list", String(page));
  url.searchParams.set(
    "status",
    typeof active.status === "string" && active.status ? active.status : "all",
  );
  url.searchParams.set(
    "orderby",
    typeof active.orderby === "string" && active.orderby
      ? active.orderby
      : "VIEWS DESC",
  );
  return url.href;
}

const titleOf = (href: string) => {
  const match = href.match(/^\/manga\/([^/?#]+)$/)?.[1];
  return match ? decodeURIComponent(match) : undefined;
};

export default createHtmlSite(manifest as SourceManifest, {
  // Titles are /manga/<Name-Words>; chapters chaptered.php?manga=<n>&chapter=<n>.
  idPattern: /^[A-Za-z0-9][A-Za-z0-9!'(),.:;_~+-]{0,299}$/,
  chapterKeyPattern: /^\d+\/\d+(?:\.\d+)?$/,
  filters,
  catalogueUrl: (category, page, active) =>
    category === "latest" && Object.keys(active).length === 0
      ? new URL(`/lastupdates.php?list=${page}`, manifest.base_url).href
      : advanced(page, active),
  // Search returns one unpaginated list.
  // A one-letter search takes the site longer than the app waits.
  searchUrl: (query, page) =>
    page === 1 && query.length >= 2
      ? new URL(
          `/search.php?manga=${encodeURIComponent(query)}`,
          manifest.base_url,
        ).href
      : null,
  parseCards: ($) => {
    // Catalogue, latest updates and search each list titles their own way.
    const advancedRows = $("div#advanced-content > div.advanced-element")
      .toArray()
      .map((el) => ({
        href: $(el).find("a").first().attr("href") ?? "",
        title: normalizeText($(el).find("h1").first().text()),
        image: $(el).find("img").first(),
      }));
    const latestRows = $(
      "div#updates-container > div.updates-element:not(:has(.toffee-badge))",
    )
      .toArray()
      .map((el) => {
        const link = $(el).find("div.updates-element-info a").first();
        return {
          href: link.attr("href") ?? "",
          title: normalizeText(link.text()),
          image: $(el).find("div.thumb img").first(),
        };
      });
    // Search results are a bare fragment of <li>s inside <a>s, which an HTML parser
    // takes apart; they are read from the markup as written.
    const searchRows = [
      ...$.html().matchAll(
        /<a href="(\/manga\/[^"]+)">\s*<li[^>]*>\s*<img src="([^"]*)"[\s\S]*?seach-right[^>]*>\s*<div>([^<]+)<\/div>/g,
      ),
    ].map(([, href, image, title]) => ({
      href,
      title: normalizeText(title),
      image,
    }));
    return [
      ...[...advancedRows, ...latestRows].map((row) => ({
        ...row,
        image: lazyImage(row.image),
      })),
      ...searchRows,
    ].flatMap((row) => {
      const id = titleOf(row.href);
      return id && row.title
        ? [{ id, slug: id, title: row.title, thumbnail_url: row.image }]
        : [];
    });
  },
  titleUrl: (id) => `/manga/${encodeURIComponent(id)}`,
  parseDetails: ($) => {
    const info = $("div#manga-info-container").first();
    const stat = (label: string) =>
      normalizeText(
        info
          .find(`div#manga-info-stats > div:has(> li:contains(${label})) > li`)
          .eq(1)
          .text(),
      );
    const author = stat("Author");
    return {
      title: normalizeText(info.find("h1.big-fat-titles").first().text()),
      thumbnail_url: lazyImage(info.find("div#manga-page img").first()),
      genres: info
        .find("div.genres-list > li")
        .map((_, el) => normalizeText($(el).text()))
        .get()
        .filter(Boolean),
      description: normalizeText(
        info
          .find("div#manga-info-rightColumn > div > div.white-font")
          .first()
          .text(),
      ),
      author: author && !/updating/i.test(author) ? [author] : [],
      status: mapMangaStatus(stat("Status")),
    };
  },
  parseChapters: ($) =>
    $("div#chapters-list a.chplinks")
      .toArray()
      .flatMap((el) => {
        const link = $(el);
        const match = (link.attr("href") ?? "").match(
          /manga=(\d+)&chapter=(\d+(?:\.\d+)?)/,
        );
        if (!match) return [];
        const name = normalizeText(
          link.clone().children().remove().end().text(),
        );
        return [
          {
            key: `${match[1]}/${match[2]}`,
            name: name || `Chapter ${match[2]}`,
            number: chapterNumberFromName(name, Number(match[2])),
            date: parseDateToIso(link.find("span").first().text().trim()),
          },
        ];
      }),
  chapterUrl: (key) => {
    const [manga, chapter] = key.split("/");
    return `/chaptered.php?manga=${manga}&chapter=${chapter}`;
  },
  parsePages: ($) =>
    $("div > img.imgholder")
      .map((_, el) => lazyImage($(el)))
      .get(),
});
