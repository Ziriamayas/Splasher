import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";

const outdir = "dist";
const srcEntry = "src/index.ts";
const outFile = path.join(outdir, "index.js");

// Inline IMGUR_CLIENT_ID at build time if provided
const IMGUR_CLIENT_ID = process.env.IMGUR_CLIENT_ID || "8218830746fcf7d"; // replace later with your own

await fs.mkdir(outdir, { recursive: true });

await build({
  entryPoints: [srcEntry],
  outfile: outFile,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2020"],
  legalComments: "none",
  minify: false,
  define: {
    __IMGUR_CLIENT_ID__: JSON.stringify(IMGUR_CLIENT_ID)
  },
  external: [
    // leave these to be resolved at runtime by Revenge
    "@vendetta/metro",
    "@vendetta/patcher",
    "@vendetta/ui/assets",
    "@vendetta/ui/toasts"
  ]
});

// copy & rewrite manifest
const raw = await fs.readFile("manifest.json", "utf8");
const manifest = JSON.parse(raw);
manifest.main = "index.js";
await fs.writeFile(path.join(outdir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

console.log("[build] done -> dist/");