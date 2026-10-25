// The 📊 Stats tab: overview numbers, the ELO distribution (with the Stash rating scale under it),
// hidden gems / overplayed, and how settled the rankings are. Worked out from Stash Battle's
// all-scenes cache each time the tab opens; no extra requests. Charts are hand-drawn SVG sized to
// the panel (redrawn when the window resizes). Clicking a histogram bar opens Explore at its ELO
// range; hovering a hidden gems dot shows the scene's small card, and clicking opens its page.

import { getAllScenesCached } from "../cache";
import { ELO_K_TIERS } from "../constants";
import { exploreEntries, type ExploreEntry, type ExploreFilters } from "../explore";
import { navigateToUrl } from "../navigation";
import { leastTestedSource } from "../pairs";
import { formatRating, scaleMarks } from "../ratingDisplay";
import { elo } from "../score";
import { isEloSetupPending, state } from "../state";
import {
  eloHistogram,
  gemsSplit,
  largestTie,
  leastTestedPool,
  overview,
  ratingScaleTicks,
  settledBuckets,
  tierMap,
  type GemsSplit,
} from "../stats";
import type { Scene } from "../types";
import { handleSceneLinkClick, isTouchDevice } from "./mainUI";
import { miniCardHtml, plural, sceneUrl } from "./miniCard";
import { resolveSceneTitle } from "../sceneTitle";
import { stashRatingsOption } from "./stashRatingsText";

/** What the tab's buttons do (the modal owns modes, tabs and pairs). */
export interface StatsActions {
  battleScene: (sceneId: string) => void;
  battleLeastTested: () => void;
  exploreRange: (eloMin: number, eloMax: number) => void;
  /** Battle an Explore filter's scenes (`label` names it in the note above the cards). */
  battleFilter: (filters: ExploreFilters, label: string) => void;
}

/** ELO per histogram bar; narrow screens get wider bars (easier to tap). */
const BUCKET_SIZE = 25;
const NARROW_BUCKET_SIZE = 50;
const NARROW_CHART_PX = 500;
/** A tie at least this big gets a note under the distribution. */
const TIE_NOTE_MIN = 10;
/** Play counts marked on the hidden gems chart's square-root axis (those up to the maximum). */
const PLAY_TICKS = [0, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];

let scenes: Scene[] = [];
/** Scene id to its small-card entry (rank, tier), for the hover cards. */
let entriesById = new Map<string, ExploreEntry>();
let actions: StatsActions | null = null;
let resizeBound = false;

export function createStatsTab(): string {
  return `
      <div class="sb-tab-panel sb-stats-tab" data-panel="stats" hidden>
        <div id="sb-stats-content"></div>
      </div>
    `;
}

/** 1, 2 or 5 times a power of ten, at least `rough`. */
function niceStep(rough: number): number {
  const power = Math.pow(10, Math.floor(Math.log10(Math.max(rough, 1))));
  for (const m of [1, 2, 5, 10]) if (m * power >= rough) return m * power;
  return 10 * power;
}

/** A bar with rounded top corners, anchored to the baseline. */
function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(3, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function section(title: string, body: string, id = ""): string {
  return `
        <div class="setting-section sb-stats-section"${id ? ` id="${id}"` : ""}>
          <h1>${title}</h1>
          <div class="card">${body}</div>
        </div>`;
}

// ---------- Overview ----------

function overviewHtml(): string {
  const o = overview(scenes);
  const tile = (value: number, label: string, tip: string): string =>
    `<div class="sb-stat-tile" title="${tip}"><div class="sb-stat-value">${value.toLocaleString()}</div><div class="sb-stat-label">${label}</div></div>`;
  return `<div class="sb-stat-tiles">
          ${tile(o.rated, "Scenes with an ELO", "Scenes Stash Battle has an ELO for")}
          ${tile(o.unrated, "Unrated", "Scenes with no ELO yet: they get one after their first battle, or from Placement")}
          ${tile(o.provisional, "Provisional", `Fewer than ${ELO_K_TIERS[0][0]} battles, so their ELO is still settling (shown with a “?”)`)}
          ${tile(o.battles, "Battles", "Every scene's battle count added up, so a battle counts once for each scene in it")}
        </div>`;
}

// ---------- ELO distribution ----------

function histogramSvg(width: number): string {
  const size = width < NARROW_CHART_PX ? NARROW_BUCKET_SIZE : BUCKET_SIZE;
  const buckets = eloHistogram(scenes, size);
  if (buckets.length === 0) return "";
  const mode = state.settings.stashRatings;
  const ticks = ratingScaleTicks(scenes, mode, scaleMarks());

  let lo = buckets[0].from;
  let hi = buckets[buckets.length - 1].from + size;
  for (const t of ticks) {
    lo = Math.min(lo, Math.floor(t.elo / size) * size);
    hi = Math.max(hi, Math.ceil((t.elo + 1) / size) * size);
  }

  const m = { left: 40, right: 12, top: 10 };
  const plotW = width - m.left - m.right;
  const plotH = width < 500 ? 120 : 170;
  const axisH = 22;
  const scaleH = ticks.length > 0 ? 46 : 0;
  const height = m.top + plotH + axisH + scaleH;
  const x = (value: number): number => m.left + ((value - lo) / (hi - lo)) * plotW;
  const maxCount = Math.max(...buckets.map((b) => b.count));
  const step = niceStep(maxCount / 3);
  const yMax = Math.max(step, Math.ceil(maxCount / step) * step);
  const y = (count: number): number => m.top + plotH - (count / yMax) * plotH;
  const base = m.top + plotH;

  const parts: string[] = [];

  // Straight-line clamps: everything below 1010 is a 1, everything above 2000 a 100
  if (mode === "linear" && ticks.length > 0) {
    const first = ticks[0];
    const last = ticks[ticks.length - 1];
    if (lo < first.elo) {
      parts.push(
        `<rect class="sb-chart-clamp" x="${x(lo)}" y="${m.top}" width="${x(first.elo) - x(lo)}" height="${plotH}" data-tip="Below ${first.elo}, every ELO is a Stash rating of ${formatRating(first.rating, true)}"/>`,
      );
    }
    if (hi > last.elo) {
      parts.push(
        `<rect class="sb-chart-clamp" x="${x(last.elo)}" y="${m.top}" width="${x(hi) - x(last.elo)}" height="${plotH}" data-tip="Above ${last.elo}, every ELO is a Stash rating of ${formatRating(last.rating, true)}"/>`,
      );
    }
  }

  for (let v = 0; v <= yMax; v += step) {
    parts.push(`<line class="sb-chart-grid" x1="${m.left}" x2="${width - m.right}" y1="${y(v)}" y2="${y(v)}"/>`);
    parts.push(`<text class="sb-chart-label" x="${m.left - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`);
  }

  for (const b of buckets) {
    const x0 = x(b.from);
    const w = x(b.from + size) - x0;
    const tip = `ELO ${b.from}–${b.from + size - 1}: ${plural(b.count, "scene")}`;
    const bar = b.count > 0 ? `<path class="sb-chart-bar" d="${barPath(x0 + 1, y(b.count), Math.max(1, w - 2), base - y(b.count))}"/>` : "";
    parts.push(`<g class="sb-chart-hit" data-tip="${tip}${b.count ? " · click to see them" : ""}" data-from="${b.from}" data-to="${b.from + size - 0.1}"><rect x="${x0}" y="${m.top}" width="${w}" height="${plotH}" fill="transparent"/>${bar}</g>`);
  }
  parts.push(`<line class="sb-chart-axis" x1="${m.left}" x2="${width - m.right}" y1="${base}" y2="${base}"/>`);

  const labelStep = plotW / ((hi - lo) / 100) >= 44 ? 100 : 200;
  for (let v = Math.ceil(lo / labelStep) * labelStep; v <= hi; v += labelStep) {
    parts.push(`<text class="sb-chart-label" x="${x(v)}" y="${base + 16}" text-anchor="middle">${v}</text>`);
  }

  if (ticks.length > 0) {
    const top = base + axisH;
    const lineY = top + 20;
    parts.push(`<text class="sb-chart-caption" x="${m.left}" y="${top + 10}">Stash rating (${stashRatingsOption(mode).label})</text>`);
    parts.push(`<line class="sb-chart-scale" x1="${x(ticks[0].elo)}" x2="${x(ticks[ticks.length - 1].elo)}" y1="${lineY}" y2="${lineY}"/>`);
    for (const t of ticks) {
      parts.push(`<line class="sb-chart-scale" x1="${x(t.elo)}" x2="${x(t.elo)}" y1="${lineY - 4}" y2="${lineY + 4}"/>`);
      parts.push(
        `<text class="sb-chart-label sb-chart-scale-label" x="${x(t.elo)}" y="${lineY + 18}" text-anchor="middle" data-tip="Stash rating ${formatRating(t.rating, true)} at ELO ${Math.round(t.elo)}">${formatRating(t.rating)}</text>`,
      );
    }
  }

  return `<svg class="sb-chart-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="How many scenes have each ELO">${parts.join("")}</svg>`;
}

function distributionNote(): string {
  const notes: string[] = [];
  const tie = largestTie(scenes);
  if (tie && tie.count >= TIE_NOTE_MIN) {
    notes.push(`${tie.count} scenes are still tied at ELO ${Math.round(tie.elo)}. Battles break ties up.`);
  }
  if (state.settings.stashRatings === "off") {
    notes.push("Stash ratings aren't being updated, so there's no rating scale under the chart.");
  } else if (state.settings.stashRatings === "percentile") {
    notes.push("Percentile spreads ratings across the whole scale by rank, so the scale follows your library.");
  }
  return notes.length ? `<p class="sb-stats-note">${notes.join(" ")}</p>` : "";
}

// ---------- Hidden gems / overplayed ----------

/** Small fixed offset per scene, so scenes with the same ELO and play count don't hide each other. */
function jitter(id: string, range: number): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return ((Math.abs(hash) % 1000) / 1000 - 0.5) * 2 * range;
}

function scatterSvg(width: number, split: GemsSplit): string {
  const rated = scenes
    .map((scene) => ({ scene, elo: elo(scene) }))
    .filter((s): s is { scene: Scene; elo: number } => s.elo !== null);
  if (rated.length < 2) return "";

  const m = { left: 44, right: 14, top: 12, bottom: 34 };
  const height = width < 500 ? 260 : 340;
  const plotW = width - m.left - m.right;
  const plotH = height - m.top - m.bottom;
  const maxPlays = Math.max(1, ...rated.map((s) => s.scene.play_count ?? 0));
  const elos = rated.map((s) => s.elo);
  const lo = Math.floor((Math.min(...elos) - 1) / 100) * 100;
  const hi = Math.ceil((Math.max(...elos) + 1) / 100) * 100;
  const x = (plays: number): number => m.left + (Math.sqrt(plays) / Math.sqrt(maxPlays)) * plotW;
  const y = (value: number): number => m.top + ((hi - value) / (hi - lo)) * plotH;
  const base = m.top + plotH;

  const parts: string[] = [];
  const eloStep = plotH / ((hi - lo) / 100) >= 26 ? 100 : 200;
  for (let v = Math.ceil(lo / eloStep) * eloStep; v <= hi; v += eloStep) {
    parts.push(`<line class="sb-chart-grid" x1="${m.left}" x2="${width - m.right}" y1="${y(v)}" y2="${y(v)}"/>`);
    parts.push(`<text class="sb-chart-label" x="${m.left - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`);
  }
  let lastTickX = -Infinity;
  for (const plays of PLAY_TICKS.filter((p) => p <= maxPlays)) {
    if (x(plays) - lastTickX < 30) continue;
    lastTickX = x(plays);
    parts.push(`<text class="sb-chart-label" x="${x(plays)}" y="${base + 16}" text-anchor="middle">${plays}</text>`);
  }
  parts.push(`<line class="sb-chart-axis" x1="${m.left}" x2="${width - m.right}" y1="${base}" y2="${base}"/>`);
  parts.push(`<text class="sb-chart-caption" x="${width - m.right}" y="${base + 30}" text-anchor="end">Play count →</text>`);
  parts.push(`<text class="sb-chart-caption" x="${m.left + 6}" y="${m.top + plotH / 2}" transform="rotate(-90 ${m.left - 32} ${m.top + plotH / 2})" text-anchor="middle" dx="-38">ELO</text>`);

  // Quadrant lines at the medians, and the two quadrants that mean something
  parts.push(`<line class="sb-chart-split" x1="${x(split.plays)}" x2="${x(split.plays)}" y1="${m.top}" y2="${base}"/>`);
  parts.push(`<line class="sb-chart-split" x1="${m.left}" x2="${width - m.right}" y1="${y(split.elo)}" y2="${y(split.elo)}"/>`);

  for (const { scene, elo: value } of rated) {
    const plays = scene.play_count ?? 0;
    // Play counts are whole numbers: spread each column over part of the gap to the next one
    // (only rightwards at 0, which sits on the axis)
    const spread = Math.max(3, (x(plays + 1) - x(plays)) * 0.3);
    const offset = plays === 0 ? Math.abs(jitter(scene.id, spread)) : jitter(scene.id, spread);
    const cx = Math.min(width - m.right, x(plays) + offset);
    const cy = y(value) + jitter(`${scene.id}y`, 2);
    parts.push(`<circle class="sb-dot" cx="${cx}" cy="${cy}" r="4" data-id="${scene.id}"/>`);
  }
  // Labels last, on top of the dots
  parts.push(`<text class="sb-chart-quadrant" x="${m.left + 8}" y="${m.top + 16}">💎 Hidden gems</text>`);
  parts.push(`<text class="sb-chart-quadrant" x="${width - m.right - 8}" y="${base - 10}" text-anchor="end">Overplayed</text>`);

  return `<svg class="sb-chart-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="ELO against play count">${parts.join("")}</svg>`;
}

// ---------- How settled ----------

/** The least-tested pool's scenes (the Scenes page filter's, or the whole library), set on render. */
let leastTestedScenes: Scene[] = [];
let leastTestedFiltered = false;

/** What "least tested" means and who's in it now (the button carries the total). */
function leastTestedText(): string {
  const pool = leastTestedPool(leastTestedScenes);
  if (!pool) return "";
  const rated = pool.count - pool.unrated;
  const who =
    pool.battles === 0
      ? `${plural(pool.count, "scene")} have no battles yet: ${rated} with an ELO (the “No battles yet” bar) and ${pool.unrated} unrated.`
      : `The fewest battles any scene has is ${pool.battles}, and ${plural(pool.count, "scene")} have that many.`;
  const where = leastTestedFiltered ? " (from your Scenes page filter)" : "";
  return `${who}${where} They go on the left first, in Swiss, until you stop it.`;
}

function settledHtml(): string {
  const buckets = settledBuckets(scenes);
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const label = (min: number, max: number | null): string => {
    if (max === 0) return "No battles yet";
    if (max === null) return `${min}+ battles`;
    return `${min}–${max} battles`;
  };
  const rows = buckets
    .map(
      (b) => `
          <div class="sb-settled-row" title="${plural(b.count, "scene")} with ${label(b.min, b.max).toLowerCase()}">
            <span class="sb-settled-label">${label(b.min, b.max)}</span>
            <span class="sb-settled-track"><span class="sb-settled-bar" style="width: ${(b.count / max) * 100}%"></span></span>
            <span class="sb-settled-count">${b.count}</span>
          </div>`,
    )
    .join("");
  const { provisional } = overview(scenes);
  const provisionalText =
    provisional > 0
      ? `<strong>${plural(provisional, "scene")}</strong> ${provisional === 1 ? "is" : "are"} still provisional: fewer than ${ELO_K_TIERS[0][0]} battles, so ${provisional === 1 ? "its" : "their"} ELO still moves a lot with each battle.`
      : `No scene is provisional. Scenes seeded from your star ratings start with a ${ELO_K_TIERS[0][0]}-battle head start, so only scenes that started without one can be.`;
  return `
          <div class="sb-settled">${rows}</div>
          <p class="sb-stats-note">${provisionalText}</p>
          <div class="sb-stats-actions">
            <button type="button" class="btn btn-secondary btn-sm" data-stats-action="least-tested">Battle the least-tested (${plural(leastTestedPool(leastTestedScenes)?.count ?? 0, "scene")})</button>
            <span class="sb-stats-muted">${leastTestedText()}</span>
          </div>`;
}

// ---------- Rendering and events ----------

function drawCharts(root: HTMLElement): void {
  const histogram = root.querySelector<HTMLElement>("#sb-stats-histogram");
  if (histogram) histogram.innerHTML = histogramSvg(histogram.clientWidth) + '<div class="sb-chart-tip" hidden></div>';
  const scatter = root.querySelector<HTMLElement>("#sb-stats-scatter");
  const split = gemsSplit(scenes);
  if (scatter && split) scatter.innerHTML = scatterSvg(scatter.clientWidth, split) + '<div class="sb-chart-tip" hidden></div>';
}

/**
 * Where a chart tooltip goes, kept inside the chart: a text tip above the pointer; a hover card
 * beside it (right, or left near the right edge), level with the pointer, so it never hangs below
 * the chart or covers the dot.
 */
function placeTip(chart: HTMLElement, tip: HTMLElement, at: { clientX: number; clientY: number }, card: boolean): void {
  const box = chart.getBoundingClientRect();
  const x = at.clientX - box.left;
  const y = at.clientY - box.top;
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  const clamp = (value: number, max: number): number => Math.max(0, Math.min(value, max));
  if (card) {
    const left = x + 16 + w <= box.width ? x + 16 : x - 16 - w;
    tip.style.left = `${clamp(left, box.width - w)}px`;
    tip.style.top = `${clamp(y - h / 2, box.height - h)}px`;
    return;
  }
  const above = y - h - 12;
  tip.style.left = `${clamp(x + 14, box.width - w - 4)}px`;
  tip.style.top = `${above >= 0 ? above : y + 18}px`;
}


/**
 * Hover tooltips inside a chart: the text of an element's data-tip, or, over a hidden gems dot,
 * the scene's small card.
 */
function bindTooltips(chart: HTMLElement): void {
  const show = (e: PointerEvent): void => {
    const tip = chart.querySelector<HTMLElement>(".sb-chart-tip");
    if (!tip || isTouchDevice()) return;
    const target = e.target as Element;
    const dot = target.closest<SVGElement>(".sb-dot");
    const entry = dot?.dataset.id ? entriesById.get(dot.dataset.id) : undefined;
    if (entry) {
      // Kept on the tip itself: a redraw (resize) replaces the tip with an empty one
      if (tip.dataset.cardFor !== entry.scene.id) {
        tip.dataset.cardFor = entry.scene.id;
        tip.innerHTML = miniCardHtml(entry, false);
      }
      tip.classList.add("sb-chart-tip-card");
    } else {
      const text = target.closest("[data-tip]")?.getAttribute("data-tip");
      if (!text) {
        delete tip.dataset.cardFor;
        tip.hidden = true;
        return;
      }
      delete tip.dataset.cardFor;
      tip.classList.remove("sb-chart-tip-card");
      tip.textContent = text;
    }
    tip.hidden = false;
    placeTip(chart, tip, e, Boolean(entry));
  };
  chart.addEventListener("pointermove", show);
  // (A tap on a phone also ends in "pointerleave"; a pinned card stays until another tap)
  chart.addEventListener("pointerleave", () => {
    const tip = chart.querySelector<HTMLElement>(".sb-chart-tip");
    if (!tip || tip.classList.contains("sb-chart-tip-pinned")) return;
    tip.hidden = true;
    delete tip.dataset.cardFor;
  });
}

/** Open a scene's page (in a new tab with "Open scenes in a new tab", like the battle cards). */
function openScene(sceneId: string, e: MouseEvent): void {
  const url = sceneUrl(sceneId);
  if (state.settings.openInNewTab || e.ctrlKey || e.metaKey || e.shiftKey) window.open(url, "_blank", "noopener");
  else navigateToUrl(url);
}

/**
 * Touch: a tapped dot's card, pinned beside it, with a link to the scene and a ⚔️ button. A tap
 * anywhere else in the chart closes it.
 */
function pinCard(dot: SVGElement, entry: ExploreEntry): void {
  pinTip(dot, miniCardHtml(entry), true);
}

/** Pin `html` in the chart's tooltip next to `anchor` (a tapped dot or bar), until another tap. */
function pinTip(anchor: Element, html: string, card: boolean): void {
  const chart = anchor.closest<HTMLElement>(".sb-chart");
  const tip = chart?.querySelector<HTMLElement>(".sb-chart-tip");
  if (!chart || !tip) return;
  tip.innerHTML = html;
  tip.classList.toggle("sb-chart-tip-card", card);
  tip.classList.add("sb-chart-tip-pinned");
  tip.hidden = false;
  const r = anchor.getBoundingClientRect();
  placeTip(chart, tip, { clientX: r.left + r.width / 2, clientY: r.top + Math.min(r.height / 2, 40) }, card);
}

function unpinCard(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>(".sb-chart-tip-pinned").forEach((tip) => {
    tip.classList.remove("sb-chart-tip-pinned");
    tip.hidden = true;
  });
}

/** Clicks in the tab: histogram bars, hidden gems dots (and their pinned cards) and the buttons. */
function onContentClick(e: MouseEvent): void {
  const target = e.target as Element;
  const root = e.currentTarget as HTMLElement;
  if (!actions) return;
  // A pinned tip (touch): a card's ⚔️ battles the scene and the rest opens the scene's page; a
  // bar's button opens Explore at its range
  if (target.closest(".sb-chart-tip-pinned")) {
    const battle = target.closest<HTMLElement>("[data-battle]");
    const link = target.closest<HTMLAnchorElement>(".sb-mini-link");
    const explore = target.closest<HTMLElement>("[data-explore-from]");
    if (battle?.dataset.battle) actions.battleScene(battle.dataset.battle);
    else if (link) handleSceneLinkClick(e, link);
    else if (explore) actions.exploreRange(Number(explore.dataset.exploreFrom), Number(explore.dataset.exploreTo));
    return;
  }
  const bar = target.closest<SVGElement>("[data-from]");
  if (bar?.dataset.from && bar.querySelector(".sb-chart-bar")) {
    // data-to ends a tenth below the next bar (ELO is stored to one decimal), so it covers the bar
    const from = Number(bar.dataset.from);
    const to = Number(bar.dataset.to);
    if (isTouchDevice()) {
      // Bars are thin on a phone: say what was tapped, and explore from a proper button
      const text = (bar.dataset.tip ?? "").replace(/ · click to see them$/, "");
      pinTip(bar, `<div class="sb-chart-tip-text">${text}</div><button type="button" class="btn btn-primary btn-sm" data-explore-from="${from}" data-explore-to="${to}">🔎 See them in Explore</button>`, false);
      return;
    }
    unpinCard(root);
    actions.exploreRange(from, to);
    return;
  }
  const dot = target.closest<SVGElement>(".sb-dot");
  const entry = dot?.dataset.id ? entriesById.get(dot.dataset.id) : undefined;
  if (dot && entry && isTouchDevice()) {
    pinCard(dot, entry);
    return;
  }
  unpinCard(root);
  if (dot?.dataset.id) {
    openScene(dot.dataset.id, e);
    return;
  }
  if (target.closest("[data-stats-action='least-tested']")) actions.battleLeastTested();
}

function bindEvents(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>(".sb-chart").forEach(bindTooltips);

  // The content element outlives each render, so its click handler is bound once
  if (root.dataset.bound !== "1") {
    root.dataset.bound = "1";
    root.addEventListener("click", onContentClick);
  }

  if (!resizeBound) {
    resizeBound = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    window.addEventListener("resize", () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const panel = document.querySelector<HTMLElement>('#sb-modal .sb-stats-tab:not([hidden])');
        if (panel && scenes.length > 0) drawCharts(panel);
      }, 150);
    });
  }
}

/** Fill the Stats tab from the all-scenes cache (call each time the tab opens). */
export async function renderStatsTab(modal: HTMLElement, statsActions: StatsActions): Promise<void> {
  actions = statsActions;
  const panel = modal.querySelector<HTMLElement>(".sb-stats-tab");
  const content = modal.querySelector<HTMLElement>("#sb-stats-content");
  if (!panel || !content) return;

  if (isEloSetupPending()) {
    content.innerHTML = `<p class="sb-stats-empty">Stats show once the ELO setup on the Battle tab is done.</p>`;
    return;
  }
  if (!content.querySelector(".sb-stats-section")) content.innerHTML = `<div class="sb-loading">Loading stats...</div>`;

  try {
    scenes = (await getAllScenesCached()).scenes ?? [];
  } catch (e) {
    console.error("[Stash Battle] Couldn't load scenes for stats:", e);
    content.innerHTML = `<p class="sb-stats-empty">Couldn't load your scenes. Switch tabs to try again.</p>`;
    return;
  }
  try {
    ({ scenes: leastTestedScenes, filtered: leastTestedFiltered } = await leastTestedSource());
  } catch {
    leastTestedScenes = scenes;
    leastTestedFiltered = false;
  }
  if (!scenes.some((s) => elo(s) !== null)) {
    content.innerHTML = `<p class="sb-stats-empty">No scene has an ELO yet.</p>`;
    return;
  }
  const tiers = tierMap(scenes);
  entriesById = new Map(exploreEntries(scenes, tiers, resolveSceneTitle).map((entry) => [entry.scene.id, entry]));

  content.innerHTML = [
    section("Overview", overviewHtml()),
    section("How settled the rankings are", settledHtml()),
    section(
      "ELO distribution",
      `<div class="sb-chart" id="sb-stats-histogram"></div>${distributionNote()}<p class="sb-stats-note">Click a bar to see its scenes in Explore.</p>`,
    ),
    section(
      "Hidden gems and overplayed",
      `<p class="sb-stats-note sb-stats-intro">Each dot is a scene: higher is a better ELO, further right is played more. The dashed lines are the middle of your library. Hover a dot to see the scene; click it to open it.</p>
          <div class="sb-chart" id="sb-stats-scatter"></div>`,
    ),
  ].join("");
  drawCharts(panel);
  bindEvents(content);
}
