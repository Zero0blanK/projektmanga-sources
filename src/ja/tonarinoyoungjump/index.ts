import type { SourceManifest } from "../../lib/types.js";
import { createGigaViewer } from "../../lib/gigaViewer.js";
import manifest from "./manifest.json";
import config from "./collections.json";

export default createGigaViewer(manifest as SourceManifest, config);
