import assert from "node:assert/strict";
import test from "node:test";

/**
 * Engine fixes from the source review (2026-10-30): one odd chapter or card must not take
 * down a whole title or catalogue page, and chapter numbers come from the chapter word,
 * not the first number in the name.
 */

async function withHtml(html, run) {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(html, { headers: { "content-type": "text/html" } });
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

let counter = 0;

test("MangaThemesia keeps a title whose list has a prologue with no number", async () => {
  const html = `<div class="bigcontent"><h1 class="entry-title">Fixture</h1>
    <div class="thumb"><img src="/c.webp"></div></div>
    <div id="chapterlist"><ul>
      <li><a href="/series/x/vol-2-chapter-15/"><span class="chapternum">Vol. 2 Chapter 15</span></a><span class="chapterdate">2026-01-02</span></li>
      <li><a href="/series/x/episode-7/"><span class="chapternum">Episode 7</span></a></li>
      <li><a href="/series/x/prologue/"><span class="chapternum">Prologue</span></a></li>
    </ul></div>`;
  const source = (await import("../dist/madarascans.js")).default;
  counter += 1;
  const details = await withHtml(html, () =>
    source.fetchMangaDetails(`https://madarascans.net/series/robust-${counter}/`),
  );
  assert.deepEqual(
    details.chapters.map((chapter) => chapter.chapter_number),
    [15, 7, 0],
  );
});

test("Madara reads chapter numbers from the chapter word and keeps slashless links", async () => {
  const html = `<div class="post-title"><h1>Fixture</h1></div>
    <div class="summary_image"><img src="/c.jpg"></div>
    <ul>
      <li class="wp-manga-chapter"><a href="https://manhuaplus.com/manga/x/vol-3-chapter-21">Vol. 3 Chapter 21</a></li>
      <li class="wp-manga-chapter"><a href="https://manhuaplus.com/manga/x/chapter-20/">Chapter 20</a></li>
    </ul>`;
  const source = (await import("../dist/manhuaplus.js")).default;
  const details = await withHtml(html, () => source.fetchMangaDetails("x"));
  assert.deepEqual(
    details.chapters.map((chapter) => [chapter.chapter_number, chapter.url]),
    [
      [21, "https://manhuaplus.com/manga/x/vol-3-chapter-21"],
      [20, "https://manhuaplus.com/manga/x/chapter-20/"],
    ],
  );
});

test("a catalogue card without a title is skipped, not fatal", async () => {
  const html = `<div class="listupd">
    <div class="bs"><div class="bsx"><a href="/series/one/" title="One"><img src="/1.webp"></a></div></div>
    <div class="bs"><div class="bsx"><a href="https://ads.example/x"><img src="/ad.webp"></a></div></div>
  </div>`;
  const source = (await import("../dist/madarascans.js")).default;
  const rows = await withHtml(html, () => source.fetchManga("latest", { limit: 5, offset: 0 }));
  assert.deepEqual(
    rows.map((row) => row.title),
    ["One"],
  );
});
