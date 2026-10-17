import assert from "node:assert/strict";
import test from "node:test";

/**
 * MangaThemesia ships two details layouts and a site uses one or the other.
 *
 * `english-source-ports.test.mjs` builds its synthetic details page with the older
 * `<table class="infotable">`, which is the form the selectors already matched — so a
 * site serving the other one went untested. On those sites `.infotable` matches nothing,
 * status fell through to UNKNOWN on a page plainly showing "Ongoing", and author and
 * artist came back empty. Madara Scans is one: its pages carry no `.infotable` at all.
 *
 * Both layouts are asserted here so neither can be dropped while the other keeps passing.
 */

const CHAPTERS = `<div id="chapterlist"><ul><li><a href="/series/x/chapter-1/"><span class="chapternum">Chapter 1</span></a><span class="chapterdate">2026-01-01</span></li></ul></div>`;

/** The current theme build: a list of `.imptdt` rows, each a heading plus an `<i>`. */
const tsinfoLayout = `
<div class="bigcontent">
  <h1 class="entry-title">Fixture Title</h1>
  <div class="thumb"><img src="/cover.webp"></div>
  <div class="desc">Description</div>
  <div class="tsinfo bixbox">
    <div class="imptdt"><h1> Type </h1> <i>Manga</i></div>
    <div class="imptdt"><h1> Status </h1> <i>Ongoing</i></div>
    <div class="imptdt"><h1> Released </h1> <i>2025</i></div>
    <div class="imptdt"><h1> Author </h1> <i>Oh Seong-rak</i></div>
    <div class="imptdt"><h1> Artist </h1> <i>Jun</i></div>
  </div>
</div>${CHAPTERS}`;

/** The older build, kept passing so this change cannot regress the sites using it. */
const infotableLayout = `
<div class="bigcontent">
  <h1 class="entry-title">Fixture Title</h1>
  <div class="thumb"><img src="/cover.webp"></div>
  <div class="desc">Description</div>
  <table class="infotable">
    <tr><td>Author</td><td>Oh Seong-rak</td></tr>
    <tr><td>Artist</td><td>Jun</td></tr>
    <tr><td>Status</td><td>Ongoing</td></tr>
  </table>
</div>${CHAPTERS}`;

let fixtureCounter = 0;

async function detailsFrom(html) {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(html, { headers: { "content-type": "text/html" } });
  try {
    const source = (await import("../dist/madarascans.js")).default;
    // A distinct URL per call: the source keeps a 2-minute TTL cache keyed by URL
    // (lib/cache.ts), so reusing one would serve the first fixture to every assertion
    // and quietly pass whatever the later ones claimed.
    fixtureCounter += 1;
    return await source.fetchMangaDetails(
      `https://madarascans.net/series/fixture-${fixtureCounter}/`,
    );
  } finally {
    globalThis.fetch = original;
  }
}

for (const [name, html] of [
  ["tsinfo/imptdt list", tsinfoLayout],
  ["infotable table", infotableLayout],
]) {
  test(`MangaThemesia details: ${name}`, async () => {
    const details = await detailsFrom(html);

    // The reported bug: a page that says "Ongoing" reporting UNKNOWN.
    assert.equal(details.status, "ONGOING");
    assert.deepEqual(details.author, ["Oh Seong-rak"]);
    assert.deepEqual(details.artist, ["Jun"]);
    assert.equal(details.title, "Fixture Title");
  });
}

test("MangaThemesia details: completed and hiatus still resolve", async () => {
  const withStatus = (value) =>
    tsinfoLayout.replace("<i>Ongoing</i>", `<i>${value}</i>`);

  assert.equal((await detailsFrom(withStatus("Completed"))).status, "COMPLETED");
  assert.equal((await detailsFrom(withStatus("Hiatus"))).status, "HIATUS");
  // Nothing recognisable is still honestly unknown rather than guessed.
  assert.equal((await detailsFrom(withStatus("Mystery"))).status, "UNKNOWN");
});
