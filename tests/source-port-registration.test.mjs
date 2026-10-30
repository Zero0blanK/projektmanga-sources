import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { discoverSourceDirectories } from "../scripts/source-layout.mjs";

test("all adapters have fixture coverage; the ported waves publish 59 English and 10 Japanese sources and hold 10 Japanese drafts", async () => {
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
  // The second English wave (2026-10-30); see english-wave-2.test.mjs.
  const wave2 = JSON.parse(
    await readFile(new URL("./fixtures/english-wave-2.json", import.meta.url), "utf8"),
  ).map((port) => port.key);
  assert.equal(wave2.length, 35);
  // The third wave (2026-10-30): five English sources and ten Japanese raw sites; see
  // source-wave-3.test.mjs.
  const wave3 = JSON.parse(
    await readFile(new URL("./fixtures/source-wave-3.json", import.meta.url), "utf8"),
  ).map((port) => port.key);
  assert.equal(wave3.length, 15);
  const keys = [...english.map((port) => port.key), "flamecomics", ...japanese, ...wave2, ...wave3];
  assert.equal(keys.length, 80);
  assert.equal(new Set(keys).size, 80);
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
  // English ports drafted after their site broke, each with its reason in the manifest.
  const drafted = ["zinmanga"];
  for (const key of drafted) {
    const source = sources.find((candidate) => candidate.key === key);
    assert.equal(source.manifest.draft, true, `${key} is drafted`);
    assert.ok(source.manifest.draft_reason);
  }
  const counts = { en: 0, ja: 0 };
  for (const key of keys.filter((key) => !japanese.includes(key) && !drafted.includes(key))) {
    const entry = index.sources.find((source) => source.source_key === key);
    assert.ok(entry, `${key} must be listed and installable`);
    assert.ok(entry.icon_url, `${key} needs its source icon`);
    assert.ok(entry.bundle.sha256 && entry.bundle.size > 0);
    counts[entry.lang]++;
  }
  assert.deepEqual(counts, { en: 59, ja: 10 });
  const adult = index.sources.find(source => source.source_key === 'mangafree');
  assert.equal(adult.content_rating, 'nsfw');
  assert.equal(adult.isNSFW, true, 'preserve the upstream adult rating for privacy filtering');
});
