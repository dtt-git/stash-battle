// Headless Chrome against a running Stash, for screenshots (scripts/screenshots.mjs) and smoke
// checks (scripts/smoke.mjs). Uses playwright-core with the Chrome (or Edge) already installed;
// no browser download.
//
// Every request to /graphql goes through a fake layer, so nothing is ever written to Stash:
//   real  - reads pass through; every mutation is refused
//   fresh - like a first install: Stash Battle's config and custom fields are hidden, and writes
//           land in memory (later reads see them)
//   old   - a Stash without scene custom fields (pre-v0.31.0)
//   big   - a synthetic library of `size` scenes, writes in memory
// A privacy guard runs before Stash's own scripts: the page behind the modal, images and videos
// are hidden, and titles, studios, performers and tags become placeholders.

import { chromium } from "playwright-core";

export const STASH_URL = process.env.STASH_URL || "http://localhost:9999";
const PLUGIN_ID = "stash-battle";
const OUR_FIELD = /^stash_battle_/;

// ---------- privacy guard (runs in the page, before Stash's own scripts) ----------

function guard() {
  const install = () => {
    const css = document.createElement("style");
    css.textContent = `
      #root { visibility: hidden !important; }
      #sb-modal img, #sb-modal video, #sb-modal canvas { visibility: hidden !important; }
      .sb-scene-image-container, .sb-mini-card [class*="thumb"], .sb-end-screen-image { background: #000 !important; }`;
    document.head.appendChild(css);
    const titles = new Map();
    const letter = (i) => (i < 26 ? String.fromCharCode(65 + i) : String.fromCharCode(64 + Math.floor(i / 26)) + String.fromCharCode(65 + (i % 26)));
    const fix = () => {
      document.querySelectorAll(".sb-scene-title, .sb-mini-title, .sb-end-screen-name").forEach((el) => {
        if (el.dataset.guarded === el.textContent) return;
        const orig = el.textContent.trim();
        if (!titles.has(orig)) titles.set(orig, titles.size);
        const t = "Scene " + letter(titles.get(orig));
        el.textContent = t;
        el.dataset.guarded = t;
        if (el.title) el.title = t;
      });
      document.querySelectorAll(".sb-scene-card").forEach((card) => {
        const L = (card.querySelector(".sb-scene-title")?.textContent || "Scene A").replace("Scene ", "");
        const st = card.querySelector(".sb-meta-studio");
        const pf = card.querySelector(".sb-meta-performers");
        const cp = card.querySelector(".sb-meta-compact");
        if (cp && cp.textContent && cp.dataset.guarded !== L) { cp.textContent = `Studio ${L}`; cp.dataset.guarded = L; }
        if (st && st.dataset.guarded !== L) { st.innerHTML = `<strong>Studio:</strong> Studio ${L}`; st.dataset.guarded = L; }
        if (pf && pf.dataset.guarded !== L) { pf.innerHTML = `<strong>Performers:</strong> Performer ${L}`; pf.dataset.guarded = L; }
        card.querySelectorAll(".sb-tag").forEach((el, i) => { if (el.textContent !== `Tag ${i + 1}`) el.textContent = `Tag ${i + 1}`; });
      });
    };
    window.__sbResetTitles = () => titles.clear();
    // The two battle cards as Scene A / Scene B
    window.__sbAB = () => {
      titles.clear();
      document.querySelectorAll(".sb-scene-card .sb-scene-title").forEach((el, i) => {
        const t = "Scene " + "AB"[i];
        el.dataset.guarded = t;
        el.textContent = t;
      });
      fix();
    };
    // Small cards named in the order they're shown: Scene A, B, C...
    window.__sbRenumber = () => {
      titles.clear();
      document.querySelectorAll(".sb-mini-title").forEach((el, i) => {
        const t = "Scene " + letter(i);
        titles.set(t, i);
        el.dataset.guarded = t;
        el.textContent = t;
        if (el.title) el.title = t;
      });
    };
    fix();
    new MutationObserver(fix).observe(document.body, { childList: true, subtree: true, characterData: true });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install);
  else install();
}

// ---------- the fake layer's own copy of what Stash Battle writes ----------

class FakeWrites {
  constructor(config) {
    this.config = config; // Stash Battle's plugin config (undefined = never saved)
    this.scenes = new Map(); // id -> { set: {}, removed: Set, rating100? }
    this.count = 0;
  }

  /** Apply a mutation's variables: sceneUpdate / bulkSceneUpdate inputs, or configurePlugin. */
  apply(query, variables) {
    this.count++;
    if (/configurePlugin/.test(query)) {
      if (variables.plugin_id === PLUGIN_ID) this.config = variables.input;
      return;
    }
    for (const input of Object.values(variables)) {
      if (!input || typeof input !== "object") continue;
      const ids = input.ids ?? (input.id !== undefined ? [input.id] : []);
      for (const id of ids) {
        const entry = this.scenes.get(String(id)) ?? { set: {}, removed: new Set() };
        const cf = input.custom_fields;
        if (cf?.partial) for (const [k, v] of Object.entries(cf.partial)) { entry.set[k] = v; entry.removed.delete(k); }
        if (cf?.remove) for (const k of cf.remove) { delete entry.set[k]; entry.removed.add(k); }
        if ("rating100" in input) entry.rating100 = input.rating100;
        this.scenes.set(String(id), entry);
      }
    }
  }

  /** A scene as Stash would return it now: `strip` hides the custom fields it really has. */
  overlay(scene, strip) {
    const entry = this.scenes.get(String(scene.id));
    if (!("custom_fields" in scene) && !entry) return scene;
    const cf = { ...(scene.custom_fields || {}) };
    if (strip) for (const k of Object.keys(cf)) if (OUR_FIELD.test(k)) delete cf[k];
    if (entry) {
      for (const k of entry.removed) delete cf[k];
      Object.assign(cf, entry.set);
    }
    const out = { ...scene, custom_fields: cf };
    if (entry && "rating100" in entry) out.rating100 = entry.rating100;
    return out;
  }

  /** Overlay every scene-like object (an id and custom_fields) inside a GraphQL response. */
  walk(value, strip) {
    if (Array.isArray(value)) return value.map((v) => this.walk(v, strip));
    if (!value || typeof value !== "object") return value;
    const copy = {};
    for (const [k, v] of Object.entries(value)) copy[k] = this.walk(v, strip);
    return "id" in copy && "custom_fields" in copy ? this.overlay(copy, strip) : copy;
  }
}

// ---------- a synthetic library ----------

/** A seeded random number generator, so a big library is the same every run. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function syntheticLibrary(size, seed = 7) {
  const r = rng(seed);
  const normal = () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
  const scenes = [];
  for (let i = 0; i < size; i++) {
    const id = String(900000 + i);
    const rated = r() < 0.85;
    const custom_fields = {};
    let rating100 = r() < 0.8 ? Math.max(1, Math.min(100, Math.round(60 + normal() * 18))) : null;
    if (rated) {
      const battles = Math.floor(-Math.log(1 - r()) * 8);
      const wins = Math.round(battles * r());
      custom_fields.stash_battle_elo = Math.round((1600 + normal() * 220) * 10) / 10;
      custom_fields.stash_battle_battles = battles;
      custom_fields.stash_battle_seeded = r() < 0.7 ? 1 : 0;
      if (battles > 0) {
        custom_fields.stash_battle_wins = wins;
        custom_fields.stash_battle_losses = battles - wins;
        custom_fields.stash_battle_peak = custom_fields.stash_battle_elo + Math.round(r() * 60);
        custom_fields.stash_battle_streak = Math.floor(r() * 3);
        custom_fields.stash_battle_best_streak = Math.floor(r() * 8);
      }
    }
    scenes.push({
      id,
      title: `Synthetic scene ${i + 1}`,
      date: "2024-01-01",
      rating100,
      play_count: Math.floor(-Math.log(1 - r()) * 4),
      o_counter: Math.floor(-Math.log(1 - r()) * 1.5),
      custom_fields,
      paths: { screenshot: null, preview: null },
      files: [{ duration: 60 + Math.floor(r() * 3000), path: `/library/synthetic-${i + 1}.mp4` }],
      studio: { name: `Studio ${1 + Math.floor(r() * 200)}` },
      performers: [{ name: `Performer ${1 + Math.floor(r() * 2000)}` }],
      tags: [{ name: `Tag ${1 + Math.floor(r() * 300)}` }],
    });
  }
  return scenes;
}

// ---------- launch ----------

const json = (route, body) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/**
 * Launch a headless browser on Stash. Options: mode (see the top), size (big mode), phone
 * (a 393 x 852 touch screen at 3x), viewport, scale, config (fake config to start with in
 * fresh / big mode), hideSetupDone (real mode: answer the config without eloSetupAt, so the
 * first-run setup shows), ratingSystem (Stash's rating display to pretend, e.g. { type: "stars",
 * starPrecision: "half" }), configPatch (real mode: settings the page sees in place of the
 * stored ones; nothing is saved).
 */
export async function launch(opts = {}) {
  const mode = opts.mode || "real";
  const browser = await chromium.launch({ channel: process.env.HARNESS_BROWSER || "chrome", headless: true }).catch(() =>
    chromium.launch({ channel: "msedge", headless: true }),
  );
  const context = await browser.newContext(
    opts.phone
      ? { viewport: { width: 393, height: 852 }, deviceScaleFactor: opts.scale ?? 3, isMobile: true, hasTouch: true }
      : { viewport: opts.viewport ?? { width: 1040, height: 960 }, deviceScaleFactor: opts.scale ?? 2 },
  );
  const writes = new FakeWrites(opts.config);
  const stats = { refused: 0 };
  const library = mode === "big" ? syntheticLibrary(opts.size ?? 20000) : null;
  const byId = library ? new Map(library.map((s) => [s.id, s])) : null;

  await context.route("**/graphql", async (route) => {
    const body = route.request().postData() || "";
    let query = "";
    let variables = {};
    try {
      const parsed = JSON.parse(body);
      query = parsed.query || "";
      variables = parsed.variables || {};
    } catch {
      return route.continue();
    }

    if (/^\s*mutation\b/.test(query)) {
      if (mode === "real" || mode === "old") {
        stats.refused++;
        return json(route, { errors: [{ message: "write blocked (harness)" }] });
      }
      writes.apply(query, variables);
      return json(route, { data: {} });
    }

    if (mode === "old" && /__type\(name:\s*"Scene"\)/.test(query)) {
      return json(route, { data: { __type: { fields: [{ name: "id" }, { name: "title" }, { name: "rating100" }] } } });
    }

    if (/configuration\s*\{\s*plugins/.test(query) && (mode !== "real" || opts.hideSetupDone || opts.ratingSystem || opts.configPatch)) {
      const res = await route.fetch();
      const data = await res.json();
      const ui = data?.data?.configuration?.ui;
      if (opts.ratingSystem && ui) ui.ratingSystemOptions = opts.ratingSystem;
      const plugins = data?.data?.configuration?.plugins;
      if (plugins) {
        if (mode === "real") {
          const cfg = opts.hideSetupDone ? plugins[PLUGIN_ID] : null;
          if (cfg) { delete cfg.eloSetupAt; delete cfg.eloSetupMode; }
          // Settings this page sees in place of the stored ones (Stash keeps its own)
          if (opts.configPatch) plugins[PLUGIN_ID] = { ...plugins[PLUGIN_ID], ...opts.configPatch };
        } else if (writes.config === undefined) delete plugins[PLUGIN_ID];
        else plugins[PLUGIN_ID] = writes.config;
      }
      return route.fulfill({ response: res, json: data });
    }

    if (mode === "big") {
      // Stash Battle's own scene queries (Stash's pages ask with their own operations)
      if (/FindScenesByRating|findScenes\(filter:\s*\{\s*per_page:\s*-1/.test(query)) {
        const scenes = library.map((s) => writes.overlay(s, false));
        return json(route, { data: { findScenes: { count: scenes.length, scenes } } });
      }
      if (/query FindScene\(/.test(query)) {
        const s = byId.get(String(variables.id));
        return json(route, { data: { findScene: s ? writes.overlay(s, false) : null } });
      }
      const aliased = [...query.matchAll(/(\w+):\s*findScene\(id:\s*"?(\d+)"?\)/g)];
      if (aliased.length) {
        const data = {};
        for (const [, alias, id] of aliased) data[alias] = byId.has(id) ? writes.overlay(byId.get(id), false) : null;
        return json(route, { data });
      }
    }

    if (mode === "fresh" && /custom_fields/.test(query)) {
      const res = await route.fetch();
      const data = await res.json();
      return route.fulfill({ response: res, json: writes.walk(data, true) });
    }

    return route.continue();
  });
  await context.addInitScript(guard);

  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    // Refused writes log a GraphQL error on purpose
    if (m.type() === "error" && !/write blocked/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  return { browser, context, page, writes, stats, errors, library };
}

/** Open Stash Battle from the Scenes page's navbar link (or the top-bar icon on narrow screens). */
export async function openStashBattle(page) {
  await page.goto(`${STASH_URL}/scenes`);
  await page.waitForFunction(() => document.querySelector("#plugin_sb_icon, nav a, nav button"), null, { timeout: 30000 });
  await page.waitForFunction(
    () => [...document.querySelectorAll("nav a, nav button")].some((e) => /Battle/.test(e.textContent)) || document.querySelector("#plugin_sb_icon"),
    null,
    { timeout: 30000 },
  );
  await page.evaluate(() => {
    const link = [...document.querySelectorAll("nav a, nav button")].find((e) => /Battle/.test(e.textContent));
    (link || document.querySelector("#plugin_sb_icon button, #plugin_sb_icon a, #plugin_sb_icon")).click();
  });
  await page.waitForSelector("#sb-modal", { timeout: 30000 });
}

/** Switch Stash Battle's tab by (part of) its name; scrolls back to the top. */
export async function showTab(page, name, settle = 2000) {
  await page.evaluate((n) => {
    const tabs = [...document.querySelectorAll("#sb-modal .nav-link, #sb-modal [data-tab]")];
    const tab = tabs.find((t) => t.textContent.includes(n) || t.getAttribute("aria-label")?.includes(n));
    tab.click();
  }, name);
  await page.waitForTimeout(settle);
  await page.evaluate(() => (document.querySelector(".sb-modal-content").scrollTop = 0));
  await page.waitForTimeout(200);
}

/** Every scene's Stash rating and custom fields, plus Stash Battle's config, straight from Stash. */
export async function stashSnapshot() {
  const res = await fetch(`${STASH_URL}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: `{ findScenes(filter:{per_page:-1}) { scenes { id rating100 custom_fields } } configuration { plugins } }` }),
  });
  const { data } = await res.json();
  return { scenes: data.findScenes.scenes, config: data.configuration.plugins[PLUGIN_ID] ?? null };
}

/** Compare two snapshots: the ids of scenes that differ, and whether the config is the same. */
export function snapshotDiff(before, after) {
  const was = new Map(before.scenes.map((s) => [s.id, JSON.stringify([s.rating100, s.custom_fields])]));
  const changed = after.scenes.filter((s) => was.get(s.id) !== JSON.stringify([s.rating100, s.custom_fields])).map((s) => s.id);
  return { changed, configSame: JSON.stringify(after.config) === JSON.stringify(before.config), count: after.scenes.length };
}
