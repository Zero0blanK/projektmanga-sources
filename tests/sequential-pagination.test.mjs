import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["src/lib/sequentialPagination.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
});
const { collectSequentialPages } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`
);
const collectError = async (status, page) => {
  const fetchPage = async (number) => {
    if (number === page) {
      throw Object.assign(new Error(`HTTP ${status}`), { code: status });
    }
    return [{ id: String(number) }];
  };
  return collectSequentialPages({ limit: 3, offset: 0 }, "fixture", fetchPage);
};

test("variable pagination skips unique rows, stops repeated pages and normalizes windows", async () => {
  const calls = [];
  const result = await collectSequentialPages(
    { limit: 2.8, offset: 1.2 },
    "fixture",
    async (page) => {
      calls.push(page);
      return page === 1
        ? [{ id: "a" }, { id: "b" }]
        : [{ id: "b" }, { id: "c" }];
    },
  );
  assert.deepEqual(
    result.map((row) => row.id),
    ["b", "c"],
  );
  assert.deepEqual(calls, [1, 2]);
  assert.deepEqual(
    await collectSequentialPages(
      { limit: 5, offset: 0 },
      "fixture",
      async () => [{ id: "same" }],
    ),
    [{ id: "same" }],
  );
  assert.deepEqual(
    await collectSequentialPages(
      { limit: 0, offset: 0 },
      "fixture",
      async () => {
        throw new Error("must not fetch");
      },
    ),
    [],
  );
});

test("later-page failures propagate and excessive upstream work is bounded", async () => {
  await assert.rejects(collectError("RATE_LIMITED", 2), /HTTP RATE_LIMITED/);
  await assert.rejects(collectError("PARSE_ERROR", 1), /HTTP PARSE_ERROR/);
  let requests = 0;
  await assert.rejects(
    collectSequentialPages(
      { limit: 1, offset: 100 },
      "fixture",
      async (page) => {
        requests++;
        return [{ id: String(page) }];
      },
    ),
    /exceeds 50/,
  );
  assert.equal(requests, 50);
});
