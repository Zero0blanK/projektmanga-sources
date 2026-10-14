import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** Discover language/source directories without depending on the current working directory. */
export async function discoverSourceDirectories(sourceRoot = repositoryRoot) {
  const root = path.join(sourceRoot, "src");
  const sources = [];
  for (const language of await readdir(root, { withFileTypes: true })) {
    if (!language.isDirectory() || language.name === "lib") continue;
    const languagePath = path.join(root, language.name);
    for (const entry of await readdir(languagePath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(languagePath, entry.name);
      const manifestPath = path.join(dir, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      if (
        manifest.source_key !== entry.name ||
        manifest.lang.toLowerCase() !== language.name
      )
        throw new Error(`Source layout does not match metadata: ${dir}`);
      sources.push({
        key: entry.name,
        dir,
        entryPoint: path.join(dir, "index.ts"),
        manifestPath,
        manifest,
      });
    }
  }
  if (new Set(sources.map((source) => source.key)).size !== sources.length)
    throw new Error("Duplicate source keys in language directories");
  return sources.sort((a, b) => a.key.localeCompare(b.key));
}

export async function resolveSource(key, sourceRoot = repositoryRoot) {
  const source = (await discoverSourceDirectories(sourceRoot)).find(
    (source) => source.key === key,
  );
  if (!source) throw new Error(`Unknown source key: ${key}`);
  return source;
}
