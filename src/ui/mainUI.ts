// Core comparison UI: layout, pair rendering, choice handling, animations.

import { clearFilteredCache, removeSceneEverywhere } from "../cache";
import { calculateRatingChanges, effectiveRating } from "../elo";
import { CLIMB_K_PLAY_COUNT, CLIMB_SMALL_POOL_WARN_AT } from "../constants";
import { readFilters } from "../filters";
import { fetchSceneById } from "../graphql";
import { navigateToUrl } from "../navigation";
import {
  applyClimbWinRating,
  fetchChampionPair,
  fetchGauntletPair,
  fetchPlacementPair,
  fetchSwissPair,
  loadPoolSize,
  recordPlacementResult,
} from "../pairs";
import { ratingsEnabled, updateSceneRating } from "../rating";
import { findExistingSceneIds } from "../sceneActions";
import { isRunActive, resetRunState, resetShuffle, state } from "../state";
import { saveState } from "../storage";
import type { BattleSide, ComparisonDeltas, Mode, Rank, Scene } from "../types";
import { confirmDeleteScene } from "./deleteDialog";
import { createSceneCard } from "./sceneCard";
import { showPlacementScreen, showVictoryScreen } from "./screens";
import { createSettingsTab, createTabBar, getActiveTab } from "./settingsPanel";

const MODES: { mode: Mode; icon: string; title: string; desc: string; tip: string }[] = [
  {
    mode: "swiss",
    icon: "⚖️",
    title: "Swiss",
    desc: "Fair matchups",
    tip: "Each scene faces an opponent with a similar rating. Both ratings change after every pick, and every scene stays in the rotation.",
  },
  {
    mode: "placement",
    icon: "📍",
    title: "Placement",
    desc: "Place a scene",
    tip: "Finds where one scene belongs. Each pick narrows the range of ranks it could land in (shown on its card) until its spot is found, about 10 picks for an unrated scene. Only its rating changes, once at the end.",
  },
  {
    mode: "gauntlet",
    icon: "🎯",
    title: "Gauntlet",
    desc: "Climb the ladder",
    tip: "A scene starts at the bottom and climbs by beating the scenes above it. When it loses, it falls until it finds its floor. Only the climber's rating changes.",
  },
  {
    mode: "champion",
    icon: "🏆",
    title: "Champion",
    desc: "Winner stays on",
    tip: "Winner stays on: the scene you pick keeps defending against new challengers until it's beaten, then the winner takes over.",
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
          <p class="sb-subtitle">Compare scenes head-to-head to build your rankings</p>
          ${createTabBar()}
        </div>

        <div class="sb-tab-panel" data-panel="battle">
          <p id="sb-fun-badge" class="sb-fun-badge" ${state.settings.funMode ? "" : "hidden"}>🎈 Fun mode: ratings are not saved</p>
          <div class="sb-mode-row">
            <div class="sb-mode-toggle">${modeButtons}
            </div>
            <button type="button" class="sb-mode-info-btn" aria-controls="sb-mode-info" aria-expanded="false" aria-label="What does this mode do?">ⓘ</button>
          </div>
          <p id="sb-mode-info" class="sb-mode-info" hidden></p>

          <p id="sb-climb-pool-warning" class="sb-climb-warning" hidden>
            Gauntlet and Champion can behave oddly with small filtered pools when both sides use the filter
            (fewer than ${CLIMB_SMALL_POOL_WARN_AT} scenes). Use a larger filter, or turn off
            "Use filtered scenes for both sides" in Settings.
          </p>

          <p id="sb-pool-status" class="sb-pool-status" hidden></p>

          <div class="sb-content">
            <div id="sb-comparison-area" class="sb-comparison-area">
              <div class="sb-loading">Loading scenes...</div>
            </div>
            <div class="sb-actions">
              <div class="sb-action-buttons">
                <button id="sb-skip-btn" class="btn btn-secondary">Skip</button>
                <button id="sb-refresh-cache-btn" class="btn btn-secondary" title="Refresh scene list from server (use if you've added new scenes)">🔄 Refresh</button>
              </div>
              <div class="sb-keyboard-hint">
                <span>←</span> choose left ·
                <span>→</span> choose right ·
                <span>Space</span> skip
              </div>
            </div>
          </div>
        </div>

        ${createSettingsTab()}
      </div>
    `;
}

/** Touch screens have no hover tooltips: the ⓘ button shows the current mode's explanation here. */
export function updateModeInfo(): void {
  const info = document.getElementById("sb-mode-info");
  const mode = MODES.find((m) => m.mode === state.currentMode);
  if (info && mode) info.innerHTML = `<strong>${mode.icon} ${mode.title}:</strong> ${mode.tip}`;
}

/** "Which scenes am I rating?" line above the cards: the Scenes page filter or the whole library. */
export function updatePoolStatus(): void {
  const status = document.getElementById("sb-pool-status");
  if (!status) return;
  const count = state.leftPoolSize;
  const countHtml =
    count === null ? "" : ` · <strong>${count} scene${count === 1 ? "" : "s"}</strong>`;

  if (readFilters().filterActive) {
    const opponents = state.settings.filterOpponents ? " · opponents from the filter too" : "";
    status.innerHTML = `Rating scenes from your Scenes page filter${countHtml}${opponents}`;
  } else {
    status.innerHTML = `Rating scenes from your whole library${countHtml}<span class="sb-pool-hint"> · filter the Scenes page to narrow it down</span>`;
  }
  status.hidden = false;
}

/** Show/hide the fun mode badge to match the setting. */
export function updateFunBadge(): void {
  const badge = document.getElementById("sb-fun-badge");
  if (badge) badge.hidden = !state.settings.funMode;
}

function climbStatusBadge(scene: Scene): number | string | null {
  if (state.currentMode === "placement") {
    const run = state.placement;
    if (run?.scene.id !== scene.id || run.rangeHi === run.rangeLo) return null;
    return `📍 Narrowing between #${run.rangeLo + 1} and #${run.rangeHi + 1}`;
  }
  if (state.currentMode !== "gauntlet" && state.currentMode !== "champion") return null;
  if (state.gauntletFalling && state.gauntletFallingScene?.id === scene.id) {
    return "📍 Finding final placement...";
  }
  if (state.gauntletClimber?.id === scene.id) {
    return state.gauntletWins;
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
function isTouchDevice(): boolean {
  return window.matchMedia("(hover: none)").matches;
}

/** Thumbnail / ↗ link click: native link for new tab or modifier clicks, SPA navigation otherwise. */
function handleSceneLinkClick(e: MouseEvent, link: HTMLAnchorElement): void {
  const nativeNewTab = link.target === "_blank" && state.settings.openInNewTab;
  if (nativeNewTab || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  navigateToUrl(link.getAttribute("href") || "");
}

/**
 * Slider (0-100) to media volume on a cubic curve, so the slider tracks perceived loudness.
 * (Stash's player is linear, but generated preview clips are much louder than the source.)
 */
function sliderToVolume(slider: number): number {
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
    const active = card.matches(":hover") || card.classList.contains("sb-previewing");
    video.volume = sliderToVolume(previewVolume);
    video.muted = !active || previewVolume === 0;
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

/** Touch: tap the thumbnail to play/stop its preview with sound. */
function togglePreview(card: HTMLElement): void {
  const previewing = !card.classList.contains("sb-previewing");
  document.querySelectorAll(".sb-scene-card.sb-previewing").forEach((c) => c.classList.remove("sb-previewing"));
  card.classList.toggle("sb-previewing", previewing);
  applyPreviewSettings();
}

// Shared rendering logic for displaying a pair of scenes
export function renderPair(scenes: Scene[], ranks: Rank[]): void {
  const comparisonArea = document.getElementById("sb-comparison-area");
  if (!comparisonArea) return;

  const statusBadges = scenes.map(climbStatusBadge);

  comparisonArea.innerHTML = `
      <div class="sb-vs-container">
        ${createSceneCard(scenes[0], "left", ranks[0], statusBadges[0])}
        <div class="sb-vs-divider">
          <span class="sb-vs-text">VS</span>
        </div>
        ${createSceneCard(scenes[1], "right", ranks[1], statusBadges[1])}
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

export async function loadNewPair(forcedLeftSceneId: string | null = null): Promise<void> {
  state.disableChoice = false;
  const comparisonArea = document.getElementById("sb-comparison-area");
  if (!comparisonArea) return;

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
      if (!forcedLeftScene) {
        console.warn("[Stash Battle] Could not fetch scene from URL, falling back to normal pairing");
      }
    }

    let scenes: Scene[] = [];
    let ranks: Rank[] = [null, null];

    if (state.currentMode === "placement") {
      const placementResult = await fetchPlacementPair(forcedLeftScene);

      if (placementResult.done) {
        showPlacementScreen(placementResult.scene, placementResult.rank, placementResult.rating);
        return;
      }

      scenes = placementResult.scenes;
      ranks = placementResult.ranks;
    } else if (state.currentMode === "gauntlet") {
      const gauntletResult = await fetchGauntletPair(forcedLeftScene);

      // Check for victory (champion reached #1)
      if (gauntletResult.isVictory) {
        showVictoryScreen(gauntletResult.scenes[0]);
        return;
      }

      // Check for placement (falling scene hit bottom)
      if (gauntletResult.isPlacement) {
        showPlacementScreen(
          gauntletResult.scenes[0],
          gauntletResult.placementRank,
          gauntletResult.placementRating,
        );
        return;
      }

      scenes = gauntletResult.scenes;
      ranks = gauntletResult.ranks;
    } else if (state.currentMode === "champion") {
      const championResult = await fetchChampionPair(forcedLeftScene);

      // Check for victory (champion beat everyone)
      if (championResult.isVictory) {
        showVictoryScreen(championResult.scenes[0]);
        return;
      }

      scenes = championResult.scenes;
      ranks = championResult.ranks;
    } else {
      const swissResult = await fetchSwissPair(forcedLeftScene);

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
export async function restoreCurrentPair(): Promise<void> {
  state.disableChoice = false;
  const left = state.currentPair.left as Scene;
  const right = state.currentPair.right as Scene;

  // Load the (cached) pools in the background: pre-warms them for the next choice and fills in
  // the pool size on the status line, which a restored pair otherwise doesn't know yet
  void loadPoolSize()
    .then(updatePoolStatus)
    .catch((e) => console.warn("[Stash Battle] Could not load scene pools for the status line:", e));

  if (!(await verifyCurrentPair())) return;

  console.log("[Stash Battle] 📂 Rendering saved pair (no network fetch needed)");
  renderPair([left, right], [state.currentRanks.left, state.currentRanks.right]);
  updatePoolStatus();
}

/**
 * Check the current pair still exists in Stash (scenes may be deleted elsewhere). If one is gone,
 * continue without it and return false. Network errors count as "still there".
 */
export async function verifyCurrentPair(): Promise<boolean> {
  const { left, right } = state.currentPair;
  if (!left || !right) return true;
  try {
    const existing = await findExistingSceneIds([left.id, right.id]);
    const gone = [left, right].find((s) => !existing.has(s.id));
    if (gone) {
      console.log(`[Stash Battle] 👻 Scene ${gone.id} in the current pair no longer exists`);
      await handleSceneGone(gone.id);
      return false;
    }
  } catch (e) {
    console.warn("[Stash Battle] Could not verify current pair:", e);
  }
  return true;
}

/** Forget a scene id referenced by the current run (it no longer exists). */
function dropFromRun(sceneId: string): void {
  state.gauntletDefeated = state.gauntletDefeated.filter((id) => id !== sceneId);
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
  const runSceneIds = [left?.id, state.placement?.scene.id, state.gauntletClimber?.id, state.gauntletFallingScene?.id];

  if (runSceneIds.includes(sceneId)) {
    resetRunState();
    saveState();
    await loadNewPair();
    return;
  }

  dropFromRun(sceneId);
  saveState();
  // Forced left only applies when no run is under way (Swiss, or before a climb starts)
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

function activeClimberId(): string | null {
  if (state.gauntletFalling && state.gauntletFallingScene) {
    return state.gauntletFallingScene.id;
  }
  return state.gauntletClimber?.id ?? null;
}

function battleRoleFor(sceneId: string, mode: Mode): BattleSide["role"] {
  if (mode === "swiss") return "combatant";
  const climberId = activeClimberId();
  return climberId !== null && sceneId === climberId ? "climber" : "benchmark";
}

/** Rating used in ELO math. The unrated-rating setting applies to Swiss; climbs start from the bottom. */
function battleRating(scene: Scene): number {
  const unrated = state.currentMode === "swiss" ? state.settings.unratedRating : 0;
  return effectiveRating(scene.rating100, unrated);
}

/** Apply climb/champion rules on top of raw two-sided ELO. Swiss uses the raw result as-is. */
function applyModePolicy(
  winner: Scene,
  loser: Scene,
  mode: Mode,
  raw: ComparisonDeltas,
): ComparisonDeltas {
  if (mode === "swiss") return raw;

  let winnerDelta = 0;
  let loserDelta = 0;

  if (battleRoleFor(winner.id, mode) === "climber") {
    winnerDelta = raw.winner;
  }

  const loserRating = loser.rating100 || 1;
  // Special case: if 100 rated benchmark loses, they drop to 99 so its funner to see a champion emerge
  if (battleRoleFor(loser.id, mode) === "benchmark" && loserRating === 100) {
    loserDelta = -1;
  }

  return { winner: winnerDelta, loser: loserDelta };
}

/** Run pure ELO math and persist any rating changes to Stash. Fun mode changes nothing. */
function resolveComparison(winner: Scene, loser: Scene): ComparisonDeltas {
  if (!ratingsEnabled()) return { winner: 0, loser: 0 };

  const mode = state.currentMode;
  const winnerRating = battleRating(winner);
  const loserRating = battleRating(loser);

  const climberId = activeClimberId();
  const winnerPlayCount =
    mode !== "swiss" && climberId === winner.id
      ? CLIMB_K_PLAY_COUNT
      : (winner.play_count ?? 0);

  const raw = calculateRatingChanges({
    winner: { rating: winnerRating, playCount: winnerPlayCount },
    loser: { rating: loserRating, playCount: loser.play_count ?? 0 },
  });
  const deltas = applyModePolicy(winner, loser, mode, raw);

  if (deltas.winner !== 0) updateSceneRating(winner.id, winnerRating + deltas.winner);
  if (deltas.loser !== 0) updateSceneRating(loser.id, loserRating + deltas.loser);

  return deltas;
}

/** Show when gauntlet/champion + filter opponents + small filtered pool. */
export function updateClimbPoolWarning(): void {
  const warning = document.getElementById("sb-climb-pool-warning");
  if (!warning) return;

  const isClimb = state.currentMode === "gauntlet" || state.currentMode === "champion";
  const filters = readFilters();
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
  recordPlacementResult(won, won ? choice.loser.id : choice.winner.id);
  saveState();

  choice.winnerCard.classList.add("sb-winner");
  choice.loserCard.classList.add("sb-loser");
  setTimeout(() => loadNewPair(), 600);
}

/** Gauntlet climb / first-battle path (after falling-mode branch). */
async function handleGauntletClimbChoice(choice: SceneChoice): Promise<void> {
  const {
    winner: winnerScene,
    loser: loserScene,
    left,
    winnerCard,
    loserCard,
  } = choice;

  const winnerId = winnerScene.id;
  const loserId = loserScene.id;

  const isFirstBattle = !state.gauntletClimber;

  // Re-verify from the bottom: clear existing rating on first choice, not on pair load
  if (isFirstBattle && left.rating100 != null && ratingsEnabled()) {
    console.log(
      `[Stash Battle] 📊 Gauntlet: clearing rating ${left.rating100} for scene ${left.id} on first choice`,
    );
    await updateSceneRating(left.id, null);
    left.rating100 = null;
  }

  if (isFirstBattle) {
    // Fun mode can't clear the rating, so the climber is an unrated copy kept only in memory:
    // it climbs from the bottom like a real run while the cached scene object stays untouched
    state.gauntletClimber = ratingsEnabled() ? left : { ...left, rating100: null };
  }
  const climber = state.gauntletClimber as Scene;

  const winnerRating = winnerScene.rating100 || 1;
  const winnerAnimStart = winnerScene.rating100 ?? 0;
  const loserDisplayRating = loserScene.rating100 ?? 0;

  const { winner: winnerDelta, loser: loserDelta } = resolveComparison(winnerScene, loserScene);
  const newWinnerRating = winnerRating + winnerDelta;
  const newLoserRating = loserDisplayRating + loserDelta;

  let winnerDisplayRating = newWinnerRating;

  if (winnerId === climber.id) {
    state.gauntletDefeated.push(loserId);
    state.gauntletWins++;
    winnerDisplayRating = await applyClimbWinRating(climber, loserScene, newWinnerRating);
    console.log(
      `[Stash Battle] 📊 Gauntlet: climber ${winnerId} won (streak=${state.gauntletWins}), rating → ${winnerDisplayRating}`,
    );
  } else if (isFirstBattle) {
    const finalRank = state.totalScenesCount;
    const finalRating = Math.max(1, (winnerScene.rating100 || 1) - 1);
    console.log(
      `[Stash Battle] 📊 Gauntlet: first battle, challenger ${loserId} lost to floor → rank #${finalRank}, rating ${finalRating}`,
    );
    void updateSceneRating(loserScene.id, finalRating);

    winnerCard.classList.add("sb-winner");
    if (loserCard) loserCard.classList.add("sb-loser");

    setTimeout(() => {
      showPlacementScreen(loserScene, finalRank, finalRating);
    }, 800);
    return;
  } else {
    console.log(
      `[Stash Battle] 📊 Gauntlet: climber ${climber.id}(rating=${climber.rating100}) LOST to ${winnerId}(rating=${newWinnerRating}), entering falling mode`,
    );
    state.gauntletFalling = true;
    // The climber itself (same object as the loser, except in fun mode where it's the unrated copy)
    state.gauntletFallingScene = climber;
    state.gauntletDefeated = [winnerId];
  }

  saveState();

  winnerCard.classList.add("sb-winner");
  if (loserCard) loserCard.classList.add("sb-loser");

  showRatingAnimation(winnerCard, winnerAnimStart, winnerDisplayRating, true);
  if (loserCard) {
    showRatingAnimation(
      loserCard,
      loserDisplayRating,
      loserDelta !== 0 ? newLoserRating : loserDisplayRating,
      false,
    );
  }
  scheduleNextPairAfterAnimations();
}

/** Champion mode climb path. */
async function handleChampionChoice(choice: SceneChoice): Promise<void> {
  const {
    winner: winnerScene,
    loser: loserScene,
    left,
    winnerCard,
    loserCard,
  } = choice;

  const winnerId = winnerScene.id;
  const loserId = loserScene.id;
  const winnerRating = winnerScene.rating100 || 1;
  const winnerAnimStart = winnerScene.rating100 ?? 0;
  const loserDisplayRating = loserScene.rating100 ?? 0;

  const isFirstBattle = !state.gauntletClimber;
  if (isFirstBattle) {
    state.gauntletClimber = left;
  }
  const climber = state.gauntletClimber as Scene;

  const { winner: winnerDelta, loser: loserDelta } = resolveComparison(winnerScene, loserScene);
  const newWinnerRating = winnerRating + winnerDelta;
  const newLoserRating = loserDisplayRating + loserDelta;

  let winnerDisplayRating = newWinnerRating;

  if (winnerId === climber.id) {
    state.gauntletDefeated.push(loserId);
    state.gauntletWins++;
    winnerDisplayRating = await applyClimbWinRating(climber, loserScene, newWinnerRating);
  } else {
    state.gauntletClimber = winnerScene;
    if (ratingsEnabled()) winnerScene.rating100 = newWinnerRating;
    state.gauntletDefeated = [loserId];
    state.gauntletWins = 1;
  }

  saveState();

  winnerCard.classList.add("sb-winner");
  if (loserCard) loserCard.classList.add("sb-loser");

  showRatingAnimation(winnerCard, winnerAnimStart, winnerDisplayRating, true);
  if (loserCard) {
    showRatingAnimation(
      loserCard,
      loserDisplayRating,
      loserDelta !== 0 ? newLoserRating : loserDisplayRating,
      false,
    );
  }
  scheduleNextPairAfterAnimations();
}

function handleSceneChoice(choice: SceneChoice): void {
  if (state.disableChoice) return;
  state.disableChoice = true;

  const {
    winner: winnerScene,
    loser: loserScene,
    winnerCard,
    loserCard,
    loserRank,
  } = choice;

  const winnerId = winnerScene.id;
  const loserId = loserScene.id;

  if (state.currentMode === "placement") {
    handlePlacementChoice(choice);
    return;
  }

  // Handle gauntlet mode (climber tracking)
  if (state.currentMode === "gauntlet") {
    // Check if we're in falling mode (finding floor after a loss)
    if (state.gauntletFalling && state.gauntletFallingScene) {
      const fallingScene = state.gauntletFallingScene;
      const loserRating = loserScene.rating100 || 1;
      console.log(
        `[Stash Battle] 📊 Falling mode: fallingScene=${fallingScene.id} winnerId=${winnerId} loserId=${loserId} loserRating=${loserRating}`,
      );
      if (winnerId === fallingScene.id) {
        // Falling scene won - found their floor!
        const finalRating = Math.min(100, loserRating + 1);
        const fallingAnimStart = fallingScene.rating100 ?? 0;
        console.log(
          `[Stash Battle] 📊 Falling scene found floor: loserRating=${loserRating} → finalRating=${finalRating}`,
        );
        void updateSceneRating(fallingScene.id, finalRating);
        if (ratingsEnabled()) fallingScene.rating100 = finalRating;

        // Final rank is one above the opponent (we beat them, so we're above them)
        const finalRank = Math.max(1, (loserRank ?? 1) - 1);

        winnerCard.classList.add("sb-winner");
        if (loserCard) loserCard.classList.add("sb-loser");

        showRatingAnimation(winnerCard, fallingAnimStart, finalRating, true);

        setTimeout(() => {
          showPlacementScreen(fallingScene, finalRank, finalRating);
        }, 1500);
        return;
      } else {
        // Falling scene lost again - keep falling
        state.gauntletDefeated.push(winnerId);
        saveState();

        winnerCard.classList.add("sb-winner");
        if (loserCard) loserCard.classList.add("sb-loser");

        setTimeout(() => {
          loadNewPair();
        }, 800);
        return;
      }
    }

    // Climb / first battle (falling handled above)
    void handleGauntletClimbChoice(choice);
    return;
  }

  // Handle champion mode (like gauntlet but winner always takes over)
  if (state.currentMode === "champion") {
    void handleChampionChoice(choice);
    return;
  }

  // Swiss: calculate and show rating changes (both scenes stay in the pool)
  const winnerStart = battleRating(winnerScene);
  const loserStart = battleRating(loserScene);
  const { winner: winnerDelta, loser: loserDelta } = resolveComparison(winnerScene, loserScene);

  saveState();

  winnerCard.classList.add("sb-winner");
  if (loserCard) loserCard.classList.add("sb-loser");

  showRatingAnimation(winnerCard, winnerStart, winnerStart + winnerDelta, true);
  if (loserCard) {
    showRatingAnimation(loserCard, loserStart, loserStart + loserDelta, false);
  }
  scheduleNextPairAfterAnimations();
}

const RATING_ANIM_MAX_TOTAL_MS = 1400;
const RATING_ANIM_HOLD_MS = 300;
const RATING_ANIM_COUNT_BUDGET_MS = RATING_ANIM_MAX_TOTAL_MS - RATING_ANIM_HOLD_MS;
const RATING_ANIM_DEFAULT_STEP_MS = 50;
const RATING_ANIM_MIN_STEP_MS = 8;

function scheduleNextPairAfterAnimations(): void {
  // Fun mode has no rating animation to wait for
  setTimeout(() => loadNewPair(), ratingsEnabled() ? 1500 : 600);
}

/** Count-up/down overlay; large jumps speed up so the full count fits within 1400ms. */
function showRatingAnimation(
  card: HTMLElement,
  oldRating: number,
  newRating: number,
  isWinner: boolean,
): void {
  if (!ratingsEnabled()) return;
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
