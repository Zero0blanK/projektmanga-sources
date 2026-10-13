import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

test("unnamed HentaiFox galleries retain identity and pagination without invalid empty titles", async () => {
  const bundle = await build({
    entryPoints: ["src/hentaifox/index.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
  });
  const source = (
    await import(
      `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`
    )
  ).default;
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(
        '<div class="thumb"><div class="g_title"><a href="/gallery/42/"></a></div><img src="https://i.hentaifox.com/42/cover.jpg"></div>',
      );
    const rows = await source.fetchManga("latest", { limit: 1 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "42");
    assert.equal(rows[0].title, "Untitled gallery 42");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
