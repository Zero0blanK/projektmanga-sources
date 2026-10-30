// RawDevArt (Japanese raws), on the shared single-page-app raw site engine.
import { createSpaRawSite } from "../../lib/spaRaw.js";
import type { SourceManifest } from "../../lib/types.js";
import manifest from "./manifest.json";

export default createSpaRawSite(manifest as SourceManifest, {
  title: (id) => `/g/ne${id}`,
  chapter: (id, number) => `/read/ne${id}/chapter-${number}`,
});
