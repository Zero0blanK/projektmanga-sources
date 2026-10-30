import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolveSource } from "../scripts/source-layout.mjs";

/**
 * The third wave (2026-10-30): five English sources and ten Japanese raw sites, offline.
 * Each built bundle browses, opens a title and reads a chapter from synthetic pages in its
 * site's own shapes, and never asks for a host outside its manifest's allowed_hosts. The
 * live sites were checked with `npm run smoke` when each source was added (the three
 * Madara sites sit behind Cloudflare's browser check, so only these fixtures cover them).
 */
const wave = JSON.parse(
  await readFile(new URL("./fixtures/source-wave-3.json", import.meta.url), "utf8"),
);

const html = (body) => new Response(body, { headers: { "content-type": "text/html" } });
const json = (body) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

/** A Dean Edwards packed script whose payload needs no word substitution. */
const pack = (script) =>
  `<script>eval(function(p,a,c,k,e,d){return p}('${script.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}',62,0,''.split('|'),0,{}))</script>`;

/** Per engine: a fetch handler serving the site's pages, and the title to open. */
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
              '<div class="post-title"><h1>Fixture 1</h1></div><div class="summary_image"><img src="/cover.webp"></div><div class="description-summary">About it</div><div class="post-status"><div class="summary-content">Ongoing</div></div>',
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
    case "mangahere":
      return {
        handler(url) {
          if (url.pathname === "/manga/fixture_one/")
            return html(
              '<span class="detail-info-right-title-font">Fixture One</span><span class="detail-info-right-title-tip">Ongoing</span><img class="detail-info-cover-img" src="https://fmcdn.mangahere.com/cover.jpg"><p class="fullcontent">About it</p><ul class="detail-main-list">' +
                [2, 1]
                  .map(
                    (n) =>
                      `<li><a href="/manga/fixture_one/c00${n}/1.html"><p class="title3">Ch.00${n}</p><p class="title2">Jan 0${n},2026</p></a></li>`,
                  )
                  .join("") +
                "</ul>",
            );
          // The long-strip reader: the image list sits in a packed script whose short
          // tokens stand for the word list.
          if (url.pathname === "/manga/fixture_one/c002/1.html")
            return html(
              "<script>eval(function(p,a,c,k,e,d){}('0 1=[\\'2\\',\\'3\\'];',4,4,'var|newImgs|//zjcdn.mangahere.org/a.jpg|//zjcdn.mangahere.org/b.jpg'.split('|'),0,{}))</script>",
            );
          return html(
            url.pathname === "/directory/1.htm"
              ? '<ul class="manga-list-1-list"><li><a href="/manga/fixture_one/" title="Fixture One"><img class="manga-list-1-cover" src="https://fmcdn.mangahere.com/c.jpg"></a></li></ul>'
              : "",
          );
        },
        id: "fixture_one",
      };
    case "mangatown":
      return {
        handler(url) {
          if (url.pathname === "/manga/fixture_one/")
            return html(
              '<div class="article_content"><h1>Fixture One</h1><ul><li><b>Status(s):</b>Ongoing</li></ul></div><span id="show">About it</span><div class="detail_info"><img src="https://fmcdn.mangatown.com/cover.jpg"></div><ul class="chapter_list">' +
                [2, 1]
                  .map(
                    (n) =>
                      `<li><a href="/manga/fixture_one/c00${n}/">Fixture One ${n}</a><span class="time">Jan 0${n},2026</span></li>`,
                  )
                  .join("") +
                "</ul>",
            );
          // One reader page per image; the page list is a <select>.
          if (url.pathname === "/manga/fixture_one/c002/")
            return html(
              '<select id="top_chapter_list"></select><div class="page_select"><select><option value="/manga/fixture_one/c002/">1</option><option value="/manga/fixture_one/c002/2.html">2</option><option value="/featured.html">Featured</option></select></div><div id="viewer"><img src="https://zjcdn.mangatown.com/1.jpg"></div>',
            );
          if (url.pathname === "/manga/fixture_one/c002/2.html")
            return html('<div id="viewer"><img src="https://zjcdn.mangatown.com/2.jpg"></div>');
          return html(
            url.pathname.endsWith("/1.htm")
              ? '<ul><li><a class="manga_cover" href="/manga/fixture_one/"><img src="https://fmcdn.mangatown.com/c.jpg"></a><p class="title"><a href="/manga/fixture_one/" title="Fixture One">Fixture One</a></p></li></ul>'
              : "",
          );
        },
        id: "fixture_one",
      };
    case "mangarw":
      return {
        handler(url) {
          if (url.pathname === "/manga/fixture-one/7")
            return html(
              '<h1>Fixture One</h1><img src="https://mangarw.com/covers/x.jpg"><div class="description">About it</div><div class="flex flex-wrap gap-2"><a href="/genre/action">Action</a></div>',
            );
          // The title page names no chapters; the chapter API lists them as <option>s.
          if (url.pathname === "/api/v1/chapters") {
            assert.equal(url.searchParams.get("id"), "7");
            return html('<option value="102">第2話</option><option value="101">第1話</option>');
          }
          if (url.pathname === "/read") {
            assert.equal(url.searchParams.get("id"), "102");
            return html('<img src="https://cdn.mangabuzz.org/1.jpg"><img src="https://cdn.mangabuzz.org/2.jpg">');
          }
          return html(
            url.searchParams.get("page") === "1"
              ? '<a href="/manga/fixture-one/7" title="Fixture One"><img src="https://mangarw.com/covers/c.jpg"></a>'
              : "",
          );
        },
        id: "fixture-one/7",
      };
    case "miuraw":
      return {
        handler(url) {
          if (url.pathname === "/manga/fixture-one/")
            return html(
              '<h1 class="md-title">Fixture One (Raw – Free)</h1><div class="md-cover"><img src="https://miuraw.net/cover.jpg"></div><div class="md-desc-content">About it</div>' +
                [2, 1]
                  .map(
                    (n) =>
                      `<div class="md-chapter-row"><div class="md-chapter-name"><a href="/fixture-one-chapter-${n}/">第${n}話</a></div><span class="md-chapter-time">${n}日前</span></div>`,
                  )
                  .join(""),
            );
          if (url.pathname === "/fixture-one-chapter-2/")
            return html('<div class="reader-page"><img src="https://img.example/1.jpg"></div><div class="reader-page"><img src="https://img.example/2.jpg"></div>');
          return html(
            url.pathname === "/manga/page/1/"
              ? '<div class="manga-card"><a class="manga-card-thumb" href="https://miuraw.net/manga/fixture-one/"><img src="https://miuraw.net/c.jpg"></a><div class="manga-card-title">Fixture One (Raw – Free)</div></div>'
              : "",
          );
        },
        id: "fixture-one",
      };
    case "mangakuro":
      return {
        handler(url) {
          if (url.pathname === "/manga/fixture-one")
            return html(
              '<div class="detail_name"><h1>Fixture One</h1></div><div class="detail_avatar"><img src="https://mangakuro.net/cover.jpg"></div><div class="detail_reviewContent">About it</div><div class="chapter_box">' +
                [2, 1]
                  .map(
                    (n) =>
                      `<div class="item"><a class="chapter_num" href="/manga/fixture-one/chapter-${n}"># 第${n}話</a><p class="chapter_info">views</p><p class="chapter_info">${n}日前</p></div>`,
                  )
                  .join("") +
                "</div>",
            );
          if (url.pathname === "/manga/fixture-one/chapter-2")
            return html("<script>var CHAPTER_ID = 55;</script>");
          if (url.pathname === "/ajax/image/list/chap/55")
            return json({
              status: true,
              html: '<div class="image_story"><img src="https://cdnkk.top/1.jpg"><img src="https://cdnkk.top/2.jpg"></div>',
            });
          return html(
            url.pathname === "/all-manga/1"
              ? '<div class="story_item"><div class="mg_name"><a href="/manga/fixture-one">Fixture One</a></div><img src="https://mangakuro.net/c.jpg"></div>'
              : "",
          );
        },
        id: "fixture-one",
      };
    case "liliana":
      return {
        handler(url) {
          if (url.pathname === "/manga/fixture-one")
            return html(
              '<div class="a2"><header><h1>Fixture One</h1></header></div><div id="syn-target">About it</div><ul>' +
                [2, 1]
                  .map(
                    (n) =>
                      `<li class="chapter"><a href="/manga/fixture-one/chapter-${n}">Chapter ${n}</a><time datetime="${1767225600 + n * 86400}"></time></li>`,
                  )
                  .join("") +
                "</ul>",
            );
          if (url.pathname === "/manga/fixture-one/chapter-2")
            return html("<script>const CHAPTER_ID = 77;</script>");
          // The image list arrives out of order; data-index orders it.
          if (url.pathname === "/ajax/image/list/chap/77")
            return json({
              status: true,
              html: '<div class="separator" data-index="2"><a href="https://cdnkk.top/2.jpg"></a></div><div class="separator" data-index="1"><a href="https://cdnkk.top/1.jpg"></a></div>',
            });
          return html(
            url.pathname === "/ranking/week/1"
              ? '<div id="main"><div class="grid"><div><img src="https://raw1001.net/c.jpg"><div class="text-center"><a href="/manga/fixture-one">Fixture One</a></div></div></div></div>'
              : "",
          );
        },
        id: "fixture-one",
        firstPage: "https://cdnkk.top/1.jpg",
      };
    case "mangareader":
      return {
        handler(url) {
          if (url.pathname === "/read/fixture-one/")
            return html(
              '<div id="ani_detail"><h2 class="manga-name">Fixture One</h2><img data-src="https://mgoimg.view47.com/cover.jpg"><div class="genres"><a>Action</a></div><div class="description">About it</div><div class="anisc-info"><div class="item"><span class="item-head">地位:</span><span class="name">Publishing</span></div><div class="item"><span class="item-head">著者:</span><a>Author A</a></div></div></div><ul id="ja-chaps">' +
                [2, 1]
                  .map(
                    (n) =>
                      `<li class="item reading-item chapter-item" data-id="90${n}" data-number="${n}"><a href="https://rawotaku.com/read/fixture-one/ja/chapter-${n}-raw/"><span class="name">第${n}話</span></a></li>`,
                  )
                  .join("") +
                "</ul>",
            );
          // The reader page doesn't state the chapter's id: the chapter key carries it.
          if (url.pathname === "/read/fixture-one/ja/chapter-2-raw/") return html("<div></div>");
          if (url.pathname === "/json/chapter") {
            assert.equal(url.searchParams.get("id"), "902");
            return json({
              status: 1,
              html: '<div class="container-reader-chapter"><div><img data-src="https://sv1.freeimgmg.online/1.webp"></div><div><img data-src="https://sv1.freeimgmg.online/2.webp"></div></div>',
            });
          }
          return html(
            url.pathname === "/filter/" && url.searchParams.get("p") === "1"
              ? '<div class="manga_list-sbs"><a class="manga-poster" href="https://rawotaku.com/read/fixture-one/"><img data-src="https://mgoimg.view47.com/c.jpg" alt="Fixture One"></a></div>'
              : "",
          );
        },
        id: "fixture-one",
      };
    case "rawkuma": {
      const manga = {
        id: 9,
        slug: "fixture-one",
        title: { rendered: "Fixture One" },
        content: { rendered: "<p>About it</p>" },
        _embedded: {
          "wp:term": [
            [{ name: "Ongoing", taxonomy: "status" }],
            [{ name: "Manga", taxonomy: "type" }],
          ],
        },
      };
      return {
        handler(url) {
          if (url.pathname === "/wp-json/wp/v2/manga")
            return json(url.searchParams.get("page") > "1" ? [] : [manga]);
          if (url.pathname === "/wp-admin/admin-ajax.php") {
            assert.equal(url.searchParams.get("manga_id"), "9");
            return html(
              `<div>${[2, 1]
                .map(
                  (n) =>
                    `<a href="https://rawkuma.net/manga/fixture-one/chapter-${n}/"><span>Chapter ${n}</span><time datetime="2026-01-0${n}T00:00:00Z"></time></a>`,
                )
                .join("")}</div>`,
            );
          }
          if (url.pathname === "/manga/fixture-one/chapter-2/")
            return html('<section data-image-data="1"><img src="https://rawkuma.net/1.jpg"><img src="https://rawkuma.net/2.jpg"></section>');
          return json({});
        },
        id: "fixture-one",
      };
    }
    case "spaRaw":
      return {
        handler(url) {
          if (url.pathname === "/spa/genre/all" || url.pathname === "/spa/latest-manga")
            return json({
              manga_list:
                url.searchParams.get("page") === "1"
                  ? [{ manga_id: 579, manga_name: "Fixture One", manga_cover_img: `${origin}/c.webp` }]
                  : [],
              pagi: {},
            });
          if (url.pathname === "/spa/manga/579")
            return json({
              detail: { manga_id: 579, manga_name: "Fixture One", manga_status: false, manga_cover_img: `${origin}/cover.webp` },
              tags: [{ tag_name: "drama" }],
              authors: [{ author_name: "Author A" }],
              chapters: [2, 1].map((n) => ({
                chapter_title: "",
                chapter_number: n,
                chapter_date_published: `2026-01-0${n}T00:00:00Z`,
              })),
            });
          // Image paths are relative to the chapter's image server.
          if (url.pathname === "/spa/manga/579/2")
            return json({
              chapter_detail: {
                server: "https://s1.rawuwu.net/",
                chapter_content: '<img data-src="data/1.webp"><img data-src="data/2.webp">',
              },
            });
          return json({});
        },
        id: "579",
        firstPage: "https://s1.rawuwu.net/data/1.webp",
      };
    case "love4u":
      return {
        handler(url) {
          if (url.pathname === "/manga-18/")
            return html(
              '<ol class="breadcrumb"><li class="breadcrumb-item active">Fixture One</li></ol><div class="manga-info"><h3 data-enc="RklYVFVSRSBPTkU="></h3></div><div class="row"><ul><li><a class="btn btn-xs btn-success">On going</a></li></ul><img class="thumbnail" src="https://s4.ihlv1.xyz/cover.jpg"></div>' +
                [2, 1]
                  .map(
                    (n) =>
                      `<a href="/manga-18/fixture-one-raw-chapter-${n}.30${n}.html" title="Chapter ${n}"><li><div class="chapter-name">Chapter ${n}</div><div class="chapter-time">${n} days ago</div></li></a>`,
                  )
                  .join(""),
            );
          if (url.pathname === "/manga-18/fixture-one-raw-chapter-2.302.html")
            return html('<img class="chapter-img" src="https://s4.ihlv1.xyz/1.jpg"><img class="chapter-img" src="https://s4.ihlv1.xyz/2.jpg">');
          return html(
            url.searchParams.get("page") === "1"
              ? '<div class="thumb-item-flow"><div class="img-in-ratio" data-bg="https://s4.ihlv1.xyz/c.jpg"></div><div class="series-title"><a href="/manga-18/" title="Fixture One">Fixture One</a></div></div>'
              : "",
          );
        },
        id: "18",
      };
    case "nihonkuni":
      return {
        handler(url) {
          // The chapter list repeats each link (the grid and its "show all" copy).
          if (url.pathname === "/manga-fixture-one-raw.html")
            return html(
              '<div class="manga-detail-container"><img class="manga-cover-image" data-original="https://s4.ihlv1.xyz/cover.jpg" alt="Fixture One"></div><ul class="manga-info-list"><li><div class="info-field-label">Status</div><div class="info-field-value"><a>On going</a></div></li></ul><div class="description-text-content">About it</div>' +
                [2, 2, 1]
                  .map(
                    (n) =>
                      `<a href="read-fixture-one-raw-chapter-${n}.html" data-time="${n} days "><span class="chapter-name">Chapter ${n}</span></a>`,
                  )
                  .join(""),
            );
          if (url.pathname === "/read-fixture-one-raw-chapter-2.html")
            return html('<img id="page1" class="chapter-img" src="https://ihlv1.xyz/1.jpg"><img id="page2" class="chapter-img" src="https://ihlv1.xyz/2.jpg">');
          return html(
            url.searchParams.get("page") === "1"
              ? `<div class="manga-grid"><div class="manga-card"><a class="manga-cover" style="background-image: url('https://s4.ihlv1.xyz/c.jpg'), url('uploads/lazy-loading.gif');"></a><a class="manga-title" href="manga-fixture-one-raw.html">Fixture One</a></div></div>`
              : "",
          );
        },
        id: "fixture-one-raw",
      };
    default:
      throw new Error(`No fixtures for ${port.engine}`);
  }
}

const allowed = (hosts, host) => hosts.some((entry) => host === entry || host.endsWith(`.${entry}`));

async function withFixture(port, run) {
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
    await run(source, fixture);
    for (const host of hosts)
      assert.ok(allowed(manifest.allowed_hosts, host), `${host} is outside allowed_hosts`);
  } finally {
    globalThis.fetch = original;
  }
}

for (const port of wave) {
  test(`${port.key} (${port.engine}): browse, details, chapters and reader offline`, () =>
    withFixture(port, async (source, fixture) => {
      const rows = await source.fetchManga("popular", { limit: 2, offset: 0 }, {});
      assert.ok(rows.length >= 1, "the catalogue lists titles");
      assert.ok(rows.every((row) => row.title && row.id && row.source === port.key));

      const details = await source.fetchMangaDetails(fixture.id);
      assert.ok(details.title.startsWith("Fixture"), `details carry the title: ${details.title}`);
      assert.equal(details.chapters.length, 2, "details carry each chapter once");
      const numbers = details.chapters.map((chapter) => chapter.chapter_number);
      assert.deepEqual(numbers, [2, 1], "chapter numbers are read, newest first");

      const pages = await source.fetchChapterPages(details.chapters[0].id, fixture.id);
      assert.equal(pages.total, 2, "the reader has both pages");
      assert.ok(pages.items.every((page) => /^https:\/\//.test(page.image_url)));
      if (fixture.firstPage) assert.equal(pages.items[0].image_url, fixture.firstPage);
    }));
}

test("MangaHere's page reader reads its key and the chapterfun.ashx scripts", async () => {
  const port = wave.find((entry) => entry.key === "mangahere");
  const requests = [];
  const { manifest } = await resolveSource(port.key);
  const source = (await import(new URL(`../dist/${port.key}.js`, import.meta.url))).default;
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    assert.ok(allowed(manifest.allowed_hosts, url.hostname));
    if (url.pathname === "/manga/fixture_one/c002/1.html")
      return html(
        `<script>var chapterid =9001; var imagecount=3;</script>${pack("var guidkey=''+'ab'+'cd';var x=1;")}`,
      );
    if (url.pathname === "/manga/fixture_one/c002/chapterfun.ashx") {
      const page = Number(url.searchParams.get("page"));
      const values = page === 1 ? ['"/p1.jpg"', '"/p2.jpg"'] : ['"/p3.jpg"', '"/p4.jpg"'];
      return html(pack(`var pix="//zjcdn.mangahere.org/store";var pvalue=[${values.join(",")}];`));
    }
    return html("");
  };
  try {
    const pages = await source.fetchChapterPages("mangahere:fixture_one/c002", "fixture_one");
    assert.deepEqual(
      pages.items.map((page) => page.image_url),
      ["/p1.jpg", "/p2.jpg", "/p3.jpg"].map((path) => `https://zjcdn.mangahere.org/store${path}`),
    );
    const calls = requests.filter((url) => url.pathname.endsWith("chapterfun.ashx"));
    assert.deepEqual(
      calls.map((url) => [url.searchParams.get("cid"), url.searchParams.get("page"), url.searchParams.get("key")]),
      [
        ["9001", "1", "abcd"],
        ["9001", "3", "abcd"],
      ],
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("the new sources refuse ids outside their sites' shapes before any request", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => assert.fail(`no request expected: ${input}`);
  try {
    for (const [key, chapter] of [
      ["rawotaku", "rawotaku:../../admin"],
      ["rawdevart", "rawdevart:579/../../x"],
      ["love4u", "love4u:manga-18/../x"],
      ["nihonkuni", "nihonkuni:read-x/../../y"],
      ["mangahere", "mangahere:fixture_one/../c1"],
    ]) {
      const source = (await import(new URL(`../dist/${key}.js`, import.meta.url))).default;
      await assert.rejects(source.fetchChapterPages(chapter, ""), `${key} refuses ${chapter}`);
    }
  } finally {
    globalThis.fetch = original;
  }
});
