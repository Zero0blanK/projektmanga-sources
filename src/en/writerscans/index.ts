// Writer Scans: the Keyoapp platform (see lib/keyoapp.ts); selectors follow the Keiyoushi
// extension for this site (Apache-2.0).
import { createKeyoappSite } from "../../lib/keyoapp.js";
import type { SourceManifest } from "../../lib/types.js";
import manifest from "./manifest.json";
export default createKeyoappSite(manifest as SourceManifest, {
  popularSelector: "div:contains(Trending) + div .group.overflow-hidden",
});
