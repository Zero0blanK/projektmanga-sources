import {
  resolveSource,
  discoverSourceDirectories,
} from "../scripts/source-layout.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

async function source(key) {
  const result = await build({
    entryPoints: [(await resolveSource(key)).entryPoint],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node20",
  });
  return (
    await import(
      `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`
    )
  ).default;
}
test("static filters require no request and preserve native choices", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = () => {
    throw Error("Filters must not scrape");
  };
  try {
    for (const key of ["weebcentral", "asurascans", "leercapitulo"]) {
      const adapter = await source(key);
      const filters = await adapter.getFilters();
      assert.ok(filters.length >= 5, key);
      for (const filter of filters)
        if (filter.options)
          assert.equal(
            new Set(filter.options.map((option) => option.value)).size,
            filter.options.length,
          );
      if (key === "weebcentral")
        assert.equal(
          filters.find((filter) => filter.value === "tags").options.length,
          38,
        );
      if (key === "asurascans")
        assert.equal(
          filters.find((filter) => filter.value === "genres").options.length,
          35,
        );
      if (key === "leercapitulo")
        assert.equal(
          filters.find((filter) => filter.value === "genre").options.length,
          82,
        );
    }
  } finally {
    globalThis.fetch = previous;
  }
});
test("WeebCentral deduplicates cover/title links and sends native included/excluded filters", async () => {
  const adapter = await source("weebcentral");
  const previous = globalThis.fetch;
  const requests = [];
  const id = "01KJQDPBS4K2P7H0TAXY4W9FXE";
  globalThis.fetch = async (url) => {
    requests.push(new URL(url));
    return new Response(
      `<a href="/series/${id}/fixture"><img src="https://example.invalid/cover.jpg" alt="Fixture Cover"></a><a href="/series/${id}/fixture">Fixture</a><a href="/series/${id.slice(0, -1)}F/other"><img alt="Other" src="https://example.invalid/other.jpg"></a>`,
      { headers: { "content-type": "text/html" } },
    );
  };
  try {
    const rows = await adapter.searchManga(
      "fixture",
      { limit: 2, offset: 0 },
      {
        sortBy: "Alphabet",
        order: "Ascending",
        official: "True",
        included_status: ["Ongoing", "Complete"],
        included_type: ["Manhwa"],
        tags: { include: ["Action"], exclude: ["Romance"] },
      },
    );
    assert.equal(rows.length, 2);
    assert.equal(new Set(rows.map((row) => row.id)).size, 2);
    assert.equal(rows[0].id, id);
    const params = requests[0].searchParams;
    assert.equal(params.get("sort"), "Alphabet");
    assert.equal(params.get("order"), "Ascending");
    assert.equal(params.get("official"), "True");
    assert.deepEqual(params.getAll("included_status"), ["Ongoing", "Complete"]);
    assert.equal(params.get("included_tag"), "Action");
    assert.equal(params.get("excluded_tag"), "Romance");
  } finally {
    globalThis.fetch = previous;
  }
});
test("Asura honours static sort/status/type/genre/creator/chapter controls with native q search", async () => {
  const adapter = await source("asurascans");
  const previous = globalThis.fetch;
  let request;
  globalThis.fetch = async (url) => {
    request = new URL(url);
    return new Response(
      '<a href="/comics/fixture"><img alt="Fixture" src="https://example.invalid/image.jpg"></a><a href="/comics/fixture">Fixture</a><a href="/comics/other"><img alt="Other" src="https://example.invalid/other.jpg"></a>',
      { headers: { "content-type": "text/html" } },
    );
  };
  try {
    const rows = await adapter.searchManga(
      "title with spaces",
      { limit: 2, offset: 0 },
      {
        sortBy: "rating",
        order: "asc",
        status: "completed",
        type: "manhwa",
        genres: ["action", "romance"],
        author: "Author",
        artist: "Artist",
        min_chapters: "25",
      },
    );
    assert.equal(rows.length, 2);
    assert.equal(new Set(rows.map((row) => row.id)).size, 2);
    const params = request.searchParams;
    assert.equal(params.get("q"), "title with spaces");
    assert.equal(params.get("sort"), "rating");
    assert.equal(params.get("order"), "asc");
    assert.equal(params.get("genres"), "action,romance");
    assert.equal(params.get("author"), "Author");
    assert.equal(params.get("artist"), "Artist");
    assert.equal(params.get("min_chapters"), "25");
  } finally {
    globalThis.fetch = previous;
  }
});
test("LeerCapitulo sends genre slugs and tolerates previous URL-shaped saved filter values", async () => {
  const adapter = await source("leercapitulo");
  const previous = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(new URL(url));
    return new Response(
      '<div class="lc-card"><a class="lc-card-name" href="/manga/abc/fixture/">Fixture</a><img src="https://example.invalid/cover.jpg"></div>',
      { headers: { "content-type": "text/html" } },
    );
  };
  try {
    await adapter.fetchManga(
      "latest",
      { limit: 1, offset: 0 },
      { genre: "action", type: "manhwa", status: "ongoing", sort: "za" },
    );
    await adapter.fetchManga(
      "latest",
      { limit: 1, offset: 0 },
      { genre: "/manga/?genre=action" },
    );
    assert.equal(requests[0].searchParams.get("genre"), "action");
    assert.equal(requests[0].searchParams.get("sort"), "za");
    assert.equal(requests[1].searchParams.get("genre"), "action");
  } finally {
    globalThis.fetch = previous;
  }
});
