// Build script for the Stash Battle plugin.
//
// Usage:
//   node scripts/build.mjs            Production build -> plugins/stash-battle/stash-battle.js
//   node scripts/build.mjs --watch    Dev watch: rebuilds on change and deploys into the live
//                                      Stash plugins folder (if STASH_PLUGINS_DIR is set).
//
// Environment variables (dev only) - set these in a .env file (see .env.example):
//   STASH_PLUGINS_DIR   Path to your local Stash "plugins" folder. When unset, dev builds
//                       are NOT deployed into Stash (you just get the repo build).
//                       Set to "none" to explicitly disable deploying.

import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

try {
  process.loadEnvFile(path.join(root, ".env"));
} catch {
}

const args = process.argv.slice(2);
const watch = args.includes("--watch");
const dev = watch || args.includes("--dev");

const PLUGIN_ID = "stash-battle";
const REPO_PLUGIN_DIR = path.join(root, "plugins", PLUGIN_ID);
const OUTFILE = path.join(REPO_PLUGIN_DIR, "stash-battle.js");
const ASSET_FILES = ["stash-battle.css", "stash-battle.yml"];

// Resolve the directory inside the live Stash install we deploy to (dev only).
function resolveDeployDir() {
  if (!dev) return null;
  const raw = process.env.STASH_PLUGINS_DIR;
  if (!raw || raw.toLowerCase() === "none") return null;
  return path.join(raw, PLUGIN_ID);
}

const deployDir = resolveDeployDir();

function deploy() {
  if (!deployDir) return;
  fs.mkdirSync(deployDir, { recursive: true });
  fs.copyFileSync(OUTFILE, path.join(deployDir, "stash-battle.js"));
  for (const asset of ASSET_FILES) {
    fs.copyFileSync(path.join(REPO_PLUGIN_DIR, asset), path.join(deployDir, asset));
  }
}

// esbuild watch only covers the TS import graph; css/yml are copied separately in deploy().
function deployAssets(changedPath) {
  const time = new Date().toLocaleTimeString();
  const rel = path.relative(root, changedPath);
  try {
    if (path.basename(changedPath) === "stash-battle.yml") syncVersion();
    deploy();
    if (deployDir) {
      console.log(`[build] ${time} ok -> ${rel} (deployed to ${deployDir})`);
    } else {
      console.log(`[build] ${time} ok -> ${rel}`);
    }
  } catch (e) {
    console.error(`[build] ${time} deploy failed (${rel}):`, e);
  }
}

function watchPluginAssets() {
  let debounce = null;
  for (const asset of ASSET_FILES) {
    const assetPath = path.join(REPO_PLUGIN_DIR, asset);
    fs.watch(assetPath, () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => deployAssets(assetPath), 100);
    });
  }
}

// Mirror the version number from stash-battle.yml into package.json.
function syncVersion() {
  try {
    const ymlPath = path.join(REPO_PLUGIN_DIR, "stash-battle.yml");
    const match = fs.readFileSync(ymlPath, "utf8").match(/^version:\s*(.+)$/m);
    if (!match) {
      console.warn("[build] no version found in stash-battle.yml; skipping version sync");
      return;
    }
    const version = match[1].trim().replace(/^["']|["']$/g, "");
    const pkgPath = path.join(root, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    if (pkg.version === version) return;
    const previous = pkg.version;
    pkg.version = version;
    fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    console.log(`[build] synced package.json version ${previous} -> ${version} (from stash-battle.yml)`);
  } catch (e) {
    console.warn("[build] version sync skipped:", e.message);
  }
}

/** @type {import('esbuild').Plugin} */
const reportPlugin = {
  name: "report-and-deploy",
  setup(build) {
    build.onEnd((result) => {
      const time = new Date().toLocaleTimeString();
      if (result.errors.length) {
        console.error(`[build] ${time} failed with ${result.errors.length} error(s)`);
        return;
      }
      try {
        deploy();
      } catch (e) {
        console.error(`[build] ${time} deploy failed:`, e);
        return;
      }
      console.log(`[build] ${time} ok -> ${path.relative(root, OUTFILE)}${deployDir ? ` (deployed to ${deployDir})` : ""}`);
    });
  },
};

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [path.join(root, "src", "main.ts")],
  outfile: OUTFILE,
  bundle: true,
  format: "iife",
  target: "es2020",
  charset: "utf8",
  legalComments: "none",
  sourcemap: dev ? "inline" : false,
  minify: false,
  logLevel: "silent",
  plugins: [reportPlugin],
};

syncVersion();

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  watchPluginAssets();
  console.log("[dev] watching src/ (via esbuild) and stash-battle.css, stash-battle.yml");
  if (deployDir) console.log(`[dev] deploying builds to ${deployDir} (refresh Stash manually after each save)`);
  else console.log("[dev] deploy disabled (set STASH_PLUGINS_DIR in .env to enable)");
} else {
  await esbuild.build(options);
}
