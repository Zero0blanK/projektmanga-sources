import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolveSource } from "../scripts/source-layout.mjs";
const ports = JSON.parse(
  await readFile(
    new URL("./fixtures/english-source-ports.json", import.meta.url),
    "utf8",
  ),
);
const schemas = process.env.PROJEKT_MANGA_SCHEMAS_ENTRY
  ? await import(pathToFileURL(process.env.PROJEKT_MANGA_SCHEMAS_ENTRY).href)
  : null;
for (const port of ports) {
  test(`${port.name}: captured catalogue, native pagination, search, filters, details and reader`, async () => {
    const original = globalThis.fetch;
    const source = (
      await import(new URL(`../dist/${port.key}.js`, import.meta.url))
    ).default;
    const { manifest } = await resolveSource(port.key);
    const recorded = await readFile(
      new URL(`./fixtures/english-ports/${port.key}.html`, import.meta.url),
      "utf8",
    );
    const calls = [];
    const directory = port.key === "mangadistrict" ? "series" : "manga";
    let synthetic = false;
    const card = (n) =>
      port.engine === "themesia"
        ? `<div class="bs"><div class="bsx"><a href="/${directory}/fixture-${n}/" title="Fixture ${n}"><img src="/cover.webp"><span class="tt">Fixture ${n}</span></a></div></div>`
        : `<div class="page-item-detail"><a href="/${directory}/fixture-${n}/"><img src="/cover.webp"></a><div class="post-title"><h3><a href="/${directory}/fixture-${n}/">Fixture ${n}</a></h3></div></div>`;
    const chapterRows = [2, 1]
      .map((n) =>
        port.engine === "themesia"
          ? `<li><a href="/manga/fixture-1/chapter-${n}/"><span class="chapternum">Chapter ${n}</span></a><span class="chapterdate">2026-01-01</span></li>`
          : `<li class="wp-manga-chapter"><a href="/${directory}/fixture-1/chapter-${n}/">Chapter ${n}</a><time datetime="2026-01-01"></time></li>`,
      )
      .join("");
    const details =
      port.engine === "themesia"
        ? `<div class="bigcontent"><h1 class="entry-title">Fixture 1</h1><div class="thumb"><img src="/cover.webp"></div><div class="desc">Description</div><table class="infotable"><tr><td>Author</td><td>Author</td></tr><tr><td>Status</td><td>Ongoing</td></tr></table></div><div id="chapterlist"><ul>${chapterRows}</ul></div>`
        : `<div class="post-title"><h1>Fixture 1</h1></div><div class="summary_image"><img src="/cover.webp"></div><div class="description-summary">Description</div><div class="post-status"><div class="summary-content">Ongoing</div></div>${port.ajaxChapters ? "" : `<ul>${chapterRows}</ul>`}`;
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      assert.equal(url.origin, port.base_url);
      if (url.pathname.endsWith("/ajax/chapters/")) {
        assert.equal(init.method, "POST");
        assert.equal(typeof init.body, "string");
        return new Response(`<ul>${chapterRows}</ul>`);
      }
      if (url.pathname.endsWith("/chapter-2/"))
        return new Response(
          '<div id="readerarea" class="reading-content read-container"><img src="/one.webp"><img src="/two.webp"></div>',
        );
      if (url.pathname === `/${directory}/fixture-1/`)
        return new Response(details);
      if (!synthetic) return new Response(recorded);
      const next = Number(
        url.searchParams.get("page") ||
          url.pathname.match(/\/page\/(\d+)\//)?.[1] ||
          1,
      );
      const body =
        next === 1 ? [1, 2].map(card).join("") : next === 2 ? card(3) : "";
      const nextUrl = new URL(url);
      nextUrl.searchParams.set("page", "2");
      return new Response(
        `<div class="listupd">${body}</div>${next === 1 ? `<a rel="next" href="${nextUrl.href.replaceAll("&", "&amp;")}">Next</a>` : ""}`,
      );
    };
    try {
      const captured = await source.fetchMangaPage("popular", { limit: 1 });
      assert.equal(
        captured.items.length,
        1,
        "current public catalogue excerpt must parse",
      );
      assert.notEqual(captured.items[0].title, "No Title");
      assert.equal(captured.items[0].source, port.key);
      schemas?.sourceCataloguePageSchema.parse(captured);
      const filters = await source.getFilters();
      assert.ok(filters.length > 0);
      for (const filter of filters)
        if (filter.options)
          assert.equal(
            new Set(filter.options.map((o) => o.value)).size,
            filter.options.length,
          );
      // Change context to avoid intentionally cached real catalogue markup.
      synthetic = true;
      const first = await source.searchMangaPage("fixture", { limit: 2 });
      assert.equal(first.items.length, 2);
      assert.equal(first.hasMore, true);
      const second = await source.searchMangaPage("fixture", {
        limit: 2,
        cursor: first.nextCursor,
      });
      assert.deepEqual(
        second.items.map((row) => row.title),
        ["Fixture 3"],
      );
      assert.equal(second.hasMore, false);
      schemas?.sourceCataloguePageSchema.parse(second);
      await assert.rejects(
        source.searchMangaPage("another", { cursor: first.nextCursor }),
        /cursor/,
      );
      const searchCall = calls.find(
        (c) =>
          c.url.searchParams.get(port.engine === "themesia" ? "title" : "s") ===
          "fixture",
      );
      assert.ok(searchCall, "native query parameter");
      const detail = await source.fetchMangaDetails(
        port.engine === "themesia" ? "/manga/fixture-1/" : "fixture-1",
      );
      schemas?.sourceMangaDetailsSchema.parse(detail);
      assert.equal(detail.title, "Fixture 1");
      assert.deepEqual(
        detail.chapters.map((c) => c.chapter_number),
        [2, 1],
      );
      assert.ok(detail.chapters.every((c) => c.id.startsWith(`${port.key}:`)));
      const pages = await source.fetchChapterPages(
        detail.chapters[0].id,
        detail.slug,
        { limit: 1, offset: 1 },
      );
      schemas?.sourceChapterPagesSchema.parse(pages);
      assert.equal(pages.items.length, 1);
      assert.equal(pages.items[0].index, 2);
      assert.ok(pages.items[0].image_url.endsWith("/two.webp"));
      await assert.rejects(
        source.fetchChapterPages("other:/manga/fixture-1/chapter-2/"),
        /identifier/,
      );
      const lastFilters = filters.find((f) => f.value === "genre");
      if (lastFilters?.options?.length)
        assert.ok(
          lastFilters.options.every(
            (o) => typeof o.label === "string" && typeof o.value === "string",
          ),
        );
      assert.ok(
        manifest.allowed_hosts.includes(new URL(port.base_url).hostname),
      );
    } finally {
      globalThis.fetch = original;
    }
  });
}
