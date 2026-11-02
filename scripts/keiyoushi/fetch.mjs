// Fetches the pinned Keiyoushi extensions-source files the porting scripts read: the tree,
// every en/all extension's build.gradle.kts and Kotlin sources, and the multisrc theme
// libraries. Read-only against GitHub; cached under scripts/keiyoushi/.cache.
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const UPSTREAM_SHA = "efa93f5a3537856fe830450bbe33f69d21d28167";
const here = path.dirname(fileURLToPath(import.meta.url));
export const CACHE = path.join(here, ".cache", UPSTREAM_SHA.slice(0, 12));
const LANGS = (process.env.KEIYOUSHI_LANGS ?? "en,all").split(",");

async function cached(file, produce) {
  const target = path.join(CACHE, file);
  try {
    return await fs.readFile(target, "utf8");
  } catch {
    const text = await produce();
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, text);
    return text;
  }
}

export async function upstreamTree() {
  const raw = await cached("tree.json", async () =>
    execFileSync(
      "gh",
      ["api", `repos/keiyoushi/extensions-source/git/trees/${UPSTREAM_SHA}?recursive=1`],
      { maxBuffer: 256 * 1024 * 1024, encoding: "utf8" },
    ),
  );
  return JSON.parse(raw).tree.filter((entry) => entry.type === "blob").map((entry) => entry.path);
}

export async function upstreamFile(file) {
  return cached(path.join("files", file), async () => {
    const url = `https://raw.githubusercontent.com/keiyoushi/extensions-source/${UPSTREAM_SHA}/${file}`;
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url);
      if (response.ok) return response.text();
      if (attempt >= 3) throw new Error(`${response.status} ${file}`);
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  });
}

/** Every file of interest: extension builds and Kotlin for the chosen languages, and all
 * theme libraries. */
export async function wantedFiles() {
  const tree = await upstreamTree();
  return tree.filter(
    (file) =>
      (LANGS.some((lang) => file.startsWith(`src/${lang}/`)) &&
        (file.endsWith("build.gradle.kts") || file.endsWith(".kt"))) ||
      (file.startsWith("lib-multisrc/") && (file.endsWith(".kt") || file.endsWith(".kts"))),
  );
}

if (process.argv[1]?.endsWith("fetch.mjs")) {
  const files = await wantedFiles();
  let done = 0;
  const queue = [...files];
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (queue.length) {
        await upstreamFile(queue.shift());
        if (++done % 200 === 0) console.log(`${done}/${files.length}`);
      }
    }),
  );
  console.log(`fetched ${files.length} files at ${UPSTREAM_SHA}`);
}
