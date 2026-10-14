import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  discoverSourceDirectories,
  resolveSource,
} from "../scripts/source-layout.mjs";

test("language folders match metadata and preserve stable source bundle identities", async () => {
  const sources = await discoverSourceDirectories();
  assert.equal(
    new Set(sources.map((source) => source.key)).size,
    sources.length,
  );
  for (const source of sources) {
    assert.equal(
      path.basename(path.dirname(source.dir)),
      source.manifest.lang.toLowerCase(),
    );
    assert.equal(path.basename(source.dir), source.manifest.source_key);
    assert.equal(path.basename(source.entryPoint), "index.ts");
    const schemaPath = path.resolve(source.dir, source.manifest.$schema);
    assert.equal(
      JSON.parse(await readFile(schemaPath, "utf8")).title,
      "ProjektManga source manifest",
    );
  }
  const editions = sources.filter((source) =>
    source.key.startsWith("mangadex"),
  );
  assert.ok(editions.some((source) => source.manifest.lang === "ja"));
  for (const source of editions) {
    assert.equal(source.manifest.family_key, "mangadex");
    assert.ok(!source.manifest.name.includes("â"), source.manifest.name);
  }
  await assert.rejects(resolveSource("../../untrusted"), /Unknown source key/);
});
