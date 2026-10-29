// Copies the Stockfish 19 lite-single-threaded browser engine (JS + WASM)
// from node_modules into public/, so Vite serves both files side by side.
// The worker script locates its .wasm next to itself, so the pair must stay
// in the same directory. Run automatically via predev/prebuild; the files in
// public/stockfish/ are build output and are intentionally gitignored.
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "node_modules", "stockfish", "bin");
const outDir = join(root, "public", "stockfish");

const files = ["stockfish-19-lite-single.js", "stockfish-19-lite-single.wasm"];
for (const file of files) {
  const src = join(srcDir, file);
  if (!existsSync(src)) {
    console.error(`[copy-stockfish] missing ${src} — run "bun install" first`);
    process.exit(1);
  }
}
mkdirSync(outDir, { recursive: true });
for (const file of files) {
  copyFileSync(join(srcDir, file), join(outDir, file));
}
console.log("[copy-stockfish] copied lite-single engine to public/stockfish/");
