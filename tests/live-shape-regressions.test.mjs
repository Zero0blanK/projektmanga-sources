// Regressions for upstream shapes seen on the live sites (2026-10-14) that the original
// fixtures did not cover. Each test serves the live shape and checks the source copes.
import assert from "node:assert/strict";
import test from "node:test";

const load = async (key) =>
  (await import(new URL(`../dist/${key}.js`, import.meta.url))).default;

async function withFetch(handler, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(url);
    return handler(url, init);
  };
  try {
    await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const json = (body) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });

test("Madara ports keep decimal chapters and skip volume headings and '#' links", async () => {
  const source = await load("s2manga");
  const rows = `<div class="listing-chapters_wrap"><ul class="main version-chap volumns">
    <li class="parent has-child"><a href="javascript:void(0)" class="has-child">Volume 9</a>
      <ul class="sub-chap list-chap">
        <li class="wp-manga-chapter"><a href="https://s2read.com/manga/fixture-1/chapter-64.20/">Chapter 64.20</a></li>
        <li class="wp-manga-chapter"><a href="https://s2read.com/manga/fixture-1/volume-9/ch-64/">Chapter 64</a></li>
        <li class="wp-manga-chapter"><a href="#">Chapter 65 (locked)</a></li>
      </ul>
    </li></ul></div>`;
  await withFetch(
    (url) => {
      assert.equal(url.origin, "https://s2read.com");
      if (url.pathname === "/manga/fixture-1/")
        return new Response(
          `<div class="post-title"><h1>Fixture 1</h1></div><div class="summary_image"><img src="/cover.webp"></div>${rows}`,
        );
      if (url.pathname === "/manga/fixture-1/chapter-64.20/")
        return new Response(
          '<div class="reading-content"><img src="https://s2read.com/one.webp"></div>',
        );
      throw new Error(`Unexpected route ${url.pathname}`);
    },
    async () => {
      const detail = await source.fetchMangaDetails("fixture-1");
      assert.deepEqual(
        detail.chapters.map((chapter) => chapter.id),
        [
          "s2manga:/manga/fixture-1/chapter-64.20/",
          "s2manga:/manga/fixture-1/volume-9/ch-64/",
        ],
      );
      const pages = await source.fetchChapterPages(
        detail.chapters[0].id,
        "fixture-1",
      );
      assert.equal(pages.items[0].image_url, "https://s2read.com/one.webp");
    },
  );
});

test("MangaThemesia finds ts_reader in any base64 data-URI script, not only the first", async () => {
  const source = await load("scythescans");
  const script = (body) =>
    `<script src="data:text/javascript;base64,${Buffer.from(body).toString("base64")}" defer></script>`;
  const reader = {
    sources: [
      {
        images: [
          "https://scythescans.com/wp-content/uploads/01.webp",
          "https://scythescans.com/wp-content/uploads/02.webp",
        ],
      },
    ],
  };
  await withFetch(
    (url) => {
      assert.equal(url.pathname, "/fixture-chapter-1/");
      return new Response(
        `${script('var ajaxurl = "https://scythescans.com/wp-admin/admin-ajax.php";')}
         <div id="readerarea"></div>
         ${script(`ts_reader.run(${JSON.stringify(reader)});`)}`,
      );
    },
    async () => {
      const pages = await source.fetchChapterPages(
        "scythescans:/fixture-chapter-1/",
      );
      assert.deepEqual(
        pages.items.map((page) => page.image_url),
        reader.sources[0].images,
      );
    },
  );
});

test("Flame Comics accepts string chapter numbers and skips malformed rows", async () => {
  const source = await load("flamecomics");
  const series = {
    series_id: 165,
    title: "Fixture",
    description: "<p>Text</p>",
    cover: "thumbnail.webp",
    type: "Manhwa",
    status: "Ongoing",
    last_edit: 1786358505,
  };
  await withFetch(
    (url) => {
      if (url.pathname === "/")
        return new Response(
          '<script id="__NEXT_DATA__">{"buildId":"live"}</script>',
        );
      if (url.pathname.endsWith("/series/165.json"))
        return json({
          pageProps: {
            series,
            chapters: [
              { chapter: "18.00", title: "Night", release_date: 1790440047, series_id: 165, token: "57fedf883166a727" },
              { chapter: 17, release_date: 1790000000, series_id: 165, token: "abc" },
              { chapter: "not a number", release_date: 1, series_id: 165, token: "bad" },
            ],
          },
        });
      if (url.pathname.endsWith("/browse.json"))
        return json({ pageProps: { series: [series, { title: "broken row" }] } });
      throw new Error(`Unexpected route ${url.pathname}`);
    },
    async () => {
      const detail = await source.fetchMangaDetails("165");
      assert.deepEqual(
        detail.chapters.map((chapter) => chapter.chapter_number),
        [18, 17],
      );
      const browse = await source.searchManga("fixture");
      assert.deepEqual(browse.map((row) => row.id), ["165"]);
      assert.deepEqual(await source.searchManga("!!!"), []);
    },
  );
});

test("GigaViewer accepts subdomain cover hosts, drops foreign covers and reads ids from scaled covers", async () => {
  const source = await load("shonenjumpplus");
  const node = (id, thumbnailUri) => ({
    databaseId: id,
    title: `Series ${id}`,
    thumbnailUri,
  });
  const nested = encodeURIComponent(
    "https://cdn-ak-img.shonenjumpplus.com/public/series-thumbnail/17107094915405001773-a4f5?1791345775",
  );
  await withFetch(
    (url) => {
      if (url.pathname === "/graphql")
        return json({
          data: {
            searchSeries: {
              edges: [
                { node: node("1", "https://cdn-ak-img.shonenjumpplus.com/public/series-thumbnail/1-x") },
                { node: node("2", "https://evil.example/cover.png") },
              ],
            },
          },
        });
      if (url.pathname === "/series")
        return new Response(
          `<ul class="series-list"><li><a href="https://shonenjumpplus.com/episode/9253191257065256754">
            <div class="series-list-thumb"><img data-src="https://cdn-scissors.gigaviewer.com/image/scale/abc/width=216/${nested}"></div>
            <h2 class="series-list-title">Fixture</h2></a></li></ul>`,
        );
      throw new Error(`Unexpected route ${url.pathname}`);
    },
    async (calls) => {
      const found = await source.searchManga("fixture");
      assert.equal(found.length, 2);
      assert.match(found[0].thumbnail_url, /^https:\/\/cdn-ak-img\.shonenjumpplus\.com\//);
      assert.equal(found[1].thumbnail_url, "");
      const catalogue = await source.fetchManga("popular");
      assert.deepEqual(catalogue.map((row) => row.id), ["17107094915405001773"]);
      assert.ok(
        !calls.some((url) => url.pathname.startsWith("/episode/")),
        "the series id must come from the cover, not an extra episode request",
      );
    },
  );
});
