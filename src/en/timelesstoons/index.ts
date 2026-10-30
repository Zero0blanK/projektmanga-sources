// Timeless Toons: the Keyoapp platform (see lib/keyoapp.ts); selectors follow the Keiyoushi
// extension for this site (Apache-2.0).
import { createKeyoappSite } from "../../lib/keyoapp.js";
import type { SourceManifest } from "../../lib/types.js";
import manifest from "./manifest.json";
export default createKeyoappSite(manifest as SourceManifest, {
  popularSelector: "div:has(> h2:contains(Trending)) + div .group",
  latestSelector: "div.grid > div.group.latest-poster",
});
