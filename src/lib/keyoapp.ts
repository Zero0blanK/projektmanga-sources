// Keyoapp: a hosted scanlation-site platform used by many English groups. Page shapes,
// selectors and the reader's CDN script follow the Keiyoushi "keyoapp" library
// (Apache-2.0); see THIRD_PARTY_NOTICES.md.
import type { Cheerio, CheerioAPI } from "cheerio/slim";
import type { AnyNode } from "domhandler";
import { createHtmlSite } from "./htmlSite.js";
import {
  MANGA_STATUS,
  chapterNumberFromName,
  normalizeText,
  parseDateToIso,
} from "./parse.js";
import type { MangaFilter, SourceManifest } from "./types.js";

export interface KeyoappOptions {
  /** The homepage section holding the popular titles. */
  popularSelector?: string;
  latestSelector?: string;
}

const STATUS: Record<string, string> = {
  ongoing: MANGA_STATUS.ONGOING,
  completed: MANGA_STATUS.COMPLETED,
  dropped: MANGA_STATUS.CANCELLED,
  paused: MANGA_STATUS.HIATUS,
  hiatus: MANGA_STATUS.HIATUS,
};

const filters: MangaFilter[] = [
  {
    label: "Type",
    value: "type",
    type: "select",
    options: ["", "Manhwa", "Manhua", "Manga", "Comic"].map((value) => ({
      label: value || "Any",
      value: value.toLowerCase(),
    })),
  },
  {
    label: "Status",
    value: "status",
    type: "select",
    options: ["", "Ongoing", "Completed", "Dropped", "Hiatus"].map((value) => ({
      label: value || "Any",
      value: value.toLowerCase(),
    })),
  },
];

/** The image a `style="background-image:url(...)"` names. */
function backgroundImage(node: Cheerio<AnyNode>): string {
  const style = node.attr("style") ?? "";
  return style.match(/url\(['"]?([^'")]+)/)?.[1] ?? "";
}

const isNovel = ($: CheerioAPI, el: AnyNode) =>
  $(el).find('[data-type="novel" i]').length > 0 ||
  $(el)
    .find("span")
    .toArray()
    .some((span) => /^novel$/i.test($(span).text().trim()));

/** "3 days ago" or "Oct 29, 2026". */
function keyoappDate(raw: string): string {
  const text = raw.trim();
  const relative = text.match(/(a|one|\d+)\s*(\w+)\s+ago/i);
  if (!relative) return parseDateToIso(text);
  const amount = /^(a|one)$/i.test(relative[1]) ? 1 : Number(relative[1]);
  const unit = relative[2].toLowerCase();
  const date = new Date();
  if (/^m(in|ins|inute|inutes)?$/.test(unit))
    date.setMinutes(date.getMinutes() - amount);
  else if (/^(h|hrs?|hours?)$/.test(unit))
    date.setHours(date.getHours() - amount);
  else if (/^(d|days?)$/.test(unit)) date.setDate(date.getDate() - amount);
  else if (/^(w|wks?|weeks?)$/.test(unit))
    date.setDate(date.getDate() - amount * 7);
  else if (/^(mos?|months?)$/.test(unit))
    date.setMonth(date.getMonth() - amount);
  else if (/^(y|yrs?|years?)$/.test(unit))
    date.setFullYear(date.getFullYear() - amount);
  else return "";
  return date.toISOString();
}

export function createKeyoappSite(
  manifest: SourceManifest,
  options: KeyoappOptions = {},
) {
  const base = manifest.base_url;
  const popular =
    options.popularSelector ??
    ["Popular", "Popularie", "Trending"]
      .map((word) => `div:contains(${word}) + div .group.overflow-hidden.grid`)
      .join(", ");

  function cardsIn($: CheerioAPI, selector: string) {
    return $(selector)
      .toArray()
      .filter((el) => !isNovel($, el))
      .flatMap((el) => {
        const card = $(el);
        const link = card.find("a[href]").first();
        const id = (link.attr("href") ?? "").match(
          /\/series\/([^/?#]+)\/?$/,
        )?.[1];
        const title = normalizeText(
          link.attr("title") || card.attr("title") || link.text(),
        );
        return id && title
          ? [
              {
                id,
                slug: id,
                title,
                thumbnail_url: backgroundImage(
                  card.find("[style*=background-image]").first(),
                ),
              },
            ]
          : [];
      });
  }

  return createHtmlSite(manifest, {
    idPattern: /^[a-z0-9][a-z0-9-]{0,199}$/i,
    chapterKeyPattern: /^[a-z0-9][a-z0-9-]{0,299}$/i,
    filters,
    // The homepage's popular row and the latest page are each one page.
    catalogueUrl: (category, page, active) => {
      if (page > 1) return null;
      if (active.type || active.status) {
        const url = new URL("/series", base);
        for (const key of ["type", "status"])
          if (typeof active[key] === "string" && active[key])
            url.searchParams.set(key, active[key]);
        return url.href;
      }
      return new URL(category === "latest" ? "/latest/" : "/", base).href;
    },
    // The series page lists every title; the site's own search filters it in the browser.
    searchUrl: (_query, page) =>
      page === 1 ? new URL("/series", base).href : null,
    searchFiltersTitles: true,
    parseCards: ($) => {
      const rows = [
        ...cardsIn($, popular),
        ...cardsIn($, options.latestSelector ?? "div.grid > div.group"),
        ...cardsIn($, "#searched_series_page > button"),
      ];
      // A filtered series page: entries carry their type and status as attributes.
      return rows;
    },
    titleUrl: (id) => `/series/${id}/`,
    parseDetails: ($) => {
      const type = normalizeText(
        $("div:has(span:contains(Type)) ~ div").first().text(),
      );
      const synopsis = normalizeText($("#expand_content p").text());
      const alt = $("div.font-medium:contains(Alternative titles) ~ div span")
        .map((_, el) => normalizeText($(el).text()))
        .get()
        .filter((name) => name && name !== "No alternative titles.");
      const author = normalizeText(
        $("div:has(span:contains(Author)) ~ div").first().text(),
      );
      const artist = normalizeText(
        $("div:has(span:contains(Artist)) ~ div").first().text(),
      );
      return {
        title: normalizeText($("div.grid > h1").first().text()),
        thumbnail_url: backgroundImage(
          $("div[class*=photoURL], div[style*=photoURL]").first(),
        ),
        status:
          STATUS[
            normalizeText(
              $("div:has(span:contains(Status)) ~ div").first().text(),
            ).toLowerCase()
          ] ?? MANGA_STATUS.UNKNOWN,
        author: author ? [author] : [],
        artist: artist ? [artist] : [],
        genres: [
          ...(type ? [type.charAt(0).toUpperCase() + type.slice(1)] : []),
          ...$("div:has(>h1) a[href*='genre=']")
            .map((_, el) =>
              normalizeText($(el).text()).replace(/^[, ]+|[, ]+$/g, ""),
            )
            .get(),
        ].filter(Boolean),
        description: [
          synopsis,
          alt.length
            ? `Alternative titles:\n${alt.map((name) => `- ${name}`).join("\n")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      };
    },
    // Upcoming and coin-locked chapters can't be read.
    parseChapters: ($) =>
      $("#chapters > a, #chapters > div")
        .toArray()
        .filter(
          (el) =>
            $(el).find("img[alt~=Coin]").length === 0 &&
            !/upcoming/i.test($(el).find(".text-sm span").text()),
        )
        .flatMap((el) => {
          const link = $(el).is("a[href]")
            ? $(el)
            : $(el).find("a[href]").first();
          const key = (link.attr("href") ?? "").match(
            /\/chapter\/([^/?#]+)\/?$/,
          )?.[1];
          const name = normalizeText($(el).find(".text-sm").first().text());
          return key
            ? [
                {
                  key,
                  name,
                  number: chapterNumberFromName(name, 0),
                  date: keyoappDate($(el).find(".text-xs").first().text()),
                },
              ]
            : [];
        }),
    chapterUrl: (key) => `/chapter/${key}/`,
    // Pages name their image by `uid`; the CDN host is in the reader's script as
    // realUrl = `https://<host>/...`. Older chapters carry plain image URLs.
    parsePages: ($, html) => {
      const host = html
        .match(/realUrl\s*=\s*`[^`]+\/\/([^/]+)/)?.[1]
        ?.replace(/\$\{[^}]*\}/g, "");
      const uids = $("#pages > img")
        .map((_, el) => $(el).attr("uid") ?? "")
        .get()
        .filter(Boolean);
      if (uids.length && host)
        return uids.map((uid) => `https://${host}/uploads/${uid}`);
      return $("#pages > img")
        .map(
          (_, el) =>
            $(el).attr("data-lazy-src") ||
            $(el).attr("data-src") ||
            $(el).attr("src") ||
            "",
        )
        .get()
        .filter((src) => /^(https?:)?\/\/cdn\d*\.keyoapp\.com/.test(src));
    },
  });
}
