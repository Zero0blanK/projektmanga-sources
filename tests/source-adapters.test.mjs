import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";

const SOURCE_ROOT = process.cwd();
const schemasEntry = process.env.PROJEKT_MANGA_SCHEMAS_ENTRY;
if (process.env.REQUIRE_SHARED_SOURCE_SCHEMAS === "1" && !schemasEntry) {
  throw new Error(
    "PROJEKT_MANGA_SCHEMAS_ENTRY is required for shared source contract validation",
  );
}
const sharedSchemas = schemasEntry
  ? await import(pathToFileURL(schemasEntry).href)
  : null;
const fixtures = JSON.parse(
  await readFile(
    new URL("./fixtures/source-search-fixtures.json", import.meta.url),
    "utf8",
  ),
);

async function loadSource(sourceKey) {
  const bundle = await build({
    entryPoints: [path.join(SOURCE_ROOT, "src", sourceKey, "index.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node20",
  });
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`;
  return (await import(moduleUrl)).default;
}

function response(body, contentType) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: 200,
    headers: { "content-type": contentType },
  });
}

test("every source adapter maps an offline search fixture and publishes valid filter shapes", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const [sourceKey, fixture] of Object.entries(fixtures)) {
      const source = await loadSource(sourceKey);
      const calls = [];
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        calls.push(url);
        if (
          sourceKey.startsWith("mangadex") &&
          url.pathname.endsWith("/manga/tag")
        ) {
          return response(fixture.tags, "application/json");
        }
        if (sourceKey.startsWith("mangadex")) {
          assert.match(
            new Headers(init?.headers).get("User-Agent"),
            /^ProjektManga-Sources\//,
          );
          if (url.pathname.endsWith("/at-home/server/chapter-2")) {
            return response(fixture.pages, "application/json");
          }
          if (url.pathname.endsWith("/chapter"))
            return response(fixture.chapters, "application/json");
          if (url.pathname.endsWith("/manga/fixture-series")) {
            return response(fixture.details, "application/json");
          }
          return response(fixture.search, "application/json");
        }
        if (sourceKey === "leercapitulo") {
          return response(
            url.pathname.startsWith("/leer/")
              ? fixture.pagesHtml
              : /^\/manga\/[^/]+\/[^/]+\/$/.test(url.pathname)
                ? fixture.detailsHtml
                : fixture.html,
            "text/html",
          );
        }
        if (sourceKey === "hentaifox") {
          return response(
            url.pathname.startsWith("/gallery/")
              ? fixture.detailsHtml
              : fixture.html,
            "text/html",
          );
        }
        if (sourceKey === "nhentai") {
          return response(
            url.pathname.endsWith("/search") ? fixture.json : fixture.gallery,
            "application/json",
          );
        }
        if (sourceKey === "mangageko") {
          if (url.pathname.includes("/reader/"))
            return response(fixture.pagesHtml, "text/html");
          if (url.pathname.endsWith("/all-chapters/"))
            return response(fixture.chaptersHtml, "text/html");
          if (url.pathname.startsWith("/manga/"))
            return response(fixture.detailsHtml, "text/html");
          return response(fixture.json, "application/json");
        }
        if (sourceKey === "asurascans") {
          const body = url.pathname.includes("/chapter/")
            ? fixture.pagesHtml
            : url.pathname === "/comics/fixture-series"
              ? fixture.detailsHtml
              : fixture.html;
          return response(body, "text/html");
        }
        if (sourceKey === "kissmanga") {
          const body = url.pathname.includes("chapter-")
            ? fixture.pagesHtml
            : url.pathname.startsWith("/kissmanga/")
              ? fixture.detailsHtml
              : fixture.html;
          return response(body, "text/html");
        }
        if (sourceKey === "mangatx") {
          const body = url.pathname.includes("/chapter-")
            ? fixture.pagesHtml
            : url.pathname === "/manga/fixture-series/"
              ? fixture.detailsHtml
              : fixture.html;
          return response(body, "text/html");
        }
        if (sourceKey === "weebcentral") {
          let body = fixture.html;
          if (url.pathname.startsWith("/chapters/")) {
            assert.ok(
              url.pathname.endsWith("/images"),
              "reader must load the image fragment",
            );
            assert.equal(url.searchParams.get("is_prev"), "False");
            body = fixture.pagesHtml;
          } else if (url.pathname.endsWith("/full-chapter-list")) {
            body = fixture.detailsHtml
              .replace(/<\/?(?:section|div|ul|li)[^>]*>/g, "")
              .replaceAll(
                "<span>Chapter",
                '<span> \n<img src="/badge.svg"></span><span>Chapter',
              );
          } else if (url.pathname.startsWith("/series/")) {
            // The shell can omit chapters; the full list is a separate fragment.
            body = fixture.detailsHtml.replace(
              /<a[^>]+href="\/chapters\/[\s\S]*?<\/a>/g,
              "",
            );
          }
          return response(body, "text/html");
        }
        return response(fixture.html, "text/html");
      };

      const results = await source.searchManga(
        "fixture",
        { limit: 1, offset: 0 },
        {},
      );
      assert.equal(
        results.length,
        1,
        `${sourceKey} should parse its fixture card`,
      );
      assert.equal(results[0].source, sourceKey);
      assert.equal(results[0].slug, results[0].id);
      assert.equal(results[0].title, "Fixture Series");
      assert.match(results[0].thumbnail_url, /^https:\/\//);
      sharedSchemas?.sourceMangaListSchema.parse(results);

      const mangaId = sourceKey === "nhentai" ? "12345" : results[0].id;
      const details = await source.fetchMangaDetails(mangaId);
      assert.equal(
        details.title,
        "Fixture Series",
        `${sourceKey} detail title`,
      );
      assert.ok(
        details.chapters.length > 0,
        `${sourceKey} details should include chapters`,
      );
      sharedSchemas?.sourceMangaDetailsSchema.parse(details);

      const chapters = await source.fetchChapters(mangaId);
      assert.ok(chapters.length > 0, `${sourceKey} should parse chapter rows`);
      sharedSchemas?.sourceChapterListSchema.parse(chapters);
      if (sourceKey === "hentaifox") {
        assert.equal(chapters[0].id, `hentaifox:gallery:${mangaId}`);
        assert.notEqual(
          chapters[0].id,
          mangaId,
          "gallery chapters cannot collide with Nhentai numeric IDs",
        );
      }
      if (sourceKey === "leercapitulo") {
        assert.ok(
          chapters.every((chapter) => chapter.id.startsWith("leercapitulo:/")),
        );
      }
      if (sourceKey !== "nhentai" && sourceKey !== "hentaifox") {
        assert.deepEqual(
          chapters.slice(0, 2).map((chapter) => chapter.chapter_number),
          [2, 1],
          `${sourceKey} chapter order`,
        );
      }
      if (sourceKey.startsWith("mangadex-")) {
        const language = sourceKey.slice("mangadex-".length);
        const listingCall = calls.find((url) => url.pathname === "/manga");
        assert.equal(
          listingCall.searchParams.get("availableTranslatedLanguage[]"),
          language,
        );
        assert.equal(
          calls
            .find((url) => url.pathname === "/chapter")
            .searchParams.get("translatedLanguage[]"),
          language,
        );
        assert.ok(
          chapters.every(
            (chapter) =>
              chapter.id.startsWith(`${sourceKey}:`) &&
              chapter.language === language,
          ),
        );
        await assert.rejects(
          source.fetchChapterPages("mangadex-other:chapter-2"),
          /another source/,
        );
      }
      const chapter = chapters[0];
      const pages = await source.fetchChapterPages(chapter.id, details.slug, {
        limit: 2,
        offset: 0,
      });
      assert.equal(pages.items.length, 2, `${sourceKey} page count`);
      assert.deepEqual(
        pages.items.map((page) => page.index),
        [1, 2],
        `${sourceKey} page indexes`,
      );
      assert.ok(
        pages.items.every((page) => page.image_url.startsWith("https://")),
        `${sourceKey} page URLs`,
      );
      sharedSchemas?.sourceChapterPagesSchema.parse(pages);

      const filters = await source.getFilters();
      if (sourceKey === "weebcentral") {
        await source.fetchManga("latest", { limit: 1, offset: 20 });
        const nextPage = calls.at(-1);
        assert.equal(nextPage.searchParams.get("sort"), "Latest Updates");
        assert.equal(nextPage.searchParams.get("limit"), "20");
        assert.equal(nextPage.searchParams.get("offset"), "20");
        assert.equal(nextPage.searchParams.has("page"), false);
        await source.fetchManga("popular", { limit: 1, offset: 0 });
        assert.equal(calls.at(-1).searchParams.get("sort"), "Popularity");
      }
      assert.ok(
        Array.isArray(filters),
        `${sourceKey} filters should be an array`,
      );
      for (const filter of filters) {
        assert.equal(
          typeof filter.label,
          "string",
          `${sourceKey} filter label`,
        );
        assert.equal(
          typeof filter.value,
          "string",
          `${sourceKey} filter value`,
        );
        assert.ok(
          [
            "input",
            "select",
            "checkbox",
            "radio",
            "multi",
            "tri-state",
          ].includes(filter.type),
          `${sourceKey} filter type ${filter.type}`,
        );
        assert.ok(
          !filter.options ||
            filter.options.every(
              (option) =>
                typeof option.label === "string" &&
                typeof option.value === "string",
            ),
          `${sourceKey} filter options`,
        );
      }
      sharedSchemas?.sourceMangaFilterListSchema.parse(filters);
      assert.ok(
        calls.length >= 1,
        `${sourceKey} should use the intercepted fixture transport`,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("generated index lists the published sources and matches every committed bundle", async () => {
  const index = JSON.parse(
    await readFile(path.join(SOURCE_ROOT, "index.json"), "utf8"),
  );
  const config = JSON.parse(
    await readFile(path.join(SOURCE_ROOT, "repo.config.json"), "utf8"),
  );
  const sourceDirs = await readdir(path.join(SOURCE_ROOT, "src"), {
    withFileTypes: true,
  });
  const published = [];

  for (const dir of sourceDirs.filter(
    (entry) => entry.isDirectory() && entry.name !== "lib",
  )) {
    const manifest = JSON.parse(
      await readFile(
        path.join(SOURCE_ROOT, "src", dir.name, "manifest.json"),
        "utf8",
      ),
    );
    if (!manifest.draft) published.push([dir.name, manifest]);
  }

  assert.deepEqual(
    index.sources.map((source) => source.source_key).sort(),
    published.map(([sourceKey]) => sourceKey).sort(),
    "index should contain each published source exactly once and omit drafts",
  );
  assert.deepEqual(index.repository, config.repository);

  for (const [sourceKey, manifest] of published) {
    const entry = index.sources.find(
      (source) => source.source_key === sourceKey,
    );
    const bundle = await readFile(
      path.join(SOURCE_ROOT, "dist", `${sourceKey}.js`),
    );
    const digest = createHash("sha256").update(bundle).digest("hex");
    const versionCode = manifest.version
      .split(".")
      .reduce((value, part, index) => {
        return value + Number(part) * [1_000_000, 1_000, 1][index];
      }, 0);

    assert.equal(entry.name, manifest.name, `${sourceKey} name`);
    assert.equal(entry.version, manifest.version, `${sourceKey} version`);
    assert.equal(entry.version_code, versionCode, `${sourceKey} version code`);
    assert.equal(entry.base_url, manifest.base_url, `${sourceKey} base URL`);
    assert.deepEqual(
      entry.allowed_hosts,
      manifest.allowed_hosts,
      `${sourceKey} host allowlist`,
    );
    assert.equal(
      entry.content_rating,
      manifest.content_rating,
      `${sourceKey} rating`,
    );
    assert.equal(
      entry.isNSFW,
      manifest.content_rating === "nsfw",
      `${sourceKey} NSFW flag`,
    );
    assert.equal(entry.bundle.sha256, digest, `${sourceKey} bundle digest`);
    assert.equal(
      entry.bundle.size,
      bundle.byteLength,
      `${sourceKey} bundle size`,
    );
    assert.equal(
      entry.entry_url,
      `${config.raw_base_url}/dist/${sourceKey}.js`,
    );
  }
});
