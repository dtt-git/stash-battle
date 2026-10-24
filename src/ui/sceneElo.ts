// The scene's ELO and rank on Stash's own scene page, as one more item in the toolbar next to
// Play Count and O Count: a single Stash "minimal" button (icon and text highlight together).
// With a tier, the button's icon is the tier's emoji (💎) instead of the swords. On phones the
// toolbar has no room for it (it made the page scroll sideways), so it leads the subheader line
// instead: "💎 ELO 1990 · #25 | 60 fps | 4K".
//
// Stash's ScenePage isn't a patchable component, so the item is added to the DOM and re-added
// whenever React re-renders the toolbar. The rank comes from Stash Battle's all-scenes cache, the
// same place the battle cards get theirs (Stash can't count scenes by a numeric custom field).

import { getAllScenesCached } from "../cache";
import { fetchSceneById, getSceneIdFromUrl, sceneCustomFieldsSupported } from "../graphql";
import { elo, isProvisional, isRated } from "../score";
import { cachedTierMap, tierDescription } from "../stats";
import type { Scene, Tier } from "../types";
import { SWORDS_PATHS } from "./icons";
import { PROVISIONAL_TIP } from "./sceneCard";

const ITEM_CLASS = "sb-scene-elo";
/** Below this width the item goes in the subheader line instead of the toolbar. */
const NARROW_QUERY = "(max-width: 576px)";
const TITLE = "Stash Battle ELO, and rank in your library. Click to battle this scene.";

/** "ELO 1740 · #50" (a "?" after a provisional ELO), or "ELO · Unrated" for a scene with no ELO yet. */
function labelText(scene: Scene, rank: number | null): string {
  const value = elo(scene);
  if (value === null) return "ELO · Unrated";
  return `ELO ${Math.round(value)}${isProvisional(scene) ? "?" : ""}${rank !== null ? ` · #${rank}` : ""}`;
}

/** The button's tooltip, with the provisional note and the tier added. */
function titleText(scene: Scene, tier: Tier | null): string {
  const lines = [TITLE];
  if (isProvisional(scene)) lines.push(PROVISIONAL_TIP);
  if (tier) lines.push(`${tier.emoji} ${tierDescription(tier)}`);
  return lines.join("\n");
}

/**
 * The scene (from the cache, or fetched if it's newer than the cache), its rank among rated
 * scenes and its tier.
 */
async function sceneAndRank(sceneId: string): Promise<{ scene: Scene; rank: number | null; tier: Tier | null } | null> {
  const { scenes } = await getAllScenesCached();
  // The cache is sorted by ELO with unrated scenes last, so a rated scene's index is its rank
  const index = scenes.findIndex((s) => s.id === sceneId);
  if (index >= 0) {
    const scene = scenes[index];
    return { scene, rank: isRated(scene) ? index + 1 : null, tier: cachedTierMap(scenes).get(sceneId) ?? null };
  }
  const scene = await fetchSceneById(sceneId);
  return scene ? { scene, rank: null, tier: null } : null;
}

/** Opens Stash Battle (on a scene page, with this scene in the battle). Set by registerSceneElo. */
let openBattle: () => void = () => {};

const SWORDS_ICON = `<svg class="svg-inline--fa fa-icon" aria-hidden="true" focusable="false" viewBox="0 0 36 36" width="1em" height="1em">${SWORDS_PATHS}</svg>`;

/** The button's icon: the tier's emoji, or the swords for a scene without one (provisional or unrated). */
function iconHtml(tier: Tier | null): string {
  return tier ? `<span class="sb-scene-elo-emoji" aria-hidden="true">${tier.emoji}</span>` : SWORDS_ICON;
}

/** One Stash "minimal" button with an icon and the ELO, so it hovers as a whole. */
function createItem(): HTMLElement {
  const item = document.createElement("span");
  item.className = ITEM_CLASS;
  item.innerHTML = `
      <button type="button" class="minimal btn btn-secondary sb-scene-elo-button" title="${TITLE}">
        <span class="sb-scene-elo-icon">${SWORDS_ICON}</span>
        <span class="sb-scene-elo-value"></span>
      </button>`;
  item.querySelector("button")?.addEventListener("click", () => openBattle());
  return item;
}

/**
 * Where the item goes: on phones, first in the subheader (date, frame rate, resolution); otherwise
 * in front of Play Count in the toolbar. Returns false when that part of the page isn't there yet.
 */
function placeItem(item: HTMLElement): boolean {
  if (window.matchMedia(NARROW_QUERY).matches) {
    const subheader = document.querySelector(".scene-subheader");
    if (!subheader) return false;
    if (subheader.firstElementChild !== item) subheader.prepend(item);
    item.classList.add("sb-scene-elo-sub");
    return true;
  }
  item.classList.remove("sb-scene-elo-sub");
  const toolbar = document.querySelector(".scene-toolbar");
  if (!toolbar) return false;
  if (toolbar.contains(item)) return true;
  const playCount = toolbar.querySelector('button[title="Play Count"]')?.closest(".scene-toolbar-group > *");
  if (playCount) {
    playCount.before(item);
    return true;
  }
  const group = toolbar.querySelector(".scene-toolbar-group:last-child");
  if (!group) return false;
  group.prepend(item);
  return true;
}

/** The item is on the page for this scene, in the right place for the screen width. */
function isPlaced(item: HTMLElement | null, sceneId: string): boolean {
  if (item?.dataset.sceneId !== sceneId) return false;
  return window.matchMedia(NARROW_QUERY).matches ? Boolean(item.closest(".scene-subheader")) : Boolean(item.closest(".scene-toolbar"));
}

let rendering: string | null = null;

/** Add (or update) the item on the current scene page. Safe to call often. */
async function renderSceneElo(force = false): Promise<void> {
  const sceneId = getSceneIdFromUrl();
  if (!sceneId || !document.querySelector(".scene-toolbar, .scene-subheader")) return;
  if (!force && isPlaced(document.querySelector<HTMLElement>(`.${ITEM_CLASS}`), sceneId)) return;
  if (rendering === sceneId) return;

  rendering = sceneId;
  try {
    if (!(await sceneCustomFieldsSupported())) return;
    const result = await sceneAndRank(sceneId);
    // The page may have moved on (another scene, or the toolbar re-rendered) while this loaded
    if (!result || getSceneIdFromUrl() !== sceneId) return;

    const item = document.querySelector<HTMLElement>(`.${ITEM_CLASS}`) ?? createItem();
    if (!placeItem(item)) return;
    item.dataset.sceneId = sceneId;
    const value = item.querySelector(".sb-scene-elo-value");
    if (value) value.textContent = labelText(result.scene, result.rank);
    item.querySelector("button")?.setAttribute("title", titleText(result.scene, result.tier));
    const icon = item.querySelector(".sb-scene-elo-icon");
    if (icon) icon.innerHTML = iconHtml(result.tier);
  } catch (e) {
    console.warn("[Stash Battle] Couldn't show the scene's ELO:", e);
  } finally {
    rendering = null;
  }
}

/** Refresh the item from the cache (after battles change ELO). */
export function refreshSceneElo(): void {
  void renderSceneElo(true);
}

/**
 * Show the ELO item on scene pages, re-adding it as Stash navigates and re-renders; clicking it
 * calls `onClick` (opens Stash Battle). Call once at startup.
 */
export function registerSceneElo(onClick: () => void): void {
  openBattle = onClick;
  let queued = false;
  const check = (): void => {
    queued = false;
    if (getSceneIdFromUrl()) void renderSceneElo();
  };
  // Batched with a timer, not an animation frame: frames don't run in a background tab
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    setTimeout(check, 50);
  }).observe(document.body, { childList: true, subtree: true });
  // Crossing the phone width moves the item between the toolbar and the subheader
  window.matchMedia(NARROW_QUERY).addEventListener("change", check);
  check();
}
