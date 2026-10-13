import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import path from "node:path";
import { pathToFileURL } from "node:url";

const sharedSchemas = process.env.PROJEKT_MANGA_SCHEMAS_ENTRY
  ? await import(pathToFileURL(process.env.PROJEKT_MANGA_SCHEMAS_ENTRY).href)
  : null;

async function loadSource(key) {
  const bundle = await build({
    entryPoints: [path.resolve(`src/${key}/index.ts`)],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node25",
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`
  );
}

// Synthetic fixtures exercise contracts from the cited source implementations,
// rather than claiming to be live HTML from challenge-blocked hosts.
test("Sushi-Scan draft preserves French metadata, decimal releases and ordered reader variants", async () => {
  const module = await loadSource("sushiscan"),
    source = module.default,
    originalFetch = globalThis.fetch,
    calls = [];
  const card = (id, title) =>
    `<div class="bs"><div class="bsx"><a href="/manga/${id}/" title="${title}"><img data-src="/cover.jpg"></a></div></div>`;
  const chapter = (id, number) =>
    `<li><a href="/${id}/"><span class="chapternum">Chapitre ${number}</span><span class="chapterdate">2 octobre 2026</span></a></li>`;
  const detail = `<div class="bigcontent"><h1 class="entry-title">Étoile du matin</h1><div class="thumb"><img data-src="/cover.jpg"></div><table class="infotable"><tr><td>Auteur</td><td>Fixture Author</td></tr><tr><td>Statut</td><td>Terminé</td></tr></table><div class="desc">Description française</div><div class="mgen"><a>Aventure</a></div></div><div id="chapterlist"><ul>${chapter("fixture-7-5", "7.5")}${chapter("fixture-7-5", "7.5")}${chapter("fixture-8", "8")}${chapter("fixture-9", "9")}</ul></div>`;
  try {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      calls.push(url);
      let body;
      if (url.pathname === "/catalogue/" || url.pathname.startsWith("/page/")) {
        const page = Number(
          url.searchParams.get("page") || url.pathname.split("/")[2] || 1,
        );
        body = `<div class="listupd">${page === 1 ? card("one", "Étoile") + card("two", "Deux") : page === 2 ? card("two", "Deux") + card("three", "Trois") : ""}</div><ul class="genrez"><li><input type="checkbox" value="adventure"><label>Aventure</label></li></ul>`;
      } else if (url.pathname.startsWith("/manga/")) body = detail;
      else if (url.pathname === "/fixture-7-5/")
        body =
          '<div id="readerarea"><img data-src="/p1.jpg"><img data-lazy-src="//images.sushiscan.net/p2.webp"><img src="/p1.jpg"></div>';
      else if (url.pathname === "/fixture-8/")
        body = `<script src="data:text/javascript;base64,${Buffer.from('ts_reader.run({"sources":[{"images":["/p2.jpg","/p1.jpg"]}]});').toString("base64")}"></script>`;
      else if (url.pathname === "/fixture-9/")
        body = '<script>ts_reader.run({"images":[42]});</script>';
      else body = "";
      return new Response(body, { headers: { "content-type": "text/html" } });
    };
    assert.deepEqual(
      (await source.fetchManga("latest", { limit: 2, offset: 1 })).map(
        (row) => row.id,
      ),
      ["/manga/two/", "/manga/three/"],
    );
    const manga = await source.fetchMangaDetails("/manga/one/");
    sharedSchemas?.sourceMangaDetailsSchema.parse(manga);
    assert.equal(manga.title, "Étoile du matin");
    assert.equal(manga.status, "COMPLETED");
    assert.deepEqual(manga.author, ["Fixture Author"]);
    assert.equal(manga.chapters.length, 3);
    assert.equal(manga.chapters[0].chapter_number, 7.5);
    assert.equal(manga.chapters[0].release_date, "2026-10-02T00:00:00.000Z");
    const pages = await source.fetchChapterPages(
      manga.chapters[0].id,
      manga.id,
      { limit: 1, offset: 1 },
    );
    sharedSchemas?.sourceChapterPagesSchema.parse(pages);
    assert.equal(pages.total, 2);
    assert.equal(
      pages.items[0].image_url,
      "https://images.sushiscan.net/p2.webp",
    );
    assert.deepEqual(
      (await source.fetchChapterPages(manga.chapters[1].id)).items.map(
        (row) => row.image_url,
      ),
      ["https://sushiscan.net/p2.jpg", "https://sushiscan.net/p1.jpg"],
    );
    await assert.rejects(
      source.fetchChapterPages(manga.chapters[2].id),
      /metadata is malformed/,
    );
    await assert.rejects(
      source.fetchChapterPages("foreign:/fixture-8/"),
      /Invalid/,
    );
    await assert.rejects(
      source.fetchMangaDetails("https://foreign.example/title/"),
      /Invalid/,
    );
    assert.equal(module.parseFrenchDate("31 février 2026"), "");
    assert.equal(
      module.parseFrenchDate("2 août 2026"),
      "2026-08-02T00:00:00.000Z",
    );
    await source.searchManga(
      "étoile",
      { limit: 1 },
      { genre: ["adventure"], status: "ongoing" },
    );
    assert.ok(
      calls.some(
        (url) =>
          url.searchParams.get("s") === "étoile" &&
          url.searchParams.get("genre[]") === "adventure",
      ),
    );
    assert.ok(
      (await source.getFilters())
        .find((row) => row.value === "genre")
        .options.some((row) => row.value === "adventure"),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("IMHentai draft isolates gallery IDs, native language queries and verified ordered media", async () => {
  const source = (await loadSource("imhentai")).default,
    originalFetch = globalThis.fetch,
    calls = [];
  const metadata = (id) =>
    `<div class="gallery_first"><h1>Fixture Gallery</h1><div class="left_cover"><img src="https://m1.imhentai.xxx/a/b/cover.jpg"></div><ul><li><span class="tags_text">Artists:</span><a class="tag">Fixture Artist<span>99</span></a></li><li><span class="tags_text">Languages:</span><a class="tag">english</a></li><li><span class="tags_text">Tags:</span><a class="tag">fixture</a></li></ul></div><input id="gallery_id" value="${id}"><input id="load_pages" value="3"><input id="load_dir" value="a"><input id="load_id" value="b"><input id="load_server" value="1">`;
  try {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      calls.push(url);
      let body;
      if (url.pathname.startsWith("/gallery/")) {
        const id = url.pathname.split("/")[2];
        body =
          metadata(id) +
          (id === "43"
            ? "<script>$.parseJSON('broken')</script>"
            : '<script>$.parseJSON(\'{"1":"j,1100,1600","2":"w,1100,1600"}\')</script>');
      } else if (url.pathname.startsWith("/view/"))
        body = '<img id="gimg" src="https://m1.imhentai.xxx/a/b/3.png">';
      else if (url.searchParams.get("key") === "overload")
        body = "Overload... Please use the advanced search";
      else
        body =
          '<div class="thumb"><div class="inner_thumb"><a href="/gallery/42/"><img data-src="https://m1.imhentai.xxx/a/b/cover.jpg"></a></div><div class="caption">Fixture Gallery</div></div>';
      return new Response(body, { headers: { "content-type": "text/html" } });
    };
    const manga = await source.fetchMangaDetails("42");
    sharedSchemas?.sourceMangaDetailsSchema.parse(manga);
    assert.equal(manga.status, "COMPLETED");
    assert.deepEqual(manga.author, ["Fixture Artist"]);
    assert.equal(manga.chapters[0].id, "imhentai:gallery:42");
    assert.equal(manga.chapters[0].language, "en");
    const pages = await source.fetchChapterPages(manga.chapters[0].id, "42", {
      limit: 2,
      offset: 1,
    });
    sharedSchemas?.sourceChapterPagesSchema.parse(pages);
    assert.equal(pages.total, 3);
    assert.deepEqual(
      pages.items.map((row) => row.image_url),
      [
        "https://m1.imhentai.xxx/a/b/2.webp",
        "https://m1.imhentai.xxx/a/b/3.png",
      ],
    );
    assert.ok(calls.some((url) => url.pathname === "/view/42/3/"));
    assert.ok(!calls.some((url) => url.pathname === "/view/42/2/"));
    await source.searchManga("fixture", { limit: 1 }, { language: "ja" });
    assert.ok(
      calls.some(
        (url) =>
          url.searchParams.get("key") === "fixture" &&
          url.searchParams.get("jp") === "1" &&
          url.searchParams.get("en") === "0",
      ),
    );
    await source.fetchManga("popular", { limit: 1 }, { language: "fr" });
    assert.ok(
      calls.some((url) => url.pathname === "/language/french/popular/"),
    );
    await assert.rejects(
      source.searchManga("overload", { limit: 1 }),
      (error) => error.code === "RATE_LIMITED",
    );
    await assert.rejects(
      source.fetchChapterPages("imhentai:gallery:43"),
      /metadata is malformed/,
    );
    await assert.rejects(
      source.fetchChapterPages("hentaifox:gallery:42"),
      /Invalid/,
    );
    await assert.rejects(
      source.fetchManga("latest", { limit: 1 }, { language: "zz" }),
      /Unsupported/,
    );
    assert.equal((await source.getFilters())[0].options.length, 8);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
