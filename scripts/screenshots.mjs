// README / forum screenshots, taken from your running Stash with nothing written to it (see
// harness.mjs: every write is refused, titles and images are hidden). Lossless PNGs at 2x
// (desktop) and 3x (phone).
//
//   npm run screenshots                 every shot, into docs/screenshots/
//   npm run screenshots -- battle,gems  only these
//
// Shots: battle explore stats gems records settings champion placement setup scene-page
//        phone-battle phone-explore phone-stats (phone-scene-page on request)
// Stash's scenes and Stash Battle's config are compared before and after; the run fails if
// anything changed.

import fs from "node:fs";
import path from "node:path";
import { launch, openStashBattle, showTab, snapshotDiff, STASH_URL, stashSnapshot } from "./harness.mjs";

const OUT = process.env.SCREENSHOTS_DIR || "docs/screenshots";
const ALL = ["battle", "explore", "stats", "gems", "records", "settings", "champion", "placement", "setup", "scene-page", "phone-battle", "phone-explore", "phone-stats"];
const only = process.argv[2] ? process.argv[2].split(",") : ALL;
const want = (name) => only.includes(name);
fs.mkdirSync(OUT, { recursive: true });

const before = await stashSnapshot();
console.log(`snapshot: ${before.scenes.length} scenes`);
let refused = 0;
const errors = [];

/** Cycle Skip until the cards have different tiers, a record, and a clear favourite. */
async function findShowcasePair(page, wait) {
  for (let i = 0; i < 200; i++) {
    const ok = await page.evaluate(() => {
      const cards = [...document.querySelectorAll(".sb-scene-card")];
      if (cards.length < 2) return false;
      const tiers = cards.map((c) => c.querySelector(".sb-tier"));
      const rec = cards.map((c) => c.querySelector(".sb-meta-battles, .sb-meta-rating")?.textContent || "");
      // The favourite's chance, whichever side it's on
      const left = parseInt(document.querySelector(".sb-win-chance-left")?.textContent || "50");
      const n = Math.max(left, 100 - left);
      // Most scenes may still be 0–0: one real record is enough
      return tiers.every(Boolean) && rec.some((r) => /[1-9]/.test(r.replace(/^.*?:/, ""))) && n >= 58 && n <= 72 && tiers[0].className !== tiers[1].className;
    });
    if (ok) return;
    await page.click("#sb-skip-btn");
    await wait(1100);
  }
}

async function sortExplore(page, sort) {
  await page.evaluate((value) => {
    const sel = [...document.querySelectorAll("#sb-modal select")].find((s) => [...s.options].some((o) => o.value === value));
    sel.value = value;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  }, sort);
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    document.querySelector(".sb-modal-content").scrollTop = 0;
    window.__sbRenumber();
  });
}

// ---------- desktop ----------

const desktop = ["battle", "explore", "stats", "gems", "records", "settings", "champion", "placement"].filter(want);
if (desktop.length) {
  const run = await launch({ mode: "real" });
  const { page } = run;
  const wait = (ms) => page.waitForTimeout(ms);
  const away = () => page.mouse.move(1035, 5);
  /** The modal box (2px of margin), optionally from `top` to `bottom` (CSS px). */
  const shot = async (name, opts = {}) => {
    const r = await page.evaluate(() => {
      const b = document.querySelector(".sb-modal-content").getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    });
    const vh = page.viewportSize().height;
    const top = opts.top ?? r.y - 2;
    const bottom = Math.min(opts.bottom ?? r.y + r.height + 2, vh);
    await page.screenshot({ path: path.join(OUT, `${name}.png`), clip: { x: r.x - 2, y: top, width: r.width + 4, height: bottom - top } });
    console.log("saved", name);
  };

  await openStashBattle(page);
  await page.waitForFunction(() => document.querySelectorAll(".sb-scene-card").length === 2, null, { timeout: 30000 });
  await wait(1500);

  if (want("battle")) {
    await findShowcasePair(page, wait);
    await page.evaluate(() => window.__sbAB());
    await away();
    await wait(600);
    await shot("battle");
  }

  if (want("explore")) {
    await showTab(page, "Explore");
    await sortExplore(page, "record-desc");
    await away();
    await wait(400);
    await shot("explore");
  }

  const gemsHeading = () =>
    page.evaluate(() => {
      const h = [...document.querySelectorAll("#sb-modal *")].find((e) => e.children.length === 0 && e.textContent.trim() === "Hidden gems and overplayed");
      const r = h.getBoundingClientRect();
      const panel = h.nextElementSibling?.getBoundingClientRect();
      return { top: r.top, panelBottom: panel ? panel.bottom : r.bottom + 400 };
    });
  if (want("stats") || want("gems")) {
    await page.evaluate(() => window.__sbResetTitles());
    await showTab(page, "Stats");
    if (want("stats")) await shot("stats", { bottom: (await gemsHeading()).top - 12 });
    if (want("gems")) {
      await page.evaluate(() => {
        const sc = document.querySelector(".sb-modal-content");
        const h = [...document.querySelectorAll("#sb-modal *")].find((e) => e.children.length === 0 && e.textContent.trim() === "Hidden gems and overplayed");
        sc.scrollTop += h.getBoundingClientRect().top - sc.getBoundingClientRect().top - 330;
      });
      await wait(500);
      // Among the highest dots (top 12% of the ELO range), the least played: a real hidden gem
      const dot = await page.evaluate(() => {
        const circles = [...document.querySelectorAll("#sb-modal svg circle")].map((c) => c.getBoundingClientRect());
        const minY = Math.min(...circles.map((c) => c.y));
        const maxY = Math.max(...circles.map((c) => c.y));
        const high = circles.filter((c) => c.y < minY + (maxY - minY) * 0.12).sort((a, b) => a.x - b.x);
        return { x: high[0].x + high[0].width / 2, y: high[0].y + high[0].height / 2 };
      });
      await page.mouse.move(dot.x, dot.y);
      await wait(800);
      const g = await gemsHeading();
      await shot("gems", { top: g.top - 12, bottom: g.panelBottom + 12 });
      await away();
    }
  }

  if (want("records")) {
    await away();
    await page.evaluate(() => window.__sbResetTitles());
    await showTab(page, "Records");
    await away();
    await wait(400);
    await shot("records");
  }

  if (want("settings")) {
    await showTab(page, "Settings");
    await shot("settings");
  }

  // Champion: a 3-win streak (the picks' writes are refused)
  if (want("champion")) {
    await showTab(page, "Battle");
    await page.click('.sb-mode-btn[data-mode="champion"]');
    await wait(2500);
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => {
        const cards = [...document.querySelectorAll(".sb-scene-card")];
        const champ = cards.find((c) => c.querySelector("[class*=badge]") && /win/.test(c.textContent)) || cards[0];
        champ.querySelector(".sb-choose-btn").click();
      });
      await wait(2600);
    }
    await page.evaluate(() => window.__sbAB());
    await away();
    await wait(600);
    await shot("champion");
  }

  // Placement: an unrated scene, three picks in
  if (want("placement")) {
    await showTab(page, "Battle");
    await page.click('.sb-mode-btn[data-mode="placement"]');
    await wait(2500);
    const leftRank = () => page.evaluate(() => document.querySelector('.sb-scene-card[data-side="left"] .sb-scene-rank')?.textContent || "");
    for (let i = 0; i < 25 && !/Unrated/.test(await leftRank()); i++) {
      await page.click("#sb-skip-btn");
      await wait(1400);
    }
    for (const side of ["left", "right", "left"]) {
      const sel = `.sb-scene-card[data-side="${side}"] .sb-choose-btn`;
      if (!(await page.$(sel))) break;
      await page.click(sel);
      await wait(2000);
    }
    await page.evaluate(() => window.__sbAB());
    await away();
    await wait(600);
    await shot("placement");
  }

  refused += run.stats.refused;
  errors.push(...run.errors);
  await run.browser.close();
}

// ---------- the first-run setup (the config is answered without eloSetupAt) ----------

if (want("setup")) {
  const run = await launch({ mode: "real", hideSetupDone: true, viewport: { width: 1040, height: 1100 } });
  const { page } = run;
  await openStashBattle(page);
  await page.waitForFunction(() => document.querySelectorAll('#sb-modal input[type="radio"]').length > 0, null, { timeout: 30000 });
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    // The library already has ELO, so "an earlier setup didn't finish" shows; a first run wouldn't have it
    document.querySelectorAll("#sb-modal .sb-setup-warning").forEach((el) => (el.style.display = "none"));
    for (const v of ["ratings", "linear"]) document.querySelector(`#sb-modal input[type="radio"][value="${v}"]`)?.click();
  });
  await page.waitForTimeout(1500);
  await page.mouse.move(1035, 5);
  const r = await page.evaluate(() => {
    const b = document.querySelector(".sb-modal-content").getBoundingClientRect();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  });
  await page.screenshot({ path: path.join(OUT, "setup.png"), clip: { x: r.x - 2, y: r.y - 2, width: r.width + 4, height: Math.min(r.height + 4, 1100 - r.y + 2) } });
  console.log("saved setup");
  refused += run.stats.refused;
  errors.push(...run.errors);
  await run.browser.close();
}

// ---------- a scene page's ELO button (everything else on the page hidden) ----------

/** A scene with a tier (settled: seeded, or 10+ battles) and a record, near the top of the library. */
async function showcaseSceneId() {
  const res = await fetch(`${STASH_URL}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: `{ findScenes(filter:{per_page:-1}) { scenes { id custom_fields } } }` }),
  });
  const { data } = await res.json();
  const num = (v) => (v === undefined || v === null || v === "" ? null : Number(v));
  const rated = data.findScenes.scenes.filter((s) => num(s.custom_fields?.stash_battle_elo) !== null);
  rated.sort((a, b) => num(b.custom_fields.stash_battle_elo) - num(a.custom_fields.stash_battle_elo));
  const settled = (cf) => [true, 1, "1", "true"].includes(cf.stash_battle_seeded) || num(cf.stash_battle_battles) >= 10;
  const pick = rated.slice(8, 60).find((s) => settled(s.custom_fields) && num(s.custom_fields.stash_battle_wins) >= 1) ?? rated[0];
  return pick.id;
}

/** Show only `selector`'s element (the scene's title, cover and video stay hidden) and screenshot it. */
async function scenePageShot(page, selector, name, pad) {
  await page.addStyleTag({
    content: `#root ${selector}, #root ${selector} * { visibility: visible !important; } #root ${selector} { background: #202b33; }`,
  });
  await page.waitForTimeout(400);
  const r = await page.evaluate((sel) => {
    const b = document.querySelector(sel).getBoundingClientRect();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  }, selector);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), clip: { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.width + pad * 2, height: r.height + pad * 2 } });
  console.log("saved", name);
}

if (want("scene-page") || want("phone-scene-page")) {
  const id = await showcaseSceneId();
  for (const phone of [false, true]) {
    const name = phone ? "phone-scene-page" : "scene-page";
    if (!want(name)) continue;
    const run = await launch({ mode: "real", phone, viewport: { width: 1280, height: 900 } });
    const { page } = run;
    await page.goto(`${STASH_URL}/scenes/${id}`);
    await page.waitForFunction(() => /ELO \d/.test(document.querySelector(".sb-scene-elo-value")?.textContent || ""), null, { timeout: 30000 });
    await page.waitForTimeout(800);
    // Wide screens: the button sits in the toolbar; phones: it leads the line under the title
    await scenePageShot(page, phone ? ".scene-subheader" : ".scene-toolbar", name, phone ? 6 : 10);
    refused += run.stats.refused;
    errors.push(...run.errors);
    await run.browser.close();
  }
}

// ---------- phone (393 x 852, touch, 3x) ----------

const phone = ["phone-battle", "phone-explore", "phone-stats"].filter(want);
if (phone.length) {
  const run = await launch({ mode: "real", phone: true });
  const { page } = run;
  const wait = (ms) => page.waitForTimeout(ms);
  const shot = async (name) => {
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    console.log("saved", name);
  };
  await openStashBattle(page);
  await page.waitForFunction(() => document.querySelectorAll(".sb-scene-card").length === 2, null, { timeout: 30000 });
  await wait(1500);

  if (want("phone-battle")) {
    await findShowcasePair(page, wait);
    await page.evaluate(() => window.__sbAB());
    await wait(600);
    await shot("phone-battle");
  }
  if (want("phone-explore")) {
    await showTab(page, "Explore");
    await sortExplore(page, "record-desc");
    await wait(400);
    await shot("phone-explore");
  }
  if (want("phone-stats")) {
    await page.evaluate(() => window.__sbResetTitles());
    await showTab(page, "Stats");
    await shot("phone-stats");
  }
  refused += run.stats.refused;
  errors.push(...run.errors);
  await run.browser.close();
}

// ---------- Stash must be exactly as before ----------

const diff = snapshotDiff(before, await stashSnapshot());
console.log(`writes refused: ${refused}; scenes changed: ${diff.changed.length}; config same: ${diff.configSame}; ${diff.count} scenes`);
if (errors.length) console.log("page errors:\n  " + errors.join("\n  "));
if (diff.changed.length || !diff.configSame) {
  console.error(`Stash changed during the run: scenes ${diff.changed.join(", ")}`);
  process.exit(1);
}
