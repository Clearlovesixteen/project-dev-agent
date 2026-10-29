import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const directory = dirname(fileURLToPath(import.meta.url));
await build({ entryPoints: [resolve(directory, "worker.ts")], outfile: resolve(directory, "worker.mjs"),
  bundle: true, platform: "browser", format: "esm", target: "es2022", minify: true });
