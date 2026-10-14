import { resolveSource } from "./source-layout.mjs";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Explicit live acceptance for this source only; never part of npm test.
if (!process.argv.includes("--live"))
  throw new Error("Pass --live to accept bounded public source requests");
const sourceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const appRoot = path.resolve(
  process.env.PROJEKT_MANGA_APP_DIR ??
    path.join(sourceRoot, "..", "MangaWebsite"),
);
const { spawnSandboxedSource } = await import(
  pathToFileURL(path.join(appRoot, "apps/extensions/dist/sandbox/index.js"))
    .href
);
const schemas = await import(
  pathToFileURL(path.join(appRoot, "packages/schemas/dist/index.js")).href
);
const { assertPublicHttpUrl } = await import(
  pathToFileURL(path.join(appRoot, "apps/server/dist/utils/ssrfGuard.js")).href
);
const manifest = (await resolveSource("akazascans", sourceRoot)).manifest;
const allowed = (url) =>
  url.protocol === "https:" &&
  !url.username &&
  !url.password &&
  manifest.allowed_hosts.some(
    (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
  );
const validateOutboundUrl = async (url) => {
  if (!allowed(url)) return false;
  await assertPublicHttpUrl(url.href);
  return true;
};
const source = spawnSandboxedSource(
  {
    id: manifest.source_key,
    name: manifest.name,
    lang: manifest.lang,
    base_url: manifest.base_url,
    isNSFW: false,
  },
  {
    bundlePath: path.join(sourceRoot, "dist/akazascans.js"),
    allowedNetHosts: manifest.allowed_hosts,
    validateOutboundUrl,
    timeoutMs: 30000,
  },
);

try {
  const capabilities = schemas.sourceCapabilitiesSchema.parse(
    await source.getCapabilities(),
  );
  assert.equal(capabilities.nativePagination, true);
  const catalogue = schemas.sourceCataloguePageSchema.parse(
    await source.fetchMangaPage("latest", { limit: 100 }, {}),
  );
  assert.ok(catalogue.items.length);
  let nextCount = 0;
  if (catalogue.nextCursor) {
    const next = schemas.sourceCataloguePageSchema.parse(
      await source.fetchMangaPage(
        "latest",
        { limit: 100, cursor: catalogue.nextCursor },
        {},
      ),
    );
    nextCount = next.items.length;
    assert.ok(
      next.items.every(
        (x) => !catalogue.items.some((previous) => previous.id === x.id),
      ),
    );
  }
  const selected = catalogue.items[0];
  const search = schemas.sourceCataloguePageSchema.parse(
    await source.searchMangaPage(selected.title, { limit: 100 }, {}),
  );
  assert.ok(search.items.some((item) => item.id === selected.id));
  const filters = schemas.sourceMangaFilterListSchema.parse(
    await source.getFilters(),
  );
  assert.equal(
    filters.find((filter) => filter.value === "genre").options.length,
    42,
  );
  const details = schemas.sourceMangaDetailsSchema.parse(
    await source.fetchMangaDetails(selected.id),
  );
  const chapters = schemas.sourceChapterListSchema.parse(
    await source.fetchChapters(selected.id),
  );
  assert.ok(chapters.length);
  assert.equal(details.id, selected.id);
  assert.deepEqual(
    chapters.map((x) => x.id),
    details.chapters.map((x) => x.id),
  );
  const pages = schemas.sourceChapterPagesSchema.parse(
    await source.fetchChapterPages(chapters[0].id, details.slug, {
      limit: 2,
      offset: 0,
    }),
  );
  assert.ok(pages.total >= pages.items.length && pages.items.length > 0);
  assert.deepEqual(
    pages.items.map((x) => x.index),
    pages.items.map((_, i) => i + 1),
  );
  let image = new URL(pages.items[0].image_url);
  let response;
  for (let hop = 0; hop < 5; hop++) {
    assert.ok(
      allowed(image),
      "Reader image origin must be declared in the manifest",
    );
    await assertPublicHttpUrl(image.href);
    response = await fetch(image, {
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
      headers: { Range: "bytes=0-63", Referer: chapters[0].url },
    });
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get("location");
      await response.body?.cancel();
      assert.ok(next);
      image = new URL(next, image);
      continue;
    }
    break;
  }
  assert.ok(response.ok);
  const contentType = response.headers.get("content-type")?.split(";")[0];
  assert.ok(
    [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
      "image/avif",
    ].includes(contentType),
  );
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (bytes < 64) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value.subarray(0, 64 - bytes));
      bytes += chunks.at(-1).length;
    }
  } finally {
    await reader.cancel();
  }
  const prefix = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  const signature =
    contentType === "image/jpeg"
      ? prefix[0] === 0xff && prefix[1] === 0xd8
      : contentType === "image/png"
        ? prefix
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : contentType === "image/webp"
          ? prefix.toString("ascii", 0, 4) === "RIFF" &&
            prefix.toString("ascii", 8, 12) === "WEBP"
          : contentType === "image/gif"
            ? prefix.toString("ascii", 0, 3) === "GIF"
            : prefix.toString("ascii", 4, 8) === "ftyp" &&
              /avif|avis/.test(prefix.toString("ascii", 8, 32));
  assert.ok(signature, "Image signature must match the returned MIME");
  console.log(
    JSON.stringify({
      source: manifest.source_key,
      catalogue: catalogue.items.length,
      next: nextCount,
      hasMore: catalogue.hasMore,
      search: search.items.length,
      filters: filters.length,
      chapters: chapters.length,
      pages: pages.total,
      imageHost: image.hostname,
      imageMime: contentType,
      imageSignature: true,
      restrictedIPC: true,
    }),
  );
} finally {
  source.dispose();
}
