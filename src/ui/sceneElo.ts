// The scene's ELO and rank on Stash's own scene page, as one more item in the toolbar next to
// Play Count and O Count: a single Stash "minimal" button (icon and text highlight together).
//
// Stash's ScenePage isn't a patchable component, so the item is added to the DOM and re-added
// whenever React re-renders the toolbar. The rank comes from Stash Battle's all-scenes cache, the
// same place the battle cards get theirs (Stash can't count scenes by a numeric custom field).

import { getAllScenesCached } from "../cache";
import { fetchSceneById, getSceneIdFromUrl, sceneCustomFieldsSupported } from "../graphql";
import { elo, isRated } from "../score";
import type { Scene } from "../types";
import { SWORDS_PATHS } from "./icons";

const ITEM_CLASS = "sb-scene-elo";
const TITLE = "Stash Battle ELO, and rank in your library. Click to battle this scene.";

/** "ELO 1740 · #50", or "ELO · Unrated" for a scene with no ELO yet. */
function labelText(scene: Scene, rank: number | null): string {
  const value = elo(scene);
  if (value === null) return "ELO · Unrated";
  return `ELO ${Math.round(value)}${rank !== null ? ` · #${rank}` : ""}`;
}

/** The scene (from the cache, or fetched if it's newer than the cache) and its rank among rated scenes. */
async function sceneAndRank(sceneId: string): Promise<{ scene: Scene; rank: number | null } | null> {
  const { scenes } = await getAllScenesCached();
  // The cache is sorted by ELO with unrated scenes last, so a rated scene's index is its rank
  const index = scenes.findIndex((s) => s.id === sceneId);
  if (index >= 0) return { scene: scenes[index], rank: isRated(scenes[index]) ? index + 1 : null };
  const scene = await fetchSceneById(sceneId);
  return scene ? { scene, rank: null } : null;
}

/** Opens Stash Battle (on a scene page, with this scene in the battle). Set by registerSceneElo. */
let openBattle: () => void = () => {};

/** One Stash "minimal" button with the swords and the ELO, so it hovers as a whole. */
function createItem(): HTMLElement {
  const item = document.createElement("span");
  item.className = ITEM_CLASS;
  item.innerHTML = `
      <button type="button" class="minimal btn btn-secondary sb-scene-elo-button" title="${TITLE}">
        <svg class="svg-inline--fa fa-icon" aria-hidden="true" focusable="false" viewBox="0 0 36 36" width="1em" height="1em">${SWORDS_PATHS}</svg>
        <span class="sb-scene-elo-value"></span>
      </button>`;
  item.querySelector("button")?.addEventListener("click", () => openBattle());
  return item;
}

/** The toolbar group holding Play Count and O Count; the item goes in front of Play Count. */
function placeItem(toolbar: Element, item: HTMLElement): boolean {
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

let rendering: string | null = null;

/** Add (or update) the item on the current scene page. Safe to call often. */
async function renderSceneElo(force = false): Promise<void> {
  const sceneId = getSceneIdFromUrl();
  const toolbar = document.querySelector(".scene-toolbar");
  if (!sceneId || !toolbar) return;
  const existing = toolbar.querySelector<HTMLElement>(`.${ITEM_CLASS}`);
  if (!force && existing?.dataset.sceneId === sceneId) return;
  if (rendering === sceneId) return;

  rendering = sceneId;
  try {
    if (!(await sceneCustomFieldsSupported())) return;
    const result = await sceneAndRank(sceneId);
    // The page may have moved on (another scene, or the toolbar re-rendered) while this loaded
    if (!result || getSceneIdFromUrl() !== sceneId) return;
    const target = document.querySelector(".scene-toolbar");
    if (!target) return;

    let item = target.querySelector<HTMLElement>(`.${ITEM_CLASS}`);
    if (!item) {
      item = createItem();
      if (!placeItem(target, item)) return;
    }
    item.dataset.sceneId = sceneId;
    const value = item.querySelector(".sb-scene-elo-value");
    if (value) value.textContent = labelText(result.scene, result.rank);
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
  check();
}
