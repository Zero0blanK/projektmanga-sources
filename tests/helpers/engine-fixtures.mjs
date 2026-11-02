import assert from "node:assert/strict";

/**
 * Synthetic pages in each engine's site shapes, shared by the offline wave tests: a
 * fetch handler per engine, the title id it serves, and the category to browse.
 */
export const html = (body) => new Response(body, { headers: { "content-type": "text/html" } });
export const json = (body) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

/** Per engine: a fetch handler serving the site's pages, and how to browse it. */
export function fixtures(port, manifest) {
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
          // The AJAX listing (`browse: "ajax"`): one page of cards, then nothing.
          if (url.pathname === "/wp-admin/admin-ajax.php") {
            const form = new URLSearchParams(String(init?.body ?? ""));
            assert.equal(form.get("action"), "madara_load_more");
            return html(
              form.get("page") === "0"
                ? [1, 2]
                    .map(
                      (n) =>
                        `<div class="page-item-detail"><img src="/c${n}.webp"><div class="post-title"><h3><a href="/${d}/fixture-${n}/">Fixture ${n}</a></h3></div></div>`,
                    )
                    .join("")
                : "",
            );
          }
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
    case "mangacatalog": {
      const slug = port.titles[0];
      const card = port.layout === "card";
      return {
        handler(url) {
          if (url.pathname === `/manga/${slug}/`)
            return html(
              card
                ? `<h2><span>Fixture 1</span></h2><img class="card-img-right" src="/cover.jpg"><div class="card-body"><p>About it</p></div><table><tbody>${[2, 1]
                    .map((n) => `<tr><td>Fixture Chapter ${n}</td><td>Jan 1, 2026</td><td><a class="btn-primary" href="/chapter/fixture-chapter-${n}/">Read</a></td></tr>`)
                    .join("")}</tbody></table>`
                : `<div class="container"><h1>Fixture 1</h1></div><div class="flex"><img src="/cover.jpg"></div><div class="w-full">${[2, 1]
                    .map((n) => `<div class="bg-bg-secondary"><div class="grid"><div class="col-span-4"><a href="/chapter/fixture-chapter-${n}/">Fixture Chapter ${n}</a></div><div class="text-xs">Part ${n}</div></div></div>`)
                    .join("")}</div>`,
            );
          if (url.pathname === "/chapter/fixture-chapter-2/")
            return html(
              card
                ? '<div class="pages"><img class="pages__img" src="/1.jpg"><img class="pages__img" src="/2.jpg"></div>'
                : '<img data-src="https://cdn.example/1.jpg"><img data-src="https://cdn.example/2.jpg">',
            );
          return html("<html></html>");
        },
        id: slug,
      };
    }
    case "yiimanga": {
      const d = port.mangaPath;
      return {
        handler(url) {
          if (url.pathname === `/${d}/fixture-1/chapter-2/`)
            return html('<div class="reading-content"><img src="/1.jpg"><img src="/2.jpg"></div>');
          if (url.pathname === `/${d}/fixture-1/`)
            return html(
              `<h1 class="main-info-title">Fixture 1</h1><img class="img-cover" src="/cover.jpg"><ul class="main-info-list"><li><h5>Status</h5><span>Ongoing</span></li></ul><div class="short-desc-content"><p>About it</p></div><ul class="chapter-list">${[2, 1]
                .map((n) => `<li><a href="/${d}/fixture-1/chapter-${n}/"><span class="chapter-name">Chapter ${n}</span></a><span class="ct-update">06 Oct 2026</span></li>`)
                .join("")}</ul>`,
            );
          return html(
            `<div class="latest-list">${[1, 2]
              .map((n) => `<div class="latest-item"><div class="latest-left"><img src="/c${n}.jpg"></div><div class="latest-right"><a href="/${d}/fixture-${n}/"><h3>Fixture ${n}</h3></a></div></div>`)
              .join("")}</div>`,
          );
        },
        id: "fixture-1",
      };
    }
    case "vinetheme":
      return {
        handler(url) {
          if (url.pathname === "/api/series")
            return json({
              data: [1, 2].map((n) => ({ id: `s${n}`, title: `Fixture ${n}`, slug: `fixture-${n}`, coverImage: `/c${n}.webp` })),
              meta: { hasMore: false },
            });
          if (url.pathname === "/series/comic/fixture-1/chapter/2")
            return html('3:{"chapter":{"pages":[{"imageUrl":"/p1.webp"},{"imageUrl":"/p2.webp"}]}}\n');
          if (url.pathname === "/series/comic/fixture-1")
            return html(
              `1:"$Sreact.fragment"\n2:["$","div",null,${JSON.stringify({
                series: { id: "s1", title: "Fixture 1", slug: "fixture-1", status: "ONGOING", description: "<p>About it</p>" },
                chapters: [
                  { id: "c2", number: 2, title: "2", publishedAt: "2026-01-08T00:00:00Z" },
                  { id: "c1", number: 1, title: "1", publishedAt: "2026-01-01T00:00:00Z" },
                  { id: "c3", number: 3, isLocked: true },
                ],
                totalPages: 1,
              })}]\n`,
            );
          if (url.pathname === "/series")
            return html('4:{"tagTotal":1,"genres":[{"name":"Action","slug":"action","count":1}],"tags":[]}\n');
          return json({});
        },
        id: "fixture-1",
      };
    case "heancms":
      return {
        handler(url) {
          assert.ok(url.hostname.startsWith("api."), "HeanCMS calls its API host");
          if (url.pathname === "/query")
            return json({
              data: [1, 2].map((n) => ({ id: n, series_slug: `fixture-${n}`, title: `Fixture ${n}`, thumbnail: `c${n}.webp` })),
              meta: { current_page: 1, last_page: 1 },
            });
          if (url.pathname === "/series/fixture-1")
            return json({ id: 1, series_slug: "fixture-1", title: "Fixture 1", status: "Ongoing", description: "<p>About it</p>", thumbnail: "c1.webp" });
          if (url.pathname === "/chapter/query")
            return json({
              data: [
                { id: 3, chapter_name: "Chapter 3", chapter_slug: "chapter-3", price: 5 },
                { id: 2, chapter_name: "Chapter 2", chapter_slug: "chapter-2", price: 0, created_at: "2026-01-08T00:00:00Z" },
                { id: 1, chapter_name: "Chapter 1", chapter_slug: "chapter-1", price: 0, created_at: "2026-01-01T00:00:00Z" },
              ],
              meta: { current_page: 1, last_page: 1 },
            });
          if (url.pathname === "/chapter/fixture-1/chapter-2")
            return json({ chapter: { chapter_data: { images: ["one.webp", "two.webp"] } } });
          if (url.pathname === "/tags") return json([{ id: 1, name: "Action" }]);
          return json({});
        },
        id: "fixture-1",
      };
    case "guya":
      return {
        handler(url) {
          if (url.pathname === "/api/get_all_series/")
            return json({ "Fixture 1": { slug: "fixture-1", cover: "/c.png", last_updated: 2 }, "Fixture 2": { slug: "fixture-2", last_updated: 1 } });
          if (url.pathname === "/api/series/fixture-1/")
            return json({
              slug: "fixture-1",
              title: "Fixture 1",
              groups: { 1: "Group" },
              chapters: {
                1: { title: "One", folder: "f1", groups: { 1: ["1.png"] }, release_date: { 1: 1767225600 } },
                2: { title: "Two", folder: "f2", groups: { 1: ["1.png", "2.png?v3"] }, release_date: { 1: 1767830400 } },
              },
            });
          return json({});
        },
        id: "fixture-1",
      };
    default:
      throw new Error(`No fixtures for ${port.engine}`);
  }
}

export const allowed = (hosts, host) => hosts.some((entry) => host === entry || host.endsWith(`.${entry}`));

