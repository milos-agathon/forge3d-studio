import { cpSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The published facade imports its wasm-bindgen glue relative to its own URL.
// Keep its browser modules together in both Vite dev and the Tauri bundle.
const source = new URL("../node_modules/@forge3d/web/dist/", import.meta.url);
const dest = new URL("../public/forge3d-web/", import.meta.url);
mkdirSync(dest, { recursive: true });
cpSync(fileURLToPath(source), fileURLToPath(dest), {
  recursive: true,
  filter: path => !path.endsWith(".map") && !path.endsWith(".d.ts"),
});
