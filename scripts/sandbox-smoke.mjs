import { resolveSource } from "./source-layout.mjs";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appRoot = path.resolve(
  process.env.PROJEKT_MANGA_APP_DIR || path.join(root, "..", "MangaWebsite"),
);
const { spawnSandboxedSource } = await import(
  pathToFileURL(path.join(appRoot, "apps/extensions/dist/sandbox/index.js"))
    .href
);
const schemas = await import(
  pathToFileURL(path.join(appRoot, "packages/schemas/dist/index.js")).href
);
const keys = process.argv.slice(2);
if (!keys.length)
  throw new Error(
    "Pass explicit source keys; this live gate never scrapes all sources incidentally.",
  );
let failures = 0;
for (const key of keys) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) throw new Error("Invalid source key");
  const manifest = (await resolveSource(key, root)).manifest;
  const source = spawnSandboxedSource(
    {
      id: key,
      name: manifest.name,
      lang: manifest.lang,
      base_url: manifest.base_url,
      isNSFW: manifest.content_rating === "nsfw",
    },
    {
      bundlePath: path.join(root, "dist", `${key}.js`),
      allowedNetHosts: manifest.allowed_hosts,
      timeoutMs: 30_000,
    },
  );
  try {
    const titles = schemas.sourceMangaListSchema.parse(
      await source.fetchManga("popular", { limit: 5, offset: 0 }, {}),
    );
    assert.ok(titles.length, "Browse must return titles");
    schemas.sourceMangaListSchema.parse(
      await source.searchManga("a", { limit: 5, offset: 0 }, {}),
    );
    schemas.sourceMangaFilterListSchema.parse(await source.getFilters());
    schemas.sourceMangaDetailsSchema.parse(
      await source.fetchMangaDetails(titles[0].id),
    );
    let found;
    for (const title of titles) {
      const chapters = schemas.sourceChapterListSchema.parse(
        await source.fetchChapters(title.id),
      );
      if (chapters.length) {
        found = { title, chapter: chapters[0] };
        break;
      }
    }
    assert.ok(found, "At least one of five titles must have readable chapters");
    const pages = schemas.sourceChapterPagesSchema.parse(
      await source.fetchChapterPages(found.chapter.id, found.title.slug, {
        limit: 3,
        offset: 0,
      }),
    );
    assert.ok(
      pages.items.length && pages.total > 0,
      "Reader must return page URLs",
    );
    console.log(`${key}: sandbox contract gate passed; ${pages.total} pages`);
  } catch (error) {
    failures++;
    console.error(`${key}: ${error.message}`);
  } finally {
    source.dispose();
  }
}
if (failures) process.exitCode = 1;
