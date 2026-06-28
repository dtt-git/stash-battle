// Core comparison UI: layout, pair rendering, choice handling, animations.

import { clearFilteredCache, getAllScenesCached, removeFromFilteredPool } from "../cache";
import { calculateRatingChanges } from "../elo";
import { CLIMB_K_PLAY_COUNT, CLIMB_SMALL_POOL_WARN_AT } from "../constants";
import { readFilters } from "../filters";
import { fetchSceneById } from "../graphql";
import { navigateToUrl } from "../navigation";
import { applyClimbWinRating, fetchChampionPair, fetchGauntletPair, fetchSwissPair } from "../pairs";
import { updateSceneRating } from "../rating";
import { state } from "../state";
import { saveState } from "../storage";
import type { BattleSide, ComparisonDeltas, Mode, Rank, Scene } from "../types";
import { createSceneCard } from "./sceneCard";
import { showPlacementScreen, showVictoryScreen } from "./screens";

export function createMainUI(): string {
  return `
      <div id="stash-battle-container" class="sb-container">
        <div class="sb-header">
          <h1 class="sb-title">⚔️ Stash Battle</h1>
          <p class="sb-subtitle">Compare scenes head-to-head to build your rankings</p>

          <div class="sb-mode-toggle">
            <button class="sb-mode-btn ${state.currentMode === "swiss" ? "active" : ""}" data-mode="swiss">
              <span class="sb-mode-icon">⚖️</span>
              <span class="sb-mode-title">Swiss</span>
              <span class="sb-mode-desc">Fair matchups</span>
            </button>
            <button class="sb-mode-btn ${state.currentMode === "gauntlet" ? "active" : ""}" data-mode="gauntlet">
              <span class="sb-mode-icon">🎯</span>
              <span class="sb-mode-title">Gauntlet</span>
              <span class="sb-mode-desc">Place a scene</span>
            </button>
            <button class="sb-mode-btn ${state.currentMode === "champion" ? "active" : ""}" data-mode="champion">
              <span class="sb-mode-icon">🏆</span>
              <span class="sb-mode-title">Champion</span>
              <span class="sb-mode-desc">Winner stays on</span>
            </button>
          </div>

          <div class="sb-opponents-toggle" style="margin-top:8px;">
            <label>
              <input type="checkbox" id="sb-filter-opponents-checkbox" ${state.filterOpponents ? "checked" : ""}>
               Use filtered scenes for both sides
            </label>
            <label style="margin-left:16px;">
              <input type="checkbox" id="sb-mute-previews-checkbox" ${state.mutePreviews ? "checked" : ""}>
               Mute hover previews
            </label>
          </div>
          <p id="sb-climb-pool-warning" class="sb-climb-warning" hidden>
            Gauntlet and Champion can behave oddly with small filtered pools when both sides use the filter
            (fewer than ${CLIMB_SMALL_POOL_WARN_AT} scenes). Prefer a larger filter or turn off filter opponents.
          </p>
        </div>

        <div class="sb-content">
          <div id="sb-comparison-area" class="sb-comparison-area">
            <div class="sb-loading">Loading scenes...</div>
          </div>
          <div class="sb-actions">
            <div class="sb-action-buttons">
              <button id="sb-skip-btn" class="btn btn-secondary">Skip (Get New Pair)</button>
              <button id="sb-refresh-cache-btn" class="btn btn-secondary" title="Refresh scene list from server (use if you've added new scenes)">🔄 Refresh Cache</button>
            </div>
            <div class="sb-keyboard-hint">
              <span>← Left Arrow</span> to choose left ·
              <span>→ Right Arrow</span> to choose right ·
              <span>Space</span> to skip
            </div>
          </div>
        </div>
      </div>
    `;
}

function climbStatusBadge(scene: Scene): number | string | null {
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
  }

  // Attach click-to-open (for thumbnail only) - use React Router navigation
  comparisonArea.querySelectorAll<HTMLElement>(".sb-scene-image-container").forEach((container) => {
    const sceneUrl = container.dataset.sceneUrl;

    container.addEventListener("click", () => {
      if (sceneUrl) {
        navigateToUrl(sceneUrl);
      }
    });
  });

  // Attach hover preview to entire card
  comparisonArea.querySelectorAll<HTMLElement>(".sb-scene-card").forEach((card) => {
    const video = card.querySelector<HTMLVideoElement>(".sb-hover-preview");
    if (!video) return;

    card.addEventListener("mouseenter", () => {
      video.currentTime = 0;
      video.muted = state.mutePreviews;
      video.volume = 0.5;
      video.play().catch(() => {});
    });

    card.addEventListener("mouseleave", () => {
      video.pause();
      video.currentTime = 0;
    });
  });

  // Update skip button state
  const skipBtn = document.querySelector<HTMLButtonElement>("#sb-skip-btn");
  if (skipBtn) {
    const disableSkip =
      (state.currentMode === "gauntlet" || state.currentMode === "champion") &&
      state.gauntletClimber !== null;
    skipBtn.disabled = disableSkip;
    skipBtn.style.opacity = disableSkip ? "0.5" : "1";
    skipBtn.style.cursor = disableSkip ? "not-allowed" : "pointer";
  }
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

    if (state.currentMode === "gauntlet") {
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

    // Attach retry handler
    const retryBtn = document.getElementById("sb-error-retry") as HTMLButtonElement | null;
    if (retryBtn) {
      retryBtn.addEventListener("click", async () => {
        retryBtn.disabled = true;
        retryBtn.textContent = "Loading...";

        if (isNoScenes) {
          // "No scenes" error: clear everything and start fresh
          await clearFilteredCache();
          state.shuffledFilteredScenes = [];
          state.shuffleIndex = 0;
          state.shuffleFilterKey = null;
          state.removedSceneIds.clear();
        }
        // Network/other errors: just retry without clearing session state

        await loadNewPair();
      });
    }
  }
}

export function restoreCurrentPair(): void {
  state.disableChoice = false;
  console.log("[Stash Battle] 📂 Rendering saved pair (no network fetch needed)");

  // Pre-warm the cache in background for when user makes a choice
  if (!state.memoryCache.allScenes) {
    console.log("[Stash Battle] 🔥 Pre-warming cache in background...");
    getAllScenesCached(); // Don't await - runs in background
  }

  renderPair(
    [state.currentPair.left as Scene, state.currentPair.right as Scene],
    [state.currentRanks.left, state.currentRanks.right],
  );
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

/** Run pure ELO math and persist any rating changes to Stash. */
function resolveComparison(winner: Scene, loser: Scene): ComparisonDeltas {
  const mode = state.currentMode;
  const winnerRating = winner.rating100 || 1;
  const loserRating = loser.rating100 || 1;

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
    state.filterOpponents &&
    filters.filterActive &&
    smallPool
  );
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
  if (isFirstBattle && left.rating100 != null) {
    console.log(
      `[Stash Battle] 📊 Gauntlet: clearing rating ${left.rating100} for scene ${left.id} on first choice`,
    );
    await updateSceneRating(left.id, null);
    left.rating100 = null;
  }

  if (isFirstBattle) {
    state.gauntletClimber = left;
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
    state.gauntletFallingScene = loserScene;
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
    winnerScene.rating100 = newWinnerRating;
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
    left,
    right,
    winnerCard,
    loserCard,
    loserRank,
  } = choice;

  const winnerId = winnerScene.id;
  const loserId = loserScene.id;
  const winnerRating = winnerScene.rating100 || 1;
  const loserRating = loserScene.rating100 || 1;
  const loserDisplayRating = loserScene.rating100 || 0;

  // Handle gauntlet mode (climber tracking)
  if (state.currentMode === "gauntlet") {
    // Check if we're in falling mode (finding floor after a loss)
    if (state.gauntletFalling && state.gauntletFallingScene) {
      const fallingScene = state.gauntletFallingScene;
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
        fallingScene.rating100 = finalRating;

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

  // For Swiss: Calculate and show rating changes
  const { winner: winnerDelta, loser: loserDelta } = resolveComparison(winnerScene, loserScene);
  const newWinnerRating = winnerRating + winnerDelta;
  const newLoserRating = loserDisplayRating + loserDelta;

  // Remove both scenes from filtered pool (they've been processed)
  removeFromFilteredPool(left.id);
  removeFromFilteredPool(right.id);

  saveState();

  winnerCard.classList.add("sb-winner");
  if (loserCard) loserCard.classList.add("sb-loser");

  showRatingAnimation(winnerCard, winnerRating, newWinnerRating, true);
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

const RATING_ANIM_MAX_TOTAL_MS = 1400;
const RATING_ANIM_HOLD_MS = 300;
const RATING_ANIM_COUNT_BUDGET_MS = RATING_ANIM_MAX_TOTAL_MS - RATING_ANIM_HOLD_MS;
const RATING_ANIM_DEFAULT_STEP_MS = 50;
const RATING_ANIM_MIN_STEP_MS = 8;

function scheduleNextPairAfterAnimations(): void {
  setTimeout(() => loadNewPair(), 1500);
}

/** Count-up/down overlay; large jumps speed up so the full count fits within 1400ms. */
function showRatingAnimation(
  card: HTMLElement,
  oldRating: number,
  newRating: number,
  isWinner: boolean,
): void {
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
