import {
  resolveSource,
  discoverSourceDirectories,
} from "../scripts/source-layout.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import path from "node:path";

test("Komiku draft maps documented catalogue, chapters, dates and reader contracts offline", async () => {
  const bundle = await build({
    entryPoints: [(await resolveSource("komiku")).entryPoint],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node25",
  });
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`
  );
  const source = module.default,
    originalFetch = globalThis.fetch,
    calls = [];
  const card = (slug, title) =>
    `<div class="bge"><a href="https://komiku.org/manga/${slug}/"><h3>${title}</h3><img data-src="https://cdn.komiku.org/${slug}.jpg"></a></div>`;
  const detail = `<h1>Fixture One</h1><div class="ims"><img src="/cover.jpg"></div><table class="inftable"><tr><td>Pengarang</td><td>Fixture Author</td></tr><tr><td>Status</td><td>Tamat</td></tr></table><div id="Sinopsis"><p>Fixture description</p></div><ul class="genre"><li class="genre"><a><span>Adventure</span></a></li></ul><table id="Daftar_Chapter"><tr><td class="judulseries"><a href="/fixture-one-chapter-7-5/">Chapter 7.5</a></td><td class="tanggalseries">02/10/2026</td></tr><tr><td class="judulseries"><a href="/fixture-one-chapter-7-5/">Chapter 7.5</a></td></tr></table>`;
  try {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      calls.push(url);
      let body;
      if (url.hostname === "api.komiku.org")
        body = url.pathname.includes("page/2")
          ? card("fixture-three", "Fixture Three")
          : url.pathname.includes("page/3")
            ? ""
            : card("fixture-one", "Fixture One") +
              card("fixture-two", "Fixture Two");
      else if (url.pathname.startsWith("/manga/")) body = detail;
      else
        body =
          '<div id="Baca_Komik"><img data-src="/p1.jpg"><img src="//cdn.komiku.org/p2.webp"><img src="/p1.jpg"><img src="/komiku-promosi.jpg"></div>';
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    };
    const items = await source.fetchManga("latest", { limit: 2, offset: 1 });
    assert.deepEqual(
      items.map((item) => item.id),
      ["fixture-two", "fixture-three"],
    );
    const details = await source.fetchMangaDetails("fixture-one");
    assert.equal(details.status, "COMPLETED");
    assert.deepEqual(details.author, ["Fixture Author"]);
    assert.equal(details.chapters.length, 1);
    assert.equal(details.chapters[0].chapter_number, 7.5);
    assert.equal(details.chapters[0].release_date, "2026-10-01T17:00:00.000Z");
    const pages = await source.fetchChapterPages(
      details.chapters[0].id,
      "fixture-one",
      { limit: 1, offset: 1 },
    );
    assert.equal(pages.total, 2);
    assert.equal(pages.items[0].image_url, "https://cdn.komiku.org/p2.webp");
    await source.searchManga(
      "fixture",
      { limit: 1, offset: 0 },
      { tipe: "manhwa" },
    );
    assert.ok(
      calls.some(
        (url) =>
          url.searchParams.get("s") === "fixture" &&
          url.searchParams.get("tipe") === "manhwa",
      ),
    );
    assert.equal(
      module.parseKomikuDate("3 hari lalu", Date.parse("2026-10-12T00:00:00Z")),
      "2026-10-09T00:00:00.000Z",
    );
    assert.equal(module.parseKomikuDate("31/02/2026"), "");
    await assert.rejects(
      source.fetchChapterPages("foreign:chapter"),
      /Invalid Komiku/,
    );
    await assert.rejects(
      source.fetchMangaDetails("../escape"),
      /Invalid Komiku/,
    );
    assert.ok(
      (await source.getFilters()).some((filter) => filter.value === "genre"),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
