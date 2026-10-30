import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolveSource } from "../scripts/source-layout.mjs";

/**
 * The second wave of English sources (2026-10-30), offline: each built bundle browses,
 * opens a title and reads a chapter from synthetic pages in its site's own shapes, and
 * never asks for a host outside its manifest's allowed_hosts. The live sites were
 * checked with `npm run smoke` when each source was added.
 */
const wave = JSON.parse(
  await readFile(new URL("./fixtures/english-wave-2.json", import.meta.url), "utf8"),
);

const html = (body) => new Response(body, { headers: { "content-type": "text/html" } });
const json = (body) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

/** Per engine: a fetch handler serving the site's pages, and how to browse it. */
function fixtures(port, manifest) {
  const origin = new URL(manifest.base_url).origin;
  switch (port.engine) {
    case "madara": {
      const d = port.directory;
      const chapters = [2, 1]
        .map(
          (n) =>
            `<li class="wp-manga-chapter"><a href="${origin}/${d}/fixture-1/chapter-${n}/">Chapter ${n}</a><span class="chapter-release-date"><i>January 1, 2026</i></span></li>`,
        )
        .join("");
      return {
        handler(url, init) {
          if (url.pathname.endsWith("/ajax/chapters/")) {
            assert.equal(init?.method, "POST");
            return html(`<ul>${chapters}</ul>`);
          }
          if (url.pathname === `/${d}/fixture-1/chapter-2/`)
            return html('<div class="reading-content"><img src="/one.webp"><img src="/two.webp"></div>');
          if (url.pathname === `/${d}/fixture-1/`)
            return html(
              `<div class="post-title"><h1>Fixture 1</h1></div><div class="summary_image"><img src="/cover.webp"></div><div class="description-summary">About it</div><div class="post-status"><div class="summary-content">Ongoing</div></div>${port.ajaxChapters ? "" : `<ul>${chapters}</ul>`}`,
            );
          const page = Number(url.pathname.match(/\/page\/(\d+)\//)?.[1] ?? 1);
          return html(
            page === 1
              ? [1, 2]
                  .map(
                    (n) =>
                      `<div class="page-item-detail"><img src="/c${n}.webp"><div class="post-title"><h3><a href="/${d}/fixture-${n}/">Fixture ${n}</a></h3></div></div>`,
                  )
                  .join("")
              : "",
          );
        },
        id: "fixture-1",
      };
    }
    case "themesia":
      return {
        handler(url) {
          if (url.pathname === "/fixture-1-chapter-2/")
            return html('<div id="readerarea"><img src="/one.webp"><img src="/two.webp"></div>');
          if (url.pathname === `${port.cataloguePath}fixture-1/`)
            return html(
              `<div class="bigcontent"><h1 class="entry-title">Fixture 1</h1><div class="thumb"><img src="/cover.webp"></div><div class="desc">About it</div><table class="infotable"><tr><td>Status</td><td>Ongoing</td></tr></table></div><div id="chapterlist"><ul>${[2, 1]
                .map(
                  (n) =>
                    `<li><a href="/fixture-1-chapter-${n}/"><span class="chapternum">Chapter ${n}</span></a><span class="chapterdate">January 1, 2026</span></li>`,
                )
                .join("")}</ul></div>`,
            );
          const page = Number(url.searchParams.get("page") ?? 1);
          return html(
            `<div class="listupd">${
              page === 1
                ? [1, 2]
                    .map(
                      (n) =>
                        `<div class="bs"><div class="bsx"><a href="${port.cataloguePath}fixture-${n}/" title="Fixture ${n}"><img src="/c${n}.webp"></a></div></div>`,
                    )
                    .join("")
                : ""
            }</div>`,
          );
        },
        id: `${port.cataloguePath}fixture-1/`,
      };
    case "mangapill":
      return {
        handler(url) {
          if (url.pathname === "/manga/1/fixture-one")
            return html(
              '<h1>Fixture One</h1><div class="container"><div><div><img data-src="/cover.jpg"></div><div><div></div><div><p>About it</p></div></div></div></div><a href="/search?genre=Action">Action</a><div id="chapters"><div><a href="/chapters/1-10002000/fixture-one-chapter-2">Chapter 2</a><a href="/chapters/1-10001000/fixture-one-chapter-1">Chapter 1</a></div></div>',
            );
          if (url.pathname.startsWith("/chapters/1-10002000/"))
            return html('<picture><img data-src="https://cdn.readdetectiveconan.com/1.jpeg"></picture><picture><img data-src="https://cdn.readdetectiveconan.com/2.jpeg"></picture>');
          return html(
            '<div class="grid"><div><a href="/manga/1/fixture-one"><img data-src="/c.jpg"></a><div class="line-clamp-2">Fixture One</div></div></div>',
          );
        },
        id: "1/fixture-one",
      };
    case "mangakatana":
      return {
        handler(url) {
          if (url.pathname === "/manga/fixture.1")
            return html(
              '<h1 class="heading">Fixture One</h1><div class="media"><div class="cover"><img src="/cover.jpg"></div></div><div class="summary"><p>About it</p></div><div class="value status">Ongoing</div><div class="genres"><a>Action</a></div><table>' +
                [2, 1]
                  .map(
                    (n) =>
                      `<tr><td><div class="chapter"><a href="/manga/fixture.1/c${n}">Chapter ${n}</a></div></td><td><div class="update_time">Jan-0${n}-2026</div></td></tr>`,
                  )
                  .join("") +
                "</table>",
            );
          if (url.pathname === "/manga/fixture.1/c2")
            return html(
              "<script>var thzq=['https://i1.mangakatana.com/1.jpg','https://i1.mangakatana.com/2.jpg',];$('#imgs').attr('data-src', thzq)</script>",
            );
          return html(
            '<div id="book_list"><div class="item"><div class="text"><h3><a href="/manga/fixture.1">Fixture One</a></h3></div><img src="/c.jpg"></div></div>',
          );
        },
        id: "fixture.1",
      };
    case "tcbscans":
      return {
        handler(url) {
          if (url.pathname === "/mangas/1/fixture-one")
            return html(
              '<div class="order-1"><img src="/cover.png"><h1>Fixture One</h1><p>About it</p></div><div class="grid"><a href="/chapters/12/fixture-one-chapter-2"><div class="font-bold">Fixture One Chapter 2</div></a><a href="/chapters/11/fixture-one-chapter-1"><div class="font-bold">Fixture One Chapter 1</div></a></div>',
            );
          if (url.pathname === "/chapters/12/fixture-one-chapter-2")
            return html('<picture><img src="https://cdn.onepiecechapters.com/1.png"></picture><picture><img src="https://cdn.onepiecechapters.com/2.png"></picture>');
          return html(
            '<div class="bg-card"><img src="/c.png"><a class="text-white" href="/mangas/1/fixture-one">Fixture One</a></div>',
          );
        },
        id: "1/fixture-one",
      };
    case "dynasty":
      return {
        handler(url) {
          if (url.pathname === "/chapters/added.json")
            return json({
              chapters: [
                { title: "Fixture One ch02", tags: [{ type: "Series", name: "Fixture One", permalink: "fixture_one" }] },
              ],
            });
          if (url.pathname === "/series/fixture_one.json")
            return json({
              name: "Fixture One",
              permalink: "fixture_one",
              cover: "/cover.jpg",
              description: "<p>About it</p>",
              tags: [{ type: "Status", name: "Ongoing", permalink: "ongoing" }],
              taggings: [
                { header: "Volume 1" },
                { title: "Chapter 1", permalink: "fixture_one_ch01", released_on: "2026-01-01", tags: [] },
                { title: "Chapter 2", permalink: "fixture_one_ch02", released_on: "2026-01-08", tags: [{ type: "Scanlator", name: "Group", permalink: "group" }] },
              ],
            });
          if (url.pathname === "/chapters/fixture_one_ch02.json")
            return json({ pages: [{ url: "/system/1.webp" }, { url: "/system/2.webp" }] });
          return json({});
        },
        id: "fixture_one",
      };
    case "demonicscans":
      return {
        handler(url) {
          if (url.pathname === "/manga/Fixture-One")
            return html(
              '<div id="manga-info-container"><h1 class="big-fat-titles">Fixture One</h1><div id="manga-page"><img src="/cover.webp"></div><div id="manga-info-rightColumn"><div><div class="white-font">About it</div></div></div><div id="manga-info-stats"><div><li>Status</li><li>Ongoing</li></div></div></div><div id="chapters-list"><a class="chplinks" href="/chaptered.php?manga=1&chapter=2">Chapter 2 <span>2026-01-02</span></a><a class="chplinks" href="/chaptered.php?manga=1&chapter=1">Chapter 1 <span>2026-01-01</span></a></div>',
            );
          if (url.pathname === "/chaptered.php")
            return html('<div><img class="imgholder" src="https://cdn.demoniclibs.com/1.jpg"></div><div><img class="imgholder" src="https://cdn.demoniclibs.com/2.jpg"></div>');
          return html(
            '<div id="advanced-content"><div class="advanced-element"><a href="/manga/Fixture-One"><img src="/c.webp"></a><h1>Fixture One</h1></div></div>',
          );
        },
        id: "Fixture-One",
      };
    case "mangabox":
      return {
        handler(url) {
          if (url.pathname === "/api/manga/fixture_one/chapters")
            return json({
              success: true,
              data: {
                chapters: [2, 1].map((n) => ({
                  chapter_name: `Chapter ${n}`,
                  chapter_slug: `chapter-${n}`,
                  chapter_num: n,
                  updated_at: "2026-01-01T00:00:00Z",
                })),
              },
            });
          if (url.pathname === "/manga/fixture_one/chapter-2")
            return html(
              '<script>var cdns = ["https:\\/\\/img-r1.2xstorage.com\\/"]; var chapterImages = ["a\\/1.webp","a\\/2.webp"];</script>',
            );
          if (url.pathname === "/manga/fixture_one")
            return html(
              '<div class="manga-info-top"><h1>Fixture One</h1><li>Status : Ongoing</li><li>Genres : <a>Action</a></li></div><div class="manga-info-pic"><img src="/cover.jpg"></div><div id="contentBox">Fixture One summary: About it</div>',
            );
          return html(
            '<div class="truyen-list"><div class="list-truyen-item-wrap"><img src="/c.jpg"><h3><a href="/manga/fixture_one">Fixture One</a></h3></div></div>',
          );
        },
        id: "fixture_one",
      };
    case "keyoapp":
      return {
        handler(url) {
          if (url.pathname === "/series/fixture-one/")
            return html(
              '<div class="grid"><h1>Fixture One</h1></div><div style="--photoURL:url(https://cdn.meowing.org/cover.webp)" class="photoURL"></div><div id="expand_content"><p>About it</p></div><div id="chapters"><a href="/chapter/fixture-one-chapter-2/"><span class="text-sm">Chapter 2</span><span class="text-xs">2 days ago</span></a><a href="/chapter/fixture-one-chapter-1/"><span class="text-sm">Chapter 1</span><span class="text-xs">Jan 1, 2026</span></a></div>',
            );
          if (url.pathname === "/chapter/fixture-one-chapter-2/")
            return html(
              '<script>let realUrl = `https://cdn.meowing.org/${x}`;</script><div id="pages"><img uid="one"><img uid="two"></div>',
            );
          return html(
            '<div class="grid"><div class="group latest-poster"><a href="/series/fixture-one/" title="Fixture One"></a><div style="background-image:url(https://cdn.meowing.org/c.webp)"></div></div></div>',
          );
        },
        category: "latest",
        id: "fixture-one",
      };
    case "iken": {
      const post = {
        id: 7,
        slug: "fixture-one",
        postTitle: "Fixture One",
        postContent: "About it",
        featuredImage: "https://storage.example/cover.webp",
        seriesType: "MANHWA",
        seriesStatus: "ONGOING",
        genres: [{ id: 1, name: "Action" }],
      };
      return {
        handler(url) {
          if (url.pathname === "/api/query") return json({ posts: [post], totalCount: 1 });
          if (url.pathname === "/api/post")
            return json({
              totalChapterCount: 3,
              post: {
                ...post,
                chapters: [
                  { id: 102, slug: "chapter-2", number: 2, createdAt: "2026-01-08T00:00:00Z" },
                  { id: 101, slug: "chapter-1", number: 1, createdAt: "2026-01-01T00:00:00Z" },
                ],
              },
            });
          // The post shows the latest chapters only; the chapters API has them all, and
          // a locked chapter is left out.
          if (url.pathname === "/api/chapters")
            return json({
              post: {
                chapters: [
                  { id: 103, slug: "chapter-3", number: 3, createdAt: "2026-01-15T00:00:00Z", isLocked: true },
                  { id: 102, slug: "chapter-2", number: 2, createdAt: "2026-01-08T00:00:00Z" },
                  { id: 101, slug: "chapter-1", number: 1, createdAt: "2026-01-01T00:00:00Z" },
                  { id: 100, slug: "chapter-0", number: 0.5, createdAt: "2025-12-25T00:00:00Z" },
                ],
              },
            });
          if (url.pathname === "/api/chapter")
            return json({
              chapter: {
                images: [
                  { url: "https://storage.example/2.webp", order: 2 },
                  { url: "https://storage.example/1.webp", order: 1 },
                ],
              },
            });
          return json({});
        },
        id: "fixture-one",
      };
    }
    default:
      throw new Error(`No fixtures for ${port.engine}`);
  }
}

const allowed = (hosts, host) => hosts.some((entry) => host === entry || host.endsWith(`.${entry}`));

for (const port of wave) {
  test(`${port.key} (${port.engine}): browse, details, chapters and reader offline`, async () => {
    const { manifest } = await resolveSource(port.key);
    const source = (await import(new URL(`../dist/${port.key}.js`, import.meta.url))).default;
    const fixture = fixtures(port, manifest);
    const original = globalThis.fetch;
    const hosts = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      hosts.push(url.hostname);
      return fixture.handler(url, init);
    };
    try {
      const rows = await source.fetchManga(fixture.category ?? "popular", { limit: 2, offset: 0 }, {});
      assert.ok(rows.length >= 1, "the catalogue lists titles");
      assert.ok(rows.every((row) => row.title && row.id && row.source === port.key));

      const details = await source.fetchMangaDetails(fixture.id);
      assert.ok(details.title.startsWith("Fixture"), "details carry the title");
      assert.ok(details.chapters.length >= 2, "details carry the chapters");
      const numbers = details.chapters.map((chapter) => chapter.chapter_number);
      assert.deepEqual(numbers, [...numbers].sort((a, b) => b - a), "newest chapter first");
      assert.ok(numbers.includes(2), `chapter numbers are read: ${numbers.join(", ")}`);

      const newest = details.chapters.find((chapter) => chapter.chapter_number === 2);
      const pages = await source.fetchChapterPages(newest.id, fixture.id);
      assert.ok(pages.total >= 2 && pages.items.length >= 2, "the reader has pages");
      assert.ok(pages.items.every((page) => /^https?:\/\//.test(page.image_url)));

      for (const host of hosts)
        assert.ok(allowed(manifest.allowed_hosts, host), `${host} is outside allowed_hosts`);
    } finally {
      globalThis.fetch = original;
    }
  });
}

test("wave 2 Iken sources skip locked chapters and read the full chapter list", async () => {
  const port = wave.find((entry) => entry.engine === "iken");
  const { manifest } = await resolveSource(port.key);
  const source = (await import(new URL(`../dist/${port.key}.js`, import.meta.url))).default;
  const fixture = fixtures(port, manifest);
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => fixture.handler(new URL(String(input)), init);
  try {
    const chapters = await source.fetchChapters("fixture-one");
    assert.deepEqual(
      chapters.map((chapter) => chapter.chapter_number),
      [2, 1, 0.5],
    );
  } finally {
    globalThis.fetch = original;
  }
});
