import {
  resolveSource,
  discoverSourceDirectories,
} from "../scripts/source-layout.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";

test("MangaDex language editions forward browse/search offsets and retain their language constraint", async () => {
  const fixture = JSON.parse(
    await readFile("tests/fixtures/source-search-fixtures.json", "utf8"),
  ).mangadex.search.data[0];
  const original = globalThis.fetch;
  try {
    for (const [key, language] of [
      ["mangadex-es", "es"],
      ["mangadex-ja", "ja"],
      ["mangadex-fr", "fr"],
      ["mangadex-id", "id"],
      ["mangadex-pt-br", "pt-br"],
      ["mangadex-ru", "ru"],
    ]) {
      const source = await adapter(key);
      globalThis.fetch = async (input) => {
        const url = new URL(input);
        assert.equal(
          url.searchParams.get("availableTranslatedLanguage[]"),
          language,
        );
        const offset = Number(url.searchParams.get("offset")),
          limit = Number(url.searchParams.get("limit"));
        return Response.json({
          data: Array.from(
            { length: Math.max(0, Math.min(limit, 27 - offset)) },
            (_, i) => ({ ...fixture, id: `title-${offset + i}` }),
          ),
        });
      };
      for (const method of ["fetchManga", "searchManga"]) {
        const first = await source[method]("fixture", { limit: 20, offset: 0 });
        const next = await source[method]("fixture", { limit: 20, offset: 20 });
        assert.deepEqual(
          [...first, ...next].map((x) => x.id),
          Array.from({ length: 27 }, (_, i) => `title-${i}`),
        );
        assert.equal(
          (await source[method]("fixture", { limit: 20, offset: 27 })).length,
          0,
        );
      }
    }
  } finally {
    globalThis.fetch = original;
  }
});

for (const key of ["imhentai", "sushiscan", "komiku"]) {
  test(`${key} draft advances numbered browse/search pages, skips overlaps and stops repeats`, async () => {
    const source = await adapter(key),
      original = globalThis.fetch;
    const card = (n) =>
      key === "imhentai"
        ? `<div class="thumb"><div class="inner_thumb"><a href="/gallery/${n}/"><img src="https://m1.imhentai.xxx/cover.jpg"></a></div><div class="caption">Title ${n}</div></div>`
        : key === "sushiscan"
          ? `<div class="bs"><div class="bsx"><a href="/manga/title-${n}/" title="Title ${n}"><img src="/cover.jpg"></a></div></div>`
          : `<div class="bge"><a href="https://komiku.org/manga/title-${n}/"><h3>Title ${n}</h3></a></div>`;
    const id = (n) =>
      key === "imhentai"
        ? String(n)
        : key === "sushiscan"
          ? `/manga/title-${n}/`
          : `title-${n}`;
    try {
      globalThis.fetch = async (input) => {
        const url = new URL(input);
        const page = Number(
          url.searchParams.get("page") ||
            url.pathname.match(/\/page\/(\d+)/)?.[1] ||
            1,
        );
        const rows = page === 1 ? [1, 2, 3] : [3, 4, 5];
        return new Response(
          `${key === "sushiscan" ? '<div class="listupd">' : ""}${rows.map(card).join("")}${key === "sushiscan" ? "</div>" : ""}`,
        );
      };
      for (const method of ["fetchManga", "searchManga"]) {
        const query = method === "fetchManga" ? "latest" : "fixture";
        assert.deepEqual(
          (await source[method](query, { limit: 2, offset: 2 })).map(
            (x) => x.id,
          ),
          [id(3), id(4)],
        );
        assert.deepEqual(
          (await source[method](query, { limit: 3, offset: 4 })).map(
            (x) => x.id,
          ),
          [id(5)],
        );
        assert.equal(
          (await source[method](query, { limit: 2, offset: 5 })).length,
          0,
        );
      }
    } finally {
      globalThis.fetch = original;
    }
  });
}

async function adapter(key) {
  const bundle = await build({
    entryPoints: [(await resolveSource(key)).entryPoint],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
  });
  return (
    await import(
      `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`
    )
  ).default;
}

test("HentaiFox follows variable-size native next links for browse and search", async () => {
  const source = await adapter("hentaifox"),
    original = globalThis.fetch,
    requests = [];
  const cards = (start, count) =>
    Array.from(
      { length: count },
      (_, i) =>
        `<div class="thumb"><div class="g_title"><a href="/gallery/${start + i}/">Title ${start + i}</a></div><img src="/cover.jpg"></div>`,
    ).join("");
  try {
    globalThis.fetch = async (input) => {
      const url = new URL(input);
      requests.push(url);
      const search = url.pathname === "/search/";
      const page = search
        ? Number(url.searchParams.get("page"))
        : Number(url.pathname.match(/\d+/)?.[0] || 1);
      const start = search
        ? (page - 1) * 20
        : page === 1
          ? 0
          : 30 + (page - 2) * 20;
      const count = page === 3 ? 5 : !search && page === 1 ? 30 : 20;
      const next =
        page < 3
          ? `<div class="pagination"><a href="${search ? `/search/?q=fixture&amp;page=${page + 1}` : page === 1 ? "/page/2/" : "/pag/3/"}">Next</a></div>`
          : "";
      return new Response(cards(start, count) + next);
    };
    assert.deepEqual(
      (await source.fetchManga("latest", { limit: 30, offset: 0 })).map((x) =>
        Number(x.id),
      ),
      Array.from({ length: 30 }, (_, i) => i),
    );
    assert.deepEqual(
      (await source.fetchManga("latest", { limit: 30, offset: 30 })).map((x) =>
        Number(x.id),
      ),
      Array.from({ length: 25 }, (_, i) => 30 + i),
    );
    assert.equal(
      (await source.fetchManga("latest", { limit: 30, offset: 55 })).length,
      0,
    );
    assert.deepEqual(
      (await source.searchManga("fixture", { limit: 25, offset: 18 })).map(
        (x) => Number(x.id),
      ),
      Array.from({ length: 25 }, (_, i) => 18 + i),
    );
    assert.ok(requests.some((url) => url.pathname === "/pag/3/"));
    assert.ok(!requests.some((url) => url.pathname === "/page/3/"));
  } finally {
    globalThis.fetch = original;
  }
});

for (const key of ["weebcentral", "asurascans", "leercapitulo"]) {
  test(`${key} preserves windows across native pages and returns a short final page`, async () => {
    const source = await adapter(key),
      original = globalThis.fetch,
      requests = [];
    const size = key === "weebcentral" ? 32 : key === "asurascans" ? 20 : 30;
    const id = (n) =>
      key === "weebcentral"
        ? String(n).padStart(26, "0")
        : key === "leercapitulo"
          ? `fixture/title-${n}`
          : `title-${n}`;
    const card = (n) =>
      key === "weebcentral"
        ? `<a href="/series/${id(n)}/title"><img alt="Title ${n}" src="/cover.jpg"></a><a href="/series/${id(n)}/title">Title ${n}</a>`
        : key === "asurascans"
          ? `<a href="/comics/${id(n)}"><img alt="Title ${n}" src="/cover.jpg"></a>`
          : `<div class="lc-card"><a class="lc-card-name" href="/manga/${id(n)}/">Title ${n}</a></div>`;
    try {
      globalThis.fetch = async (input) => {
        const url = new URL(input);
        requests.push(url);
        if (key === "weebcentral")
          assert.equal(url.searchParams.get("limit"), "32");
        const start =
          key === "weebcentral"
            ? Number(url.searchParams.get("offset"))
            : (Number(url.searchParams.get("page")) - 1) * size;
        return new Response(
          Array.from(
            { length: Math.max(0, Math.min(size, size + 7 - start)) },
            (_, i) => card(start + i),
          ).join(""),
        );
      };
      for (const method of ["fetchManga", "searchManga"]) {
        const first = await source[method](
          method === "fetchManga" ? "latest" : "fixture",
          { limit: 25, offset: 0 },
        );
        const next = await source[method](
          method === "fetchManga" ? "latest" : "fixture",
          { limit: 25, offset: 25 },
        );
        assert.deepEqual(
          [...first, ...next].map((x) => x.id),
          Array.from({ length: size + 7 }, (_, i) => id(i)),
        );
        const boundary = await source[method](
          method === "fetchManga" ? "latest" : "fixture",
          { limit: 10, offset: size - 2 },
        );
        assert.deepEqual(
          boundary.map((x) => x.id),
          Array.from({ length: 9 }, (_, i) => id(size - 2 + i)),
        );
        assert.equal(
          (await source[method]("fixture", { limit: 25, offset: size + 7 }))
            .length,
          0,
        );
      }
      assert.ok(requests.length > 2);
    } finally {
      globalThis.fetch = original;
    }
  });
}

test("Madara sites with a Load more button page through /page/N/ until it 404s", async () => {
  const source = await adapter("manhuaus"),
    original = globalThis.fetch,
    requests = [];
  try {
    globalThis.fetch = async (input) => {
      const url = new URL(input);
      requests.push(url);
      const page = Number(url.pathname.match(/\/page\/(\d+)\/$/)?.[1]);
      if (page > 2) return new Response("Not found", { status: 404 });
      const cards = Array.from(
        { length: 12 },
        (_, i) =>
          `<div class="page-item-detail"><div class="post-title"><a href="https://manhuaus.com/manga/title-${(page - 1) * 12 + i}/">Title ${(page - 1) * 12 + i}</a></div><img data-src="/cover.jpg"></div>`,
      ).join("");
      return new Response(
        `<html><body>${cards}<nav class="navigation-ajax"><a href="javascript:void(0)" id="navigation-ajax" class="btn btn-default load-ajax">Load more</a></nav></body></html>`,
      );
    };
    const first = await source.fetchMangaPage("popular", { limit: 24 });
    assert.equal(first.items.length, 12);
    assert.equal(first.hasMore, true);
    const second = await source.fetchMangaPage("popular", {
      limit: 24,
      cursor: first.nextCursor,
    });
    assert.deepEqual(
      second.items.map((item) => item.id),
      Array.from({ length: 12 }, (_, i) => `title-${12 + i}`),
    );
    assert.equal(second.hasMore, true);
    const end = await source.fetchMangaPage("popular", {
      limit: 24,
      cursor: second.nextCursor,
    });
    assert.deepEqual(end, { items: [], hasMore: false });
    assert.ok(
      requests.every((url) => url.searchParams.get("m_orderby") === "views"),
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("nhentai pages the app's limit+1 window over 25-result search pages without repeats or gaps", async () => {
  const source = await adapter("nhentai"),
    original = globalThis.fetch,
    TOTAL = 70;
  try {
    globalThis.fetch = async (input) => {
      const page = Number(new URL(input).searchParams.get("page"));
      const start = (page - 1) * 25;
      return Response.json({
        result: Array.from(
          { length: Math.max(0, Math.min(25, TOTAL - start)) },
          (_, i) => ({
            id: start + i,
            english_title: `Title ${start + i}`,
            thumbnail: "t.jpg",
          }),
        ),
        num_pages: Math.ceil(TOTAL / 25),
        per_page: 25,
      });
    };
    for (const method of ["fetchManga", "searchManga"]) {
      // The sandbox asks for one more row than it shows, to learn whether more exist.
      const shown = [];
      for (let offset = 0; offset < TOTAL; offset += 20) {
        const rows = await source[method]("popular", { limit: 21, offset }, {});
        shown.push(...rows.slice(0, 20).map((row) => Number(row.id)));
        if (rows.length <= 20) break;
      }
      assert.deepEqual(
        shown,
        Array.from({ length: TOTAL }, (_, i) => i),
        `${method} shows every title once, in order`,
      );
    }
  } finally {
    globalThis.fetch = original;
  }
});
