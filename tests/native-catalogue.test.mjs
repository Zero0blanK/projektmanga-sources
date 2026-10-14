import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";

let instance = 0;
async function moduleAt(file) {
  const bundle = await build({
    entryPoints: [file],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}#${instance++}`
  );
}

test("native pager splits upstream pages, binds context, deduplicates and reports a full final page", async () => {
  const { createNativePager } = await moduleAt("src/lib/nativeCatalogue.ts");
  const row = (id) => ({
    id,
    source: "fixture",
    slug: id,
    title: id,
    thumbnail_url: "",
  });
  const calls = [];
  const context = {
    category: "latest",
    filters: { tags: Array.from({ length: 80 }, (_, i) => `tag-${i}`) },
  };
  const pager = createNativePager(
    "fixture",
    "1",
    (x) => /^\d+$/.test(x),
    async (page) => {
      calls.push(page);
      return page === "1"
        ? { items: [row("a"), row("a"), row("b"), row("c")], next: "500" }
        : { items: [row("d"), row("e")] };
    },
    context,
  );
  const first = await pager({ limit: 2 });
  assert.deepEqual(
    first.items.map((x) => x.id),
    ["a", "b"],
  );
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor.length < 1024);
  const remainder = await pager({ limit: 2, cursor: first.nextCursor });
  assert.deepEqual(
    remainder.items.map((x) => x.id),
    ["c"],
  );
  assert.equal(remainder.hasMore, true);
  const last = await pager({ limit: 2, cursor: remainder.nextCursor });
  assert.deepEqual(
    last.items.map((x) => x.id),
    ["d", "e"],
  );
  assert.equal(last.hasMore, false);
  assert.equal(last.nextCursor, undefined);
  assert.deepEqual(calls, ["1", "1", "500"]);
  const other = createNativePager(
    "fixture",
    "1",
    () => true,
    () => assert.fail("must not fetch"),
    { category: "popular", filters: {} },
  );
  await assert.rejects(
    other({ cursor: first.nextCursor }),
    /Invalid catalogue cursor/,
  );
  for (const request of [
    { cursor: "!" },
    { cursor: "a".repeat(1025) },
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
  ])
    await assert.rejects(pager(request), /Invalid catalogue cursor/);
});

test("native pager propagates failures and rejects repeated/invalid continuation", async () => {
  const { createNativePager } = await moduleAt("src/lib/nativeCatalogue.ts");
  for (const next of ["1", "https://evil.invalid"]) {
    const pager = createNativePager(
      "fixture",
      "1",
      (x) => /^\d+$/.test(x),
      async () => ({ items: [], next }),
      { filters: {} },
    );
    await assert.rejects(pager(), /Invalid catalogue cursor/);
  }
  const failure = new Error("upstream blocked");
  const pager = createNativePager(
    "fixture",
    "1",
    () => true,
    async () => {
      throw failure;
    },
    { filters: {} },
  );
  await assert.rejects(pager(), (error) => error === failure);
});

for (const key of [
  "hentaifox",
  "weebcentral",
  "leercapitulo",
  "asurascans",
  "imhentai",
  "komiku",
  "sushiscan",
  "akazascans",
]) {
  test(`${key} implements native browse/search continuation and explicit terminal metadata`, async () => {
    const source = (await moduleAt(`src/${key}/index.ts`)).default;
    const original = globalThis.fetch;
    const card = (n) =>
      key === "hentaifox"
        ? `<div class="thumb"><div class="g_title"><a href="/gallery/${n}/">Title ${n}</a></div></div>`
        : key === "weebcentral"
          ? `<a href="/series/${String(n).padStart(26, "0")}/title">Title ${n}</a>`
          : key === "leercapitulo"
            ? `<div class="lc-card"><a class="lc-card-name" href="/manga/fixture/title-${n}/">Title ${n}</a></div>`
            : key === "asurascans"
              ? `<a href="/comics/title-${n}">Title ${n}</a>`
              : key === "imhentai"
                ? `<div class="thumb"><div class="inner_thumb"><a href="/gallery/${n}/"></a></div><div class="caption">Title ${n}</div></div>`
                : key === "komiku"
                  ? `<div class="bge"><a href="https://komiku.org/manga/title-${n}/"><h3>Title ${n}</h3></a></div>`
                  : `<div class="listupd"><div class="bs"><div class="bsx"><a href="/manga/title-${n}/" title="Title ${n}"></a></div></div></div>`;
    const calls = [];
    try {
      globalThis.fetch = async (input) => {
        const url = new URL(input);
        calls.push(url);
        const page =
          Number(
            url.searchParams.get("offset") ||
              url.searchParams.get("page") ||
              url.pathname.match(/\/(?:pag|page)\/(\d+)/)?.[1] ||
              1,
          ) || 1;
        const next = new URL(url);
        if (key === "weebcentral") next.searchParams.set("offset", "32");
        else if (key === "hentaifox" && url.pathname !== "/search/")
          next.pathname = "/pag/500/";
        else if (key === "komiku") next.pathname = "/manga/page/500/";
        else if (
          (key === "sushiscan" || key === "akazascans") &&
          url.pathname.startsWith("/page/")
        )
          next.pathname = "/page/500/";
        else next.searchParams.set("page", "500");
        const continuation =
          page === 1
            ? key === "weebcentral" || key === "komiku"
              ? `<span hx-get="${(key === "weebcentral" ? next.pathname + next.search : next.href).replaceAll("&", "&amp;")}"></span>`
              : `<a rel="next" href="${next.href.replaceAll("&", "&amp;")}">Next</a>`
            : "";
        return new Response(
          (page === 1 ? [1, 2, 3] : [4, 5]).map(card).join("") + continuation,
        );
      };
      for (const method of ["fetchMangaPage", "searchMangaPage"]) {
        const query = method === "fetchMangaPage" ? "latest" : "fixture";
        const first = await source[method](query, { limit: 2 });
        assert.equal(first.items.length, 2);
        assert.equal(first.hasMore, true);
        const partial = await source[method](query, {
          limit: 2,
          cursor: first.nextCursor,
        });
        assert.equal(partial.items.length, 1);
        assert.equal(partial.hasMore, true);
        const last = await source[method](query, {
          limit: 2,
          cursor: partial.nextCursor,
        });
        assert.equal(last.items.length, 2);
        assert.equal(last.hasMore, false);
        assert.equal(last.nextCursor, undefined);
        assert.equal(
          new Set(
            [...first.items, ...partial.items, ...last.items].map((x) => x.id),
          ).size,
          5,
        );
        await assert.rejects(
          source[method]("different", { cursor: first.nextCursor }),
          (error) => error.reason === "INVALID_CURSOR",
        );
      }
      const capabilities = await source.getCapabilities();
      assert.equal(capabilities.nativePagination, true);
      assert.equal(capabilities.languageFilter, key === "imhentai");
      assert.ok(
        calls.some(
          (url) =>
            url.searchParams.get("offset") === "32" ||
            url.searchParams.get("page") === "500" ||
            url.pathname.includes("500"),
        ),
      );
    } finally {
      globalThis.fetch = original;
    }
  });
}

test("HTML source refuses foreign origins and query changes in native next links", async () => {
  for (const href of [
    "https://evil.invalid/pag/2/",
    "https://hentaifox.com/search/?q=other&page=2",
    "https://user:pass@hentaifox.com/pag/2/",
  ]) {
    const source = (await moduleAt("src/hentaifox/index.ts")).default;
    const original = globalThis.fetch;
    try {
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        return new Response(
          `<div class="thumb"><div class="g_title"><a href="/gallery/1/">Title</a></div></div><a rel="next" href="${href}">Next</a>`,
        );
      };
      await assert.rejects(
        source.fetchMangaPage(),
        /Invalid catalogue next page/,
      );
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = original;
    }
  }
});

test("MangaDex editions use native totals, compact context and direct deep offset cursors", async () => {
  const fixture = JSON.parse(
    await readFile("tests/fixtures/source-search-fixtures.json", "utf8"),
  ).mangadex.search.data[0];
  const original = globalThis.fetch;
  try {
    for (const [key, lang] of [
      ["mangadex", undefined],
      ["mangadex-es", "es"],
      ["mangadex-fr", "fr"],
      ["mangadex-pt-br", "pt-br"],
      ["mangadex-id", "id"],
      ["mangadex-ru", "ru"],
    ]) {
      const source = (await moduleAt(`src/${key}/index.ts`)).default;
      globalThis.fetch = async (input) => {
        const url = new URL(input);
        assert.equal(
          url.searchParams.get("availableTranslatedLanguage[]") || undefined,
          lang,
        );
        const offset = Number(url.searchParams.get("offset"));
        return Response.json({
          total: 103,
          data: Array.from({ length: Math.min(100, 103 - offset) }, (_, i) => ({
            ...fixture,
            id: `title-${offset + i}`,
          })),
        });
      };
      const first = await source.searchMangaPage("fixture", { limit: 100 });
      const last = await source.searchMangaPage("fixture", {
        limit: 100,
        cursor: first.nextCursor,
      });
      assert.equal(first.items.length, 100);
      assert.equal(last.items.length, 3);
      assert.equal(last.hasMore, false);
      assert.equal((await source.getCapabilities()).languageFilter, false);
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("Akaza Scans concrete shared theme port preserves details, chapter identities and ordered reader metadata", async () => {
  const source = (await moduleAt("src/akazascans/index.ts")).default,
    original = globalThis.fetch;
  try {
    globalThis.fetch = async (input) =>
      new Response(
        new URL(input).pathname === "/manga/fixture/"
          ? '<div class="bigcontent"><h1 class="entry-title">Fixture</h1><table class="infotable"><tr><td>Status</td><td>Completed</td></tr><tr><td>Author</td><td>Author</td></tr></table><div class="desc">Description</div></div><div id="chapterlist"><li><a href="/fixture-chapter-1/"><span class="chapternum">Chapter 1</span><span class="chapterdate">October 14, 2026</span></a></li></div>'
          : '<div id="readerarea"><img src="/p1.jpg"><img data-src="/p2.webp"><img src="/p1.jpg"></div>',
      );
    const detail = await source.fetchMangaDetails("/manga/fixture/");
    assert.equal(detail.title, "Fixture");
    assert.equal(detail.status, "COMPLETED");
    assert.deepEqual(detail.author, ["Author"]);
    assert.equal(detail.chapters[0].id, "akazascans:/fixture-chapter-1/");
    const pages = await source.fetchChapterPages(detail.chapters[0].id);
    assert.equal(pages.total, 2);
    assert.deepEqual(
      pages.items.map((x) => x.index),
      [1, 2],
    );
    globalThis.fetch = () => assert.fail("static filters must not fetch");
    assert.equal(
      (await source.getFilters()).find((x) => x.value === "genre").options
        .length,
      42,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("Komiku verifies a full terminal page without HTMX using bounded lookahead", async () => {
  for (const ending of ["empty", "repeat", "404"]) {
    const source = (await moduleAt("src/komiku/index.ts")).default;
    const original = globalThis.fetch;
    let calls = 0;
    const cards = Array.from(
      { length: 10 },
      (_, n) =>
        `<div class="bge"><a href="https://komiku.org/manga/title-${n}/"><h3>Title ${n}</h3></a></div>`,
    ).join("");
    try {
      globalThis.fetch = async (input) => {
        calls++;
        return new URL(input).pathname.includes("/page/")
          ? new Response(ending === "repeat" ? cards : "", {
              status: ending === "404" ? 404 : 200,
            })
          : new Response(cards);
      };
      const page = await source.fetchMangaPage("latest", { limit: 10 });
      assert.equal(page.items.length, 10);
      assert.equal(page.hasMore, false);
      assert.equal(calls, 2);
    } finally {
      globalThis.fetch = original;
    }
  }
});

test("multiple filters survive native links that omit repeated nonpagination values", async () => {
  const source = (await moduleAt("src/akazascans/index.ts")).default,
    original = globalThis.fetch;
  try {
    globalThis.fetch = async (input) => {
      const url = new URL(input);
      assert.deepEqual(url.searchParams.getAll("genre[]"), [
        "action",
        "adventure",
      ]);
      const page = url.searchParams.get("page");
      return new Response(
        `<div class="listupd"><div class="bs"><div class="bsx"><a href="/manga/title-${page}/" title="Title"></a></div></div></div>${page === "1" ? '<a rel="next" href="/manga/?page=2">Next</a>' : ""}`,
      );
    };
    const first = await source.fetchMangaPage("latest", undefined, {
      genre: ["action", "adventure"],
    });
    const last = await source.fetchMangaPage(
      "latest",
      { cursor: first.nextCursor },
      { genre: ["action", "adventure"] },
    );
    assert.equal(last.hasMore, false);
  } finally {
    globalThis.fetch = original;
  }
});
