// Core comparison UI: layout, pair rendering, choice handling, animations.

import { clearFilteredCache, latestScene, refreshSceneInCache, removeSceneEverywhere } from "../cache";
import { CHAMPION_UNRATED_ELO, CLIMB_SMALL_POOL_WARN_AT, UPSET_MAX_CHANCE } from "../constants";
import { eloResult, winChances } from "../elo";
import { readFilters } from "../filters";
import { fetchSceneById } from "../graphql";
import { navigateToUrl } from "../navigation";
import {
  fetchChampionPair,
  fetchPlacementPair,
  currentFilters,
  fetchSwissPair,
  pairRanks,
} from "../pairs";
import { recordPlacementResult } from "../placement";
import { eloWritesSettled, restoreElo, writeElo } from "../rating";
import { fetchSceneFields } from "../sceneActions";
import { battles, effectiveElo, eloFields, kGames } from "../score";
import { getHallOfFame, keepOnlyHallOfFame } from "../settings";
import { explorePoolWithin, isEloSetupPending, isRunActive, resetRunState, resetShuffle, state } from "../state";
import { cachedTierMap } from "../stats";
import { resolveSceneTitle } from "../sceneTitle";
import { saveState } from "../storage";
import type { EloFields, Mode, PlacementRun, Rank, Scene, Tier } from "../types";
import { confirmDeleteScene } from "./deleteDialog";
import { escapeHtml } from "./miniCard";
import { createSceneCard } from "./sceneCard";
import { showPlacementScreen, showVictoryScreen } from "./screens";
import { createSettingsTab, createTabBar, getActiveTab } from "./settingsPanel";
import { createExploreTab } from "./exploreTab";
import { createRecordsTab } from "./recordsTab";
import { createStatsTab } from "./statsTab";

const MODES: { mode: Mode; icon: string; title: string; desc: string; tip: string }[] = [
  {
    mode: "swiss",
    icon: "⚖️",
    title: "Swiss",
    desc: "Fair matchups",
    tip: "Each scene faces an opponent with a similar ELO. Both scenes' ELO changes after every pick, and every scene stays in the rotation.",
  },
  {
    mode: "placement",
    icon: "📍",
    title: "Placement",
    desc: "Place a scene",
    tip: "Finds where one scene belongs. Each pick narrows the range of ranks it could land in (shown on its card) until its spot is found, about 10 picks for an unrated scene.\n\nLooking for Gauntlet? Turn on “Placement: start from the bottom” in Settings to make a scene climb the ladder from the bottom.",
  },
  {
    mode: "champion",
    icon: "🏆",
    title: "Champion",
    desc: "Winner stays on",
    tip: "Winner stays on: the scene you pick keeps defending against new challengers until it's beaten, then the winner takes over. Both scenes' ELO changes after every pick.",
  },
];

export function createMainUI(): string {
  const modeButtons = MODES.map(
    ({ mode, icon, title, desc, tip }) => `
            <button class="sb-mode-btn ${state.currentMode === mode ? "active" : ""}" data-mode="${mode}" data-tip="${tip}" aria-description="${tip}">
              <span class="sb-mode-icon">${icon}</span>
              <span class="sb-mode-title">${title}</span>
              <span class="sb-mode-desc">${desc}</span>
            </button>`,
  ).join("");

  return `
      <div id="stash-battle-container" class="sb-container">
        <div class="sb-header">
          <h1 class="sb-title">⚔️ Stash Battle</h1>
          ${createTabBar()}
        </div>
        <p id="sb-test-note" class="sb-pool-status sb-test-note" hidden>
          🧪 <strong>Test mode</strong>: nothing is saved to Stash · <a href="#" data-action="open-settings">turn off in Settings</a>
        </p>

        <div class="sb-tab-panel" data-panel="battle">
          <div id="sb-setup-area" class="sb-setup-area" hidden></div>
          <div class="sb-mode-row">
            <div class="sb-mode-toggle">${modeButtons}
            </div>
            <button type="button" class="sb-mode-info-btn" aria-controls="sb-mode-info" aria-expanded="false" aria-label="What does this mode do?">ⓘ</button>
          </div>
          <p id="sb-mode-info" class="sb-mode-info" hidden></p>

          <p id="sb-climb-pool-warning" class="sb-climb-warning" hidden>
            Champion can behave oddly with small filtered pools when both sides use the filter
            (fewer than ${CLIMB_SMALL_POOL_WARN_AT} scenes). Use a larger filter, or turn off
            "Use filtered scenes for both sides" in Settings.
          </p>

          <p id="sb-pool-status" class="sb-pool-status" hidden></p>
          <p id="sb-ratings-note" class="sb-pool-status sb-ratings-note" hidden>
            Stash ratings aren't being changed · <a href="#" data-action="open-settings">change in Settings</a>
          </p>

          <div class="sb-content">
            <div id="sb-comparison-area" class="sb-comparison-area">
              <div class="sb-loading">Loading scenes...</div>
            </div>
            <div class="sb-actions">
              <div class="sb-action-buttons">
                <button id="sb-undo-btn" class="btn btn-secondary" title="Undo your last pick (Backspace)" disabled>↶ Undo</button>
                <button id="sb-skip-btn" class="btn btn-secondary">Skip</button>
                <button id="sb-refresh-cache-btn" class="btn btn-secondary" title="Refresh scene list from server (use if you've added new scenes)">🔄 Refresh</button>
              </div>
              <div class="sb-keyboard-hint">
                <span>←</span> choose left ·
                <span>→</span> choose right ·
                <span>Space</span> skip ·
                <span>⌫</span> undo
              </div>
            </div>
          </div>
        </div>

        ${createExploreTab()}
        ${createStatsTab()}
        ${createRecordsTab()}
        ${createSettingsTab()}
      </div>
    `;
}

/** Touch screens have no hover tooltips: the ⓘ button shows the current mode's explanation here. */
export function updateModeInfo(): void {
  const info = document.getElementById("sb-mode-info");
  const mode = MODES.find((m) => m.mode === state.currentMode);
  if (info && mode) info.innerHTML = `<strong>${mode.icon} ${mode.title}:</strong> ${mode.tip.replace(/\n/g, "<br>")}`;
}

/** Battle tab note while the "Stash ratings" setting is "Don't update", and on every tab, test mode's. */
export function updateRatingsNote(): void {
  const note = document.getElementById("sb-ratings-note");
  if (note) note.hidden = state.settings.stashRatings !== "off";
  const test = document.getElementById("sb-test-note");
  if (test) test.hidden = !state.settings.testMode;
}

/** Who a Scenes page filter's scenes battle, worded as for a battled Explore filter. */
function filterOpponentsText(): string {
  return state.settings.filterOpponents ? " · against each other" : " · against your whole library";
}

/**
 * "Which scenes am I rating?" line above the cards: a battled Explore filter, the least-tested
 * (Stats), the Scenes page filter, or the whole library. One line, whichever applies.
 */
export function updatePoolStatus(): void {
  const status = document.getElementById("sb-pool-status");
  if (!status) return;
  const count = state.leftPoolSize;
  const countHtml =
    count === null ? "" : ` · <strong>${count} scene${count === 1 ? "" : "s"}</strong>`;

  const pool = state.explorePool;
  if (pool?.sceneId) {
    const scene = state.memoryCache.allScenes?.find((s) => s.id === pool.sceneId);
    const name = scene ? `: <strong>${escapeHtml(resolveSceneTitle(scene))}</strong>` : "";
    status.innerHTML = `Battling one scene${name} · against your whole library · <a href="#" data-action="stop-explore-pool">Stop</a>`;
  } else if (pool) {
    const against = explorePoolWithin() ? "against each other" : "against your whole library";
    status.innerHTML = `Battling from Explore: <strong>${pool.label}</strong>${countHtml} · ${against} · <a href="#" data-action="stop-explore-pool">Stop</a>`;
  } else if (state.leastTested) {
    const filtered = readFilters().filterActive;
    const from = filtered ? `your Scenes page filter${countHtml}${filterOpponentsText()}` : `your whole library${countHtml}`;
    status.innerHTML = `Battling your least-tested scenes first, from ${from} · <a href="#" data-action="stop-least-tested">Stop</a>`;
  } else if (readFilters().filterActive) {
    status.innerHTML = `Rating scenes from your Scenes page filter${countHtml}${filterOpponentsText()}`;
  } else {
    status.innerHTML = `Rating scenes from your whole library${countHtml}<span class="sb-pool-hint"> · filter the Scenes page to narrow it down</span>`;
  }
  status.hidden = false;
}

/** Card badge: the win streak while climbing or defending, or Placement's narrowing range. */
function climbStatusBadge(scene: Scene): number | string | null {
  if (state.currentMode === "placement") {
    const run = state.placement;
    if (run?.scene.id !== scene.id) return null;
    // "Start from the bottom" runs show the streak until the first loss
    if (run.fromBottom && run.battles > 0 && run.streak === run.battles) return run.streak;
    if (run.rangeHi === run.rangeLo) return null;
    return `📍 Narrowing between #${run.rangeLo + 1} and #${run.rangeHi + 1}`;
  }
  if (state.currentMode === "champion" && state.championScene?.id === scene.id) {
    return state.championWins;
  }
  return null;
}

/** Precomputed winner/loser context wired at render time for each choose button. */
interface SceneChoice {
  winner: Scene;
  loser: Scene;
  left: Scene;
  right: Scene;
  winnerCard: HTMLElement;
  loserCard: HTMLElement;
  winnerRank: Rank;
  loserRank: Rank;
}

function bindSceneChoice(body: HTMLElement, choice: SceneChoice): void {
  body.addEventListener("click", () => handleSceneChoice(choice));
}


/** Show or hide the Skip / Refresh bar. Only end screens hide it; every rendered pair shows it. */
export function setActionsVisible(visible: boolean): void {
  const actionsEl = document.querySelector<HTMLElement>(".sb-actions");
  if (actionsEl) actionsEl.style.display = visible ? "" : "none";
}

/** Touch devices have no hover: thumbnails toggle the preview instead of opening the scene. */
export function isTouchDevice(): boolean {
  return window.matchMedia("(hover: none)").matches;
}

/** Thumbnail / ↗ link click: native link for new tab or modifier clicks, SPA navigation otherwise. */
export function handleSceneLinkClick(e: MouseEvent, link: HTMLAnchorElement): void {
  const nativeNewTab = link.target === "_blank" && state.settings.openInNewTab;
  if (nativeNewTab || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  navigateToUrl(link.getAttribute("href") || "");
}

/**
 * Slider (0-100) to media volume on a cubic curve, so the slider tracks perceived loudness.
 * (Stash's player is linear, but generated preview clips are much louder than the source.)
 */
export function sliderToVolume(slider: number): number {
  return Math.pow(slider / 100, 3);
}

/** Apply volume/autoplay settings to the rendered preview videos (hovered card is audible). */
export function applyPreviewSettings(): void {
  const { previewVolume, autoplayPreviews } = state.settings;
  const battleVisible = getActiveTab() === "battle";
  document.querySelector(".sb-vs-container")?.classList.toggle("sb-autoplay", autoplayPreviews);

  document.querySelectorAll<HTMLElement>("#sb-comparison-area .sb-scene-card").forEach((card) => {
    const video = card.querySelector<HTMLVideoElement>(".sb-hover-preview");
    if (!video) return;
    // Touch screens keep a tapped card ":hover" afterwards, so there only the tap state counts
    // (otherwise the second tap couldn't mute the preview)
    const hovered = !isTouchDevice() && card.matches(":hover");
    const active = hovered || card.classList.contains("sb-previewing");
    // sb-card-muted: muted from the card's own button (touch), the preview keeps playing
    const muted = !active || previewVolume === 0 || card.classList.contains("sb-card-muted");
    video.volume = sliderToVolume(previewVolume);
    video.muted = muted;
    // The touch mute button shows whether this card's preview is heard right now
    const button = card.querySelector<HTMLElement>(".sb-card-mute");
    if (button) {
      button.textContent = muted ? "🔇" : "🔊";
      button.setAttribute("aria-label", muted ? "Play this preview with sound" : "Mute this preview");
    }
    if (battleVisible && (autoplayPreviews || active)) {
      if (video.paused) video.play().catch(() => {});
    } else {
      video.pause();
      video.currentTime = 0;
    }
  });
}

function bindPreview(card: HTMLElement): void {
  const video = card.querySelector<HTMLVideoElement>(".sb-hover-preview");
  if (!video) return;

  card.addEventListener("mouseenter", () => {
    if (isTouchDevice()) return;
    if (!state.settings.autoplayPreviews) video.currentTime = 0;
    video.volume = sliderToVolume(state.settings.previewVolume);
    video.muted = state.settings.previewVolume === 0;
    video.play().catch(() => {});
  });

  card.addEventListener("mouseleave", () => {
    if (isTouchDevice()) return;
    if (state.settings.autoplayPreviews) {
      video.muted = true;
      return;
    }
    video.pause();
    video.currentTime = 0;
  });
}

/** Touch: tap the thumbnail to play/stop its preview with sound (the ↗ opens the scene). */
function togglePreview(card: HTMLElement): void {
  const previewing = !card.classList.contains("sb-previewing");
  document.querySelectorAll(".sb-scene-card.sb-previewing").forEach((c) => c.classList.remove("sb-previewing"));
  card.classList.toggle("sb-previewing", previewing);
  card.classList.remove("sb-card-muted");
  applyPreviewSettings();
}

/**
 * Touch: the card's mute button. Heard → muted (the preview keeps playing). Not heard → this
 * card's preview plays with sound (turning the preview volume back on if it was at 0).
 */
function toggleCardSound(card: HTMLElement): void {
  const video = card.querySelector<HTMLVideoElement>(".sb-hover-preview");
  if (video && !video.muted) {
    card.classList.add("sb-card-muted");
    applyPreviewSettings();
    return;
  }
  // The tab bar's speaker restores the volume from before muting
  if (state.settings.previewVolume === 0) document.querySelector<HTMLButtonElement>(".sb-volume-icon")?.click();
  if (card.classList.contains("sb-previewing")) {
    card.classList.remove("sb-card-muted");
    applyPreviewSettings();
  } else {
    togglePreview(card);
  }
}

/**
 * The VS between the cards, with each side's win chance under it (a "who's favoured" bar).
 * Placement has none: its scene's ELO doesn't change per pick, and an unrated one has no ELO.
 */
function vsDivider(left: Scene, right: Scene): string {
  if (state.currentMode === "placement") {
    return `<div class="sb-vs-divider"><span class="sb-vs-text">VS</span></div>`;
  }
  const [leftChance, rightChance] = winChances(battleElo(latestScene(left)), battleElo(latestScene(right)));
  const favoured = (chance: number): string => (chance > 50 ? " sb-favoured" : "");
  const tip = `Chance each scene wins, from their ELO: left ${leftChance}%, right ${rightChance}%`;
  return `
        <div class="sb-vs-divider">
          <div class="sb-vs-stack" title="${tip}">
            <span class="sb-win-chance sb-win-chance-left${favoured(leftChance)}">${leftChance}%</span>
            <span class="sb-vs-text">VS</span>
            <span class="sb-win-chance sb-win-chance-right${favoured(rightChance)}">${rightChance}%</span>
            <span class="sb-win-bar" aria-hidden="true"><span style="width: ${leftChance}%"></span></span>
          </div>
        </div>`;
}

/** Each scene's tier (from the whole library's ELO order). */
function pairTiers(scenes: Scene[]): (Tier | null)[] {
  const library = state.memoryCache.allScenes;
  if (!library) return scenes.map(() => null);
  const tiers = cachedTierMap(library);
  return scenes.map((scene) => tiers.get(scene.id) ?? null);
}

// Shared rendering logic for displaying a pair of scenes
export function renderPair(scenes: Scene[], ranks: Rank[]): void {
  const comparisonArea = document.getElementById("sb-comparison-area");
  if (!comparisonArea) return;

  const statusBadges = scenes.map(climbStatusBadge);
  const tiers = pairTiers(scenes);

  comparisonArea.innerHTML = `
      <div class="sb-vs-container">
        ${createSceneCard(scenes[0], "left", ranks[0], statusBadges[0], tiers[0])}
        ${vsDivider(scenes[0], scenes[1])}
        ${createSceneCard(scenes[1], "right", ranks[1], statusBadges[1], tiers[1])}
      </div>
    `;

  const left = scenes[0];
  const right = scenes[1];
  const leftCard = comparisonArea.querySelector<HTMLElement>('.sb-scene-card[data-side="left"]');
  const rightCard = comparisonArea.querySelector<HTMLElement>('.sb-scene-card[data-side="right"]');
  const leftBody = leftCard?.querySelector<HTMLElement>(".sb-scene-body");
  const rightBody = rightCard?.querySelector<HTMLElement>(".sb-scene-body");

  if (left && right && leftCard && rightCard && leftBody && rightBody) {
    bindSceneChoice(leftBody, {
      winner: left,
      loser: right,
      left,
      right,
      winnerCard: leftCard,
      loserCard: rightCard,
      winnerRank: ranks[0],
      loserRank: ranks[1],
    });
    bindSceneChoice(rightBody, {
      winner: right,
      loser: left,
      left,
      right,
      winnerCard: rightCard,
      loserCard: leftCard,
      winnerRank: ranks[1],
      loserRank: ranks[0],
    });

    leftCard.querySelector(".sb-delete-btn")?.addEventListener("click", () => void deleteFromBattle(left));
    rightCard.querySelector(".sb-delete-btn")?.addEventListener("click", () => void deleteFromBattle(right));
  }

  comparisonArea.querySelectorAll<HTMLElement>(".sb-scene-card").forEach((card) => {
    const thumb = card.querySelector<HTMLAnchorElement>(".sb-scene-image-container");
    thumb?.addEventListener("click", (e) => {
      if (isTouchDevice()) {
        e.preventDefault();
        togglePreview(card);
        return;
      }
      handleSceneLinkClick(e, thumb);
    });
    card.querySelector(".sb-card-mute")?.addEventListener("click", (e) => {
      e.preventDefault();
      toggleCardSound(card);
    });
    const openLink = card.querySelector<HTMLAnchorElement>(".sb-open-link");
    openLink?.addEventListener("click", (e) => {
      if (!state.settings.openInNewTab) handleSceneLinkClick(e, openLink);
    });
    bindPreview(card);
  });
  applyPreviewSettings();

  setActionsVisible(true);

  // Update skip button state
  const skipBtn = document.querySelector<HTMLButtonElement>("#sb-skip-btn");
  if (skipBtn) skipBtn.disabled = isRunActive();
  updateUndoButton();
}

/** Skip the current pair (not allowed mid-run). */
export function skipPair(): void {
  if (isRunActive() || state.disableChoice) return;
  state.disableChoice = true;
  if (state.currentMode !== "swiss") {
    resetRunState();
    saveState();
  }
  loadNewPair();
}

/** Counts pair loads: a load only shows its result if nothing newer (a load, an undo) started since. */
let pairLoads = 0;

export async function loadNewPair(forcedLeftSceneId: string | null = null): Promise<void> {
  // No pool loads before the one-time ELO setup has run (it shows in place of the battle)
  if (isEloSetupPending()) return;
  state.disableChoice = false;
  const comparisonArea = document.getElementById("sb-comparison-area");
  if (!comparisonArea) return;
  const load = ++pairLoads;
  const superseded = (): boolean => load !== pairLoads;

  console.log(
    `[Stash Battle] 🎮 Loading new pair (mode: ${state.currentMode})${forcedLeftSceneId ? ` with forced scene ${forcedLeftSceneId}` : ""}...`,
  );
  const startTime = Date.now();

  // Only show loading on first load (when empty or already showing loading)
  if (!comparisonArea.querySelector(".sb-vs-container")) {
    const hasCache = state.memoryCache.allScenes !== null;
    comparisonArea.innerHTML = `<div class="sb-loading">${hasCache ? "Loading scenes..." : "Loading and caching scenes (first load may take a moment)..."}</div>`;
  }

  try {
    // Fetch forced scene data if a scene ID was provided
    let forcedLeftScene: Scene | null = null;
    if (forcedLeftSceneId) {
      forcedLeftScene = await fetchSceneById(forcedLeftSceneId);
      if (superseded()) return;
      // Fresh from Stash: the cache may be older (another tab), and ranks and battle math read it
      if (forcedLeftScene) refreshSceneInCache(forcedLeftScene);
      if (!forcedLeftScene) {
        console.warn("[Stash Battle] Could not fetch scene from URL, falling back to normal pairing");
      }
    }

    let scenes: Scene[] = [];
    let ranks: Rank[] = [null, null];

    if (state.currentMode === "placement") {
      const placementResult = await fetchPlacementPair(forcedLeftScene);
      if (superseded()) return;

      if (placementResult.done) {
        // A climb from the bottom that never lost has beaten the top scene
        if (placementResult.fromBottom && placementResult.rank === 1) {
          showVictoryScreen(placementResult.scene, placementResult.streak, {
            rank: placementResult.startRank,
            elo: placementResult.startElo,
          });
        } else {
          showPlacementScreen(placementResult);
        }
        return;
      }

      scenes = placementResult.scenes;
      ranks = placementResult.ranks;
    } else if (state.currentMode === "champion") {
      const championResult = await fetchChampionPair(forcedLeftScene);
      if (superseded()) return;

      // Check for victory (champion beat everyone)
      if (championResult.isVictory) {
        showVictoryScreen(championResult.scenes[0], state.championWins);
        return;
      }

      scenes = championResult.scenes;
      ranks = championResult.ranks;
    } else {
      const swissResult = await fetchSwissPair(forcedLeftScene);
      if (superseded()) return;

      scenes = swissResult.scenes;
      ranks = swissResult.ranks;
    }

    if (scenes.length < 2) {
      comparisonArea.innerHTML = '<div class="sb-error">Not enough scenes available for comparison.</div>';
      return;
    }

    state.currentPair.left = scenes[0];
    state.currentPair.right = scenes[1];
    state.currentRanks.left = ranks[0];
    state.currentRanks.right = ranks[1];

    const loadTime = Date.now() - startTime;
    console.log(
      `[Stash Battle] ✅ Pair loaded in ${loadTime}ms: Scene ${scenes[0].id} (rank #${ranks[0]}) vs Scene ${scenes[1].id} (rank #${ranks[1]})`,
    );

    renderPair(scenes, ranks);
    updatePoolStatus();
    updateClimbPoolWarning();
    saveState();
  } catch (error) {
    console.error("[Stash Battle] Error loading scenes:", error);
    const message = error instanceof Error ? error.message : String(error);
    const isNoScenes = message.includes("No scenes") || message.includes("Not enough");
    comparisonArea.innerHTML = `
        <div class="sb-error-screen">
          <div class="sb-error-icon">⚠️</div>
          <p class="sb-error-message">${message}</p>
          <button id="sb-error-retry" class="btn btn-primary">Retry</button>
        </div>
      `;
    setActionsVisible(true);

    // Attach retry handler
    const retryBtn = document.getElementById("sb-error-retry") as HTMLButtonElement | null;
    if (retryBtn) {
      retryBtn.addEventListener("click", async () => {
        retryBtn.disabled = true;
        retryBtn.textContent = "Loading...";

        if (isNoScenes) {
          // "No scenes" error: clear everything and start fresh
          await clearFilteredCache();
          resetShuffle();
        }
        // Network/other errors: just retry without clearing session state

        await loadNewPair();
      });
    }
  }
}

/** Render the saved pair, unless one of its scenes was deleted in Stash meanwhile. */
/**
 * Whether the saved pair belongs to the current run. A Placement pair is its run's scene against
 * an opponent, and a Champion pair includes the champion; without that, picks have nothing to
 * act on (a run that ended, say).
 */
function pairMatchesRun(left: Scene, right: Scene): boolean {
  if (state.currentMode === "placement") return state.placement?.scene.id === left.id;
  if (state.currentMode === "champion" && state.championScene) {
    return state.championScene.id === left.id || state.championScene.id === right.id;
  }
  return true;
}

export async function restoreCurrentPair(): Promise<void> {
  if (isEloSetupPending()) return;
  const left = state.currentPair.left as Scene;
  const right = state.currentPair.right as Scene;
  if (!pairMatchesRun(left, right)) {
    console.log("[Stash Battle] 📂 Saved pair doesn't belong to the current run, loading a new pair");
    await loadNewPair();
    return;
  }
  state.disableChoice = false;

  // Also brings the pair's ELO and Stash rating up to date (they may have changed since it was saved)
  if (!(await verifyCurrentPair())) return;

  // Ranks from the current pools, not the saved ones: battles since may have moved them. Loading
  // the pools also pre-warms them for the next choice and fills in the status line's pool size.
  let ranks: [Rank, Rank] = [state.currentRanks.left, state.currentRanks.right];
  try {
    ranks = await pairRanks(left, right);
    state.currentRanks = { left: ranks[0], right: ranks[1] };
  } catch (e) {
    console.warn("[Stash Battle] Could not load scene pools for the saved pair's ranks:", e);
  }

  console.log("[Stash Battle] 📂 Rendering saved pair");
  renderPair([left, right], ranks);
  updatePoolStatus();
}

/**
 * Check the current pair still exists in Stash (scenes may be deleted elsewhere). If one is gone,
 * continue without it and return false. Otherwise the pair's ELO and Stash rating are brought up
 * to date from Stash, in its objects and the cache. Network errors count as "still there".
 */
export async function verifyCurrentPair(): Promise<boolean> {
  const { left, right } = state.currentPair;
  if (!left || !right) return true;
  try {
    const fresh = await fetchSceneFields([left.id, right.id]);
    const gone = [left, right].find((s) => !fresh.has(s.id));
    if (gone) {
      console.log(`[Stash Battle] 👻 Scene ${gone.id} in the current pair no longer exists`);
      await handleSceneGone(gone.id);
      return false;
    }
    for (const scene of [left, right]) {
      const fields = fresh.get(scene.id);
      if (!fields) continue;
      scene.rating100 = fields.rating100 ?? null;
      scene.custom_fields = fields.custom_fields ?? {};
      refreshSceneInCache(scene);
    }
  } catch (e) {
    console.warn("[Stash Battle] Could not verify current pair:", e);
  }
  return true;
}

/** Forget a scene id referenced by the current run (it no longer exists). */
function dropFromRun(sceneId: string): void {
  state.championDefeated = state.championDefeated.filter((id) => id !== sceneId);
  const run = state.placement;
  if (!run) return;
  if (run.aboveId === sceneId) run.aboveId = null;
  if (run.belowId === sceneId) run.belowId = null;
  if (run.lastOpponentId === sceneId) {
    run.lastOpponentId = null;
    run.galloping = false;
  }
}

/**
 * A scene in play no longer exists. If it was the scene being rated/placed/climbing, start over;
 * otherwise keep the other scene and find it a new opponent.
 */
export async function handleSceneGone(sceneId: string): Promise<void> {
  await removeSceneEverywhere(sceneId);

  const { left, right } = state.currentPair;
  const runSceneIds = [left?.id, state.placement?.scene.id, state.championScene?.id];

  if (runSceneIds.includes(sceneId)) {
    resetRunState();
    saveState();
    await loadNewPair();
    return;
  }

  dropFromRun(sceneId);
  saveState();
  // Forced left only applies when no run is under way (Swiss, or before a Champion run starts)
  const keepId = right?.id === sceneId ? left?.id : null;
  await loadNewPair(keepId ?? null);
}

/** Clean mode: Stash's own delete dialog does the deleting; then continue the battle without it. */
async function deleteFromBattle(scene: Scene): Promise<void> {
  if (state.disableChoice) return;
  const deleted = await confirmDeleteScene(scene);
  if (!deleted) return;

  state.disableChoice = true;
  await handleSceneGone(scene.id);
}

/** ELO used in battle math: unrated scenes count as ELO_START (1500) in Swiss, CHAMPION_UNRATED_ELO in Champion. */
function battleElo(scene: Scene): number {
  return state.currentMode === "champion" ? effectiveElo(scene, CHAMPION_UNRATED_ELO) : effectiveElo(scene);
}

interface EloChange {
  from: number;
  to: number;
}

/**
 * Two-sided ELO for a pick (Swiss and Champion): both scenes' ELO and battles change and are
 * saved. `upset` is true when the winner was a real underdog (see UPSET_MAX_CHANCE).
 */
function resolveComparison(winner: Scene, loser: Scene): { winner: EloChange; loser: EloChange; upset: boolean } {
  // The math reads the cached copies: the pair's own objects may predate a background refresh
  const latestWinner = latestScene(winner);
  const latestLoser = latestScene(loser);
  const winnerSide = { elo: battleElo(latestWinner), kGames: kGames(latestWinner) };
  const loserSide = { elo: battleElo(latestLoser), kGames: kGames(latestLoser) };
  const result = eloResult(winnerSide, loserSide);

  void writeElo(winner, result.winner, battles(latestWinner) + 1, [true]);
  void writeElo(loser, result.loser, battles(latestLoser) + 1, [false]);

  return {
    winner: { from: winnerSide.elo, to: result.winner },
    loser: { from: loserSide.elo, to: result.loser },
    upset: winChances(winnerSide.elo, loserSide.elo)[0] <= UPSET_MAX_CHANCE,
  };
}

/** Show when Champion + filter opponents + small filtered pool. */
export function updateClimbPoolWarning(): void {
  const warning = document.getElementById("sb-climb-pool-warning");
  if (!warning) return;

  const isClimb = state.currentMode === "champion";
  const filters = currentFilters();
  const smallPool =
    state.totalScenesCount > 0 && state.totalScenesCount < CLIMB_SMALL_POOL_WARN_AT;

  warning.hidden = !(
    isClimb &&
    state.settings.filterOpponents &&
    filters.filterActive &&
    smallPool
  );
}

/** Placement: record the result; the next pair (or the final placement) comes from the fetch. */
function handlePlacementChoice(choice: SceneChoice): void {
  const run = state.placement;
  if (!run) {
    state.disableChoice = false;
    return;
  }

  const won = choice.winner.id === run.scene.id;
  recordPlacementResult(run, won, won ? choice.loser.id : choice.winner.id);
  saveState();

  choice.winnerCard.classList.add("sb-winner");
  choice.loserCard.classList.add("sb-loser");
  scheduleNextPair(600);
}

/** Champion: two-sided ELO every pick; the winner defends next (a new winner takes over). */
function handleChampionChoice(choice: SceneChoice): void {
  const { winner: winnerScene, loser: loserScene, left, winnerCard, loserCard } = choice;

  if (!state.championScene) state.championScene = left;
  const change = resolveComparison(winnerScene, loserScene);

  if (winnerScene.id === state.championScene.id) {
    state.championDefeated.push(loserScene.id);
    state.championWins++;
  } else {
    state.championScene = winnerScene;
    state.championDefeated = [loserScene.id];
    state.championWins = 1;
  }

  saveState();

  showPickResult(winnerCard, loserCard, change);
}

/** Winner/loser card styles and both ELO animations, then the next pair. */
function showPickResult(
  winnerCard: HTMLElement,
  loserCard: HTMLElement,
  change: { winner: EloChange; loser: EloChange; upset: boolean },
): void {
  winnerCard.classList.add("sb-winner");
  loserCard.classList.add("sb-loser");
  showRatingAnimation(winnerCard, change.winner.from, change.winner.to, true, change.upset);
  showRatingAnimation(loserCard, change.loser.from, change.loser.to, false);
  scheduleNextPairAfterAnimations();
}

function handleSceneChoice(choice: SceneChoice): void {
  if (state.disableChoice) return;
  state.disableChoice = true;
  lastPick = takePickSnapshot(choice);
  updateUndoButton();

  const { winner: winnerScene, loser: loserScene, winnerCard, loserCard } = choice;

  if (state.currentMode === "placement") {
    handlePlacementChoice(choice);
    return;
  }

  if (state.currentMode === "champion") {
    handleChampionChoice(choice);
    return;
  }

  // Swiss: both scenes' ELO changes (both stay in the pool)
  const change = resolveComparison(winnerScene, loserScene);

  saveState();

  showPickResult(winnerCard, loserCard, change);
}

const RATING_ANIM_MAX_TOTAL_MS = 1400;
const RATING_ANIM_HOLD_MS = 300;
const RATING_ANIM_COUNT_BUDGET_MS = RATING_ANIM_MAX_TOTAL_MS - RATING_ANIM_HOLD_MS;
const RATING_ANIM_DEFAULT_STEP_MS = 50;
const RATING_ANIM_MIN_STEP_MS = 8;

function scheduleNextPairAfterAnimations(): void {
  scheduleNextPair(1500);
}

/** The next pair after a pick's animation (an undo in the meantime cancels it). */
let nextPairTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleNextPair(ms: number): void {
  if (nextPairTimer) clearTimeout(nextPairTimer);
  nextPairTimer = setTimeout(() => {
    nextPairTimer = null;
    void loadNewPair();
  }, ms);
}

// ---------- Undo the last pick ----------

/** What the last pick changed, as it was just before (one level of undo). */
interface PickSnapshot {
  mode: Mode;
  left: Scene;
  right: Scene;
  ranks: [Rank, Rank];
  /** The scenes the pick writes (Placement's scene is written when it lands), with their fields before. */
  fields: { scene: Scene; value: EloFields | null; rating100: number | null }[];
  championScene: Scene | null;
  championWins: number;
  championDefeated: string[];
  placement: PlacementRun | null;
  /** The hall of fame's scenes before (a pick can add a new #1). */
  hallIds: string[];
}

let lastPick: PickSnapshot | null = null;
let undoing = false;

function takePickSnapshot(choice: SceneChoice): PickSnapshot {
  const run = state.placement;
  const written = state.currentMode === "placement" ? (run ? [run.scene] : []) : [choice.left, choice.right];
  return {
    mode: state.currentMode,
    left: choice.left,
    right: choice.right,
    ranks: [state.currentRanks.left, state.currentRanks.right],
    fields: written.map((scene) => ({ scene, value: eloFields(latestScene(scene)), rating100: latestScene(scene).rating100 ?? null })),
    championScene: state.championScene,
    championWins: state.championWins,
    championDefeated: [...state.championDefeated],
    // A copy: the run object itself changes with every pick
    placement: run ? { ...run, results: [...(run.results ?? [])] } : null,
    hallIds: getHallOfFame().map((e) => e.id),
  };
}

/** There's a pick to undo. */
export function canUndo(): boolean {
  return lastPick !== null && !undoing;
}

/** Forget the last pick (after a Reset ELO, say: its values no longer apply). */
export function clearUndo(): void {
  lastPick = null;
  updateUndoButton();
}

function updateUndoButton(): void {
  document.querySelectorAll<HTMLButtonElement>("#sb-undo-btn, #sb-end-undo").forEach((btn) => (btn.disabled = !canUndo()));
}

/**
 * Take back the last pick: its scenes' ELO, battles and records as they were (written back,
 * after any write still on its way), the mode's run (Champion's streak, Placement's search), any
 * hall of fame entry it added, and the same pair on screen to pick again. Stash ratings follow
 * the restored ELO on their own (the next sync).
 */
export async function undoLastPick(): Promise<void> {
  const pick = lastPick;
  if (!pick || undoing) return;
  undoing = true;
  lastPick = null;
  updateUndoButton();
  if (nextPairTimer) {
    clearTimeout(nextPairTimer);
    nextPairTimer = null;
  }
  // A next pair already loading (or Placement's landing) must not show up over the undone pick
  pairLoads++;
  state.disableChoice = true;
  try {
    await eloWritesSettled();
    await Promise.all(pick.fields.map(({ scene, value, rating100 }) => restoreElo(scene, value, rating100)));
    await keepOnlyHallOfFame(pick.hallIds);
  } catch (e) {
    console.error("[Stash Battle] Undo couldn't put everything back:", e);
  }

  if (state.currentMode !== pick.mode) {
    state.currentMode = pick.mode;
    document.querySelectorAll<HTMLElement>(".sb-mode-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === pick.mode));
    updateModeInfo();
    updateClimbPoolWarning();
  }
  state.championScene = pick.championScene;
  state.championWins = pick.championWins;
  state.championDefeated = pick.championDefeated;
  state.placement = pick.placement;
  state.currentPair = { left: pick.left, right: pick.right };
  state.currentRanks = { left: pick.ranks[0], right: pick.ranks[1] };
  state.disableChoice = false;
  undoing = false;
  console.log(`[Stash Battle] ↶ Undid the last pick (scene ${pick.left.id} vs ${pick.right.id})`);
  renderPair([pick.left, pick.right], pick.ranks);
  updatePoolStatus();
  saveState();
}

/**
 * ELO count-up/down overlay (whole numbers); large jumps speed up so the count fits within 1400ms.
 * `upset` adds a small "Upset!" under the change.
 */
function showRatingAnimation(
  card: HTMLElement,
  oldElo: number,
  newElo: number,
  isWinner: boolean,
  upset = false,
): void {
  const oldRating = Math.round(oldElo);
  const newRating = Math.round(newElo);
  const change = newRating - oldRating;
  // Create overlay
  const overlay = document.createElement("div");
  overlay.className = `sb-rating-overlay ${isWinner ? "sb-rating-winner" : "sb-rating-loser"}`;

  const ratingDisplay = document.createElement("div");
  ratingDisplay.className = "sb-rating-display";
  ratingDisplay.textContent = String(oldRating);

  const changeDisplay = document.createElement("div");
  changeDisplay.className = "sb-rating-change";
  changeDisplay.textContent = change > 0 ? `+${change}` : String(change);

  overlay.appendChild(ratingDisplay);
  overlay.appendChild(changeDisplay);
  if (upset) {
    const upsetDisplay = document.createElement("div");
    upsetDisplay.className = "sb-rating-upset";
    upsetDisplay.textContent = "Upset!";
    overlay.appendChild(upsetDisplay);
  }
  card.appendChild(overlay);

  const totalSteps = Math.abs(change);
  if (totalSteps === 0) {
    ratingDisplay.textContent = String(newRating);
    setTimeout(() => overlay.remove(), RATING_ANIM_MAX_TOTAL_MS);
    return;
  }

  const stepMs = Math.min(
    RATING_ANIM_DEFAULT_STEP_MS,
    Math.max(RATING_ANIM_MIN_STEP_MS, Math.round(RATING_ANIM_COUNT_BUDGET_MS / totalSteps)),
  );

  let currentDisplay = oldRating;
  const step = change > 0 ? 1 : -1;
  let stepCount = 0;

  const interval = setInterval(() => {
    stepCount++;
    currentDisplay += step;
    ratingDisplay.textContent = String(currentDisplay);

    if (stepCount >= totalSteps) {
      clearInterval(interval);
      ratingDisplay.textContent = String(newRating);
    }
  }, stepMs);

  setTimeout(() => overlay.remove(), RATING_ANIM_MAX_TOTAL_MS);
}
