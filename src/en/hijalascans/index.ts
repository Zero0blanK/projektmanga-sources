// Hijala Scans: the Iken platform (see lib/iken.ts); settings follow the Keiyoushi extension
// for this site (Apache-2.0).
import { createIkenSite } from "../../lib/iken.js";
import type { SourceManifest } from "../../lib/types.js";
import manifest from "./manifest.json";
export default createIkenSite(manifest as SourceManifest, {});
