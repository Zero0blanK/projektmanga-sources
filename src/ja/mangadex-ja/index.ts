import type { SourceManifest } from "../../lib/types.js";
import { createMangaDexSource } from "../../lib/mangadex/factory.js";
import manifest from "./manifest.json";
export default createMangaDexSource(manifest as SourceManifest);
