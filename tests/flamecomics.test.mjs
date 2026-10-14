import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { resolveSource } from "../scripts/source-layout.mjs";
import { pathToFileURL } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
const schemas = process.env.PROJEKT_MANGA_SCHEMAS_ENTRY
  ? await import(pathToFileURL(process.env.PROJEKT_MANGA_SCHEMAS_ENTRY).href)
  : null;
const row = (id) => ({
  series_id: id,
  title: `Fixture ${id}`,
  altTitles: ["Other title"],
  description: "<p>Fixture description</p>",
  cover: "cover.webp",
  type: "Manhwa",
  tags: ["Action"],
  author: ["Author"],
  artist: ["Artist"],
  status: id === 2 ? "completed" : "ongoing",
  last_edit: 1700000000,
  views: 100 - id,
});
const detail = {
  series: row(1),
  chapters: [2, 1].map((chapter) => ({
    chapter,
    title: "Title",
    release_date: 1700000000,
    series_id: 1,
    token: `chapter-${chapter}`,
  })),
};
async function adapter() {
  const result = await build({
    entryPoints: [(await resolveSource("flamecomics")).entryPoint],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node25",
  });
  const filename = new URL(
    `../node_modules/.cache/flame-fixtures/adapter-${Date.now()}-${Math.random()}.mjs`,
    import.meta.url,
  );
  await mkdir(new URL(".", filename), { recursive: true });
  await writeFile(filename, result.outputFiles[0].contents);
  return (await import(filename.href)).default;
}

test("Flame Comics native/offset pagination, alternate-title search, filters, details and pages", async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    assert.equal(url.origin, "https://flamecomics.xyz");
    if (url.pathname === "/")
      return new Response(
        '<script id="__NEXT_DATA__">{"buildId":"fixture"}</script>',
      );
    let pageProps;
    if (url.pathname.endsWith("/browse.json"))
      pageProps = {
        series: [...Array.from({ length: 33 }, (_, i) => row(i + 1)), row(1)],
      };
    else if (url.pathname.endsWith("/index.json"))
      pageProps = { latestEntries: { blocks: [{ series: [row(2), row(1)] }] } };
    else if (url.pathname.endsWith("/chapter-2.json"))
      pageProps = {
        chapter: {
          series_id: 1,
          token: "chapter-2",
          release_date: 1700000000,
          images: { first: { name: "01.webp" }, second: { name: "02.webp" } },
        },
      };
    else if (url.pathname.endsWith("/series/1.json")) pageProps = detail;
    else throw new Error(`Unexpected fixture route: ${url.pathname}`);
    return Response.json({ pageProps });
  };
  try {
    const source = await adapter();
    assert.equal((await source.getCapabilities()).nativePagination, true);
    let nextCursor;
    const seen = [];
    do {
      const page = await source.fetchMangaPage("popular", {
        limit: 10,
        cursor: nextCursor,
      });
      schemas?.sourceCataloguePageSchema.parse(page);
      seen.push(...page.items.map((item) => item.id));
      nextCursor = page.nextCursor;
    } while (nextCursor);
    assert.equal(seen.length, 33);
    assert.equal(new Set(seen).size, 33);
    assert.equal(
      calls.filter((url) => url.pathname.endsWith("/browse.json")).length,
      1,
    );
    const first = await source.searchMangaPage("Other", { limit: 1 });
    await assert.rejects(
      source.searchMangaPage("changed", { cursor: first.nextCursor }),
      /cursor/,
    );
    const filtered = await source.searchManga(
      "Other",
      { offset: 0, limit: 10 },
      { status: "completed", type: "manhwa" },
    );
    assert.deepEqual(
      filtered.map((item) => item.id),
      ["2"],
    );
    const offset = await source.fetchManga("popular", {
      offset: 30,
      limit: 10,
    });
    assert.equal(offset.length, 3);
    assert.equal(
      (
        await source.fetchManga(
          "latest",
          { offset: 0, limit: 10 },
          { status: "completed" },
        )
      ).length,
      1,
    );
    const manga = await source.fetchMangaDetails("1");
    schemas?.sourceMangaDetailsSchema.parse(manga);
    assert.equal(manga.description, "Fixture description");
    assert.deepEqual(
      manga.chapters.map((ch) => ch.chapter_number),
      [2, 1],
    );
    schemas?.sourceChapterListSchema.parse(await source.fetchChapters("1"));
    const pages = await source.fetchChapterPages(
      "flamecomics:1/chapter-2",
      "1",
      { offset: 1, limit: 1 },
    );
    schemas?.sourceChapterPagesSchema.parse(pages);
    assert.equal(pages.total, 2);
    assert.equal(pages.items[0].index, 2);
    assert.equal(
      pages.items[0].image_url,
      "https://cdn.flamecomics.xyz/uploads/images/series/1/chapter-2/02.webp?1700000000",
    );
    await assert.rejects(
      source.fetchChapterPages("other:1/chapter-2"),
      /identifier/,
    );
    await assert.rejects(
      source.fetchChapterPages("flamecomics:1/chapter-2", "2"),
      /identifier/,
    );
    await assert.rejects(source.fetchMangaDetails("../evil"), /identifier/);
    assert.equal(
      await source.resolveMangaUrl("https://attacker.invalid/series/1"),
      null,
    );
    assert.equal(
      (await source.resolveMangaUrl("https://flamecomics.xyz/series/1")).id,
      "1",
    );
    assert.equal((await source.getFilters()).length, 3);
  } finally {
    globalThis.fetch = original;
  }
});

test("Flame Comics refreshes a stale deployment build once and rejects malformed responses", async () => {
  const original = globalThis.fetch;
  let homes = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/")
      return new Response(
        `<script id="__NEXT_DATA__">{"buildId":"build-${++homes}"}</script>`,
      );
    if (url.pathname.includes("/build-1/"))
      return new Response("Not found", { status: 404 });
    return Response.json({ pageProps: { series: [row(1)] } });
  };
  try {
    const source = await adapter();
    assert.equal((await source.searchManga("Fixture")).length, 1);
    assert.equal(homes, 2);
    await assert.rejects(source.fetchMangaDetails("1"), /unsupported response/);
  } finally {
    globalThis.fetch = original;
  }
});
