import type { SourceManifest } from "../lib/types.js";
import { createMangaDexSource } from "./factory.js";
import manifest from "./manifest.json";
export default createMangaDexSource(manifest as SourceManifest);
