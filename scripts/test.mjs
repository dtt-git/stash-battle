// Unit tests: bundle tests/*.test.ts with esbuild (Node can't run the TypeScript directly),
// then run them with Node's built-in test runner.
//
// Usage: npm test

import * as esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testsDir = path.join(root, "tests");
const outDir = path.join(root, ".test-build");

const entryPoints = fs
  .readdirSync(testsDir)
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => path.join(testsDir, f));

fs.rmSync(outDir, { recursive: true, force: true });
await esbuild.build({
  entryPoints,
  outdir: outDir,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "warning",
});

const files = fs.readdirSync(outDir).map((f) => path.join(outDir, f));
const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
