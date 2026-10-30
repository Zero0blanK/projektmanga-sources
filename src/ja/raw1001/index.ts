// Raw1001: the Liliana site design (see lib/liliana.ts).
import { createLilianaSite } from "../../lib/liliana.js";
import type { SourceManifest } from "../../lib/types.js";
import manifest from "./manifest.json";
export default createLilianaSite(manifest as SourceManifest);
