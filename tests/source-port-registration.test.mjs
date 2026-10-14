import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { discoverSourceDirectories } from "../scripts/source-layout.mjs";

test("all adapters have fixture coverage; the new wave publishes 20 English sources and holds 10 Japanese drafts", async () => {
  const legacy = JSON.parse(
    await readFile(
      new URL("./fixtures/source-search-fixtures.json", import.meta.url),
      "utf8",
    ),
  );
  const english = JSON.parse(
    await readFile(
      new URL("./fixtures/english-source-ports.json", import.meta.url),
      "utf8",
    ),
  );
  const japanese = JSON.parse(
    await readFile(
      new URL("./fixtures/japanese-source-keys.json", import.meta.url),
      "utf8",
    ),
  );
  const keys = [...english.map((port) => port.key), "flamecomics", ...japanese];
  assert.equal(keys.length, 30);
  assert.equal(new Set(keys).size, 30);
  const sources = await discoverSourceDirectories();
  // These pre-existing adapters use dedicated fixtures in native-catalogue,
  // blocked-drafts and komiku-draft tests rather than the older search fixture file.
  const dedicated = ['akazascans', 'imhentai', 'komiku', 'sushiscan'];
  assert.deepEqual(
    sources.map((source) => source.key).sort(),
    [...Object.keys(legacy), ...dedicated, ...keys].sort(),
  );
  const index = JSON.parse(
    await readFile(new URL("../index.json", import.meta.url), "utf8"),
  );
  // GigaViewer pages all use the unsupported "baku" scrambled format, so the Japanese
  // ports stay built and tested but unlisted until descrambling exists.
  for (const key of japanese) {
    const source = sources.find((candidate) => candidate.key === key);
    assert.equal(source.manifest.draft, true, `${key} must stay a draft`);
    assert.ok(source.manifest.draft_reason);
    assert.ok(!index.sources.some((entry) => entry.source_key === key));
  }
  const counts = { en: 0 };
  for (const key of keys.filter((key) => !japanese.includes(key))) {
    const entry = index.sources.find((source) => source.source_key === key);
    assert.ok(entry, `${key} must be listed and installable`);
    assert.ok(entry.icon_url, `${key} needs its source icon`);
    assert.ok(entry.bundle.sha256 && entry.bundle.size > 0);
    counts[entry.lang]++;
  }
  assert.deepEqual(counts, { en: 20 });
  const adult = index.sources.find(source => source.source_key === 'mangafree');
  assert.equal(adult.content_rating, 'nsfw');
  assert.equal(adult.isNSFW, true, 'preserve the upstream adult rating for privacy filtering');
});
