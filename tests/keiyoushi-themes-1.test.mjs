import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolveSource } from "../scripts/source-layout.mjs";
import { allowed, fixtures } from "./helpers/engine-fixtures.mjs";

/**
 * The first generated wave (2026-11-02): Keiyoushi extensions on a theme this repository
 * has an engine for, written by scripts/keiyoushi/generate.mjs. Offline, each bundle
 * browses, opens a title and reads a chapter from synthetic pages in its theme's shapes,
 * without asking for a host outside allowed_hosts. The live sites were accepted with
 * scripts/keiyoushi/probe.mjs; the ones whose site broke a step are drafts with a reason.
 */
const wave = JSON.parse(
  await readFile(new URL("./fixtures/keiyoushi-themes-1.json", import.meta.url), "utf8"),
);
const index = JSON.parse(await readFile(new URL("../index.json", import.meta.url), "utf8"));

test("the generated wave records its upstream, rating and listing", async () => {
  assert.equal(wave.length, 32);
  assert.equal(wave.filter((port) => !port.draft).length, 21);
  for (const port of wave) {
    const { manifest, entryPoint } = await resolveSource(port.key);
    const entry = await readFile(entryPoint, "utf8");
    assert.match(entry, new RegExp(`Generated from the Keiyoushi extension\\n// ${port.upstream} @`));
    assert.ok(["safe", "mixed", "nsfw"].includes(manifest.content_rating));
    const listed = index.sources.find((source) => source.source_key === port.key);
    if (port.draft) {
      assert.equal(manifest.draft, true, `${port.key} is a draft`);
      assert.ok(manifest.draft_reason, `${port.key} says why`);
      assert.ok(!listed, `${port.key} stays unlisted`);
    } else {
      assert.ok(listed, `${port.key} is listed`);
      assert.ok(listed.icon_url, `${port.key} has an icon`);
    }
  }
});

for (const port of wave) {
  test(`${port.key} (${port.engine}${port.browse ? `, ${port.browse} browse` : ""}): browse, details, chapters and reader offline`, async () => {
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
      const category = fixture.category ?? "popular";
      // Engines without native cursors (Keyoapp) browse by offset, as the sandbox falls back.
      const items =
        typeof source.fetchMangaPage === "function"
          ? (await source.fetchMangaPage(category, { limit: 20 }, {})).items
          : await source.fetchManga(category, { limit: 2, offset: 0 }, {});
      assert.ok(items.length >= 1, "the catalogue lists titles");
      assert.ok(items.every((row) => row.title && row.id && row.source === port.key));

      const details = await source.fetchMangaDetails(fixture.id);
      assert.ok(details.title.startsWith("Fixture"), "details carry the title");
      assert.ok(details.chapters.length >= 2, "details carry the chapters");
      const newest = details.chapters.find((chapter) => chapter.chapter_number === 2);
      assert.ok(newest, "chapter numbers are read");
      const pages = await source.fetchChapterPages(newest.id, fixture.id);
      assert.ok(pages.total >= 2, "the reader has pages");

      for (const host of hosts)
        assert.ok(allowed(manifest.allowed_hosts, host), `${host} is outside allowed_hosts`);
    } finally {
      globalThis.fetch = original;
    }
  });
}
