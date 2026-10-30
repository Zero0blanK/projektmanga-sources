// Mist Scans: the Keyoapp platform (see lib/keyoapp.ts); selectors follow the Keiyoushi
// extension for this site (Apache-2.0).
import { createKeyoappSite } from "../../lib/keyoapp.js";
import type { SourceManifest } from "../../lib/types.js";
import manifest from "./manifest.json";
export default createKeyoappSite(manifest as SourceManifest, {
  popularSelector: ".series-splide .splide__slide",
});
