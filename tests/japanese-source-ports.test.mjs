import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolveSource } from "../scripts/source-layout.mjs";
const keys = JSON.parse(
  await readFile(
    new URL("./fixtures/japanese-source-keys.json", import.meta.url),
    "utf8",
  ),
);
const schemas = process.env.PROJEKT_MANGA_SCHEMAS_ENTRY
  ? await import(pathToFileURL(process.env.PROJEKT_MANGA_SCHEMAS_ENTRY).href)
  : null;
for (const key of keys) {
  test(`${key}: Japanese catalogue, search, collection filter, free chapters and reader restrictions`, async () => {
    const original = globalThis.fetch;
    const { manifest } = await resolveSource(key);
    const base = manifest.base_url;
    const source = (await import(new URL(`../dist/${key}.js`, import.meta.url)))
      .default;
    const series = (id) => ({
      databaseId: String(id),
      title: `作品${id}`,
      thumbnailUri: `${base}/cover.webp`,
      firstEpisode: { permalink: `${base}/episode/101` },
      likeCount: 35 - id,
      latestEpisode: { publishedAt: "2026-01-01" },
    });
    const rows = Array.from({ length: 35 }, (_, i) => series(i + 1));
    const metadata = {
      ...series(1),
      author: { name: "著者" },
      description: "<p>説明</p>",
      episodes: { totalCount: 3 },
      volumes: { totalCount: 0 },
    };
    const calls = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      assert.equal(url.origin, base);
      if (url.pathname === "/graphql") {
        assert.equal(init.method, "POST");
        assert.equal(typeof init.body, "string");
        const { query, variables } = JSON.parse(init.body);
        let data;
        if (query.includes("searchSeries"))
          data = { searchSeries: { edges: rows.map((node) => ({ node })) } };
        else if (query.includes("series(databaseId:"))
          data = { series: metadata };
        else
          data = Object.fromEntries(
            Object.keys(variables).map((v) => [
              v,
              { series: { edges: rows.map((node) => ({ node })) } },
            ]),
          );
        return Response.json({ data });
      }
      if (url.pathname.startsWith("/series"))
        return new Response(
          `<ul class="series-list">${rows.map((row) => `<li><a href="/episode/${100 + Number(row.databaseId)}"><div class="series-list-thumb"><img data-src="${base}/series-fixture/${row.databaseId}-cover.webp"></div><h2 class="series-list-title">${row.title}</h2></a></li>`).join("")}</ul>`,
        );
      if (url.pathname.startsWith("/api/viewer/"))
        return Response.json(
          [1, 2, 3].map((n) => ({
            readable_product_id: String(100 + n),
            title: `第${n}話`,
            viewer_uri: `${base}/episode/${100 + n}`,
            purchase_info: { can_read: n !== 2, unavailable: n === 3 },
            display_open_at: "2026-01-01",
          })),
        );
      const structure = {
        ...(url.pathname.endsWith("/102") ? { choJuGiga: "baku" } : {}),
        pages: [
          { type: "main", src: `${base}/one.webp` },
          { type: "main", src: `${base}/two.webp` },
        ],
      };
      return new Response(
        `<script class="js-valve" data-giga_series="1"></script><script id="episode-json" data-value="${JSON.stringify({ readableProduct: { pageStructure: structure } }).replaceAll('"', "&quot;")}"></script>`,
      );
    };
    try {
      const first = await source.fetchMangaPage("popular", { limit: 20 });
      schemas?.sourceCataloguePageSchema.parse(first);
      assert.equal(first.items.length, 20);
      assert.equal(first.hasMore, true);
      const second = await source.fetchMangaPage("popular", {
        cursor: first.nextCursor,
        limit: 20,
      });
      const third = second.hasMore
        ? await source.fetchMangaPage("popular", {
            cursor: second.nextCursor,
            limit: 20,
          })
        : { items: [], hasMore: false };
      assert.equal(
        first.items.length + second.items.length + third.items.length,
        35,
      );
      assert.equal(third.hasMore, false);
      const searched = await source.searchMangaPage("作品", { limit: 10 });
      assert.equal(searched.items.length, 10);
      await assert.rejects(
        source.searchMangaPage("他", { cursor: searched.nextCursor }),
        /cursor/,
      );
      const filters = await source.getFilters();
      assert.ok(filters[0].options.length > 0);
      await assert.rejects(
        source.fetchMangaPage("popular", {}, { collection: "9999" }),
        /filter/,
      );
      const detail = await source.fetchMangaDetails("1");
      schemas?.sourceMangaDetailsSchema.parse(detail);
      assert.equal(
        detail.chapters.length,
        1,
        "locked and unavailable products omitted",
      );
      assert.equal(detail.chapters[0].id, `${key}:episode/101`);
      assert.equal(detail.author[0], "著者");
      const pages = await source.fetchChapterPages(detail.chapters[0].id, "1", {
        limit: 1,
        offset: 1,
      });
      schemas?.sourceChapterPagesSchema.parse(pages);
      assert.equal(pages.items[0].index, 2);
      assert.equal(pages.total, 2);
      await assert.rejects(
        source.fetchChapterPages(`${key}:episode/102`),
        /scrambled/,
      );
      await assert.rejects(
        source.fetchChapterPages("another:episode/101"),
        /identifier/,
      );
      await assert.rejects(source.fetchMangaDetails("../wrong"), /identifier/);
      assert.equal(
        await source.resolveMangaUrl("https://attacker.invalid/episode/101"),
        null,
      );
      assert.equal(
        (await source.resolveMangaUrl(`${base}/episode/101`)).id,
        "1",
      );
      assert.equal((await source.getCapabilities()).languageFilter, false);
    } finally {
      globalThis.fetch = original;
    }
  });
}
