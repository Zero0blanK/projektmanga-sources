import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolveSource } from "../scripts/source-layout.mjs";
import { allowed, fixtures } from "./helpers/engine-fixtures.mjs";

/**
 * The second wave of English sources (2026-10-30), offline: each built bundle browses,
 * opens a title and reads a chapter from synthetic pages in its site's own shapes, and
 * never asks for a host outside its manifest's allowed_hosts. The live sites were
 * checked with `npm run smoke` when each source was added.
 */
const wave = JSON.parse(
  await readFile(new URL("./fixtures/english-wave-2.json", import.meta.url), "utf8"),
);

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
