// Matchmaking: build the scene pairs for each comparison mode.

import { clearFilteredCache, getAllScenesCached, getFilteredScenesCached } from "./cache";
import { CLIMB_OPPONENT_PICK_WINDOW, SWISS_OPPONENT_REACH_INITIAL, SWISS_OPPONENT_REACH_MULTIPLIER } from "./constants";
import { effectiveRating } from "./elo";
import { readFilters, type ListFilters } from "./filters";
import { updateSceneRating } from "./rating";
import { state } from "./state";
import type {
  ChampionPairResult,
  GauntletPairResult,
  PlacementPairResult,
  PlacementRun,
  Rank,
  Scene,
  SwissPairResult,
} from "./types";

function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

// Track last scene to avoid immediate repeat after reshuffle
let lastShownSceneId: string | null = null;

/** True once every scene in the current shuffle has been shown (time to re-query the filter). */
function isShuffleCycleComplete(filterKey: string): boolean {
  return (
    state.shuffleFilterKey === filterKey &&
    state.shuffledFilteredScenes.length > 0 &&
    state.shuffleIndex >= state.shuffledFilteredScenes.length
  );
}

/** Reshuffle the left pool for a new pass, without showing the previous pass's last scene first. */
function startNewPass(leftPool: Scene[]): void {
  console.log("[Stash Battle] 🔀 Reshuffling (completed full cycle)");
  state.shuffledFilteredScenes = shuffleArray(leftPool);
  state.shuffleIndex = 0;

  if (
    lastShownSceneId &&
    state.shuffledFilteredScenes.length > 1 &&
    state.shuffledFilteredScenes[0].id === lastShownSceneId
  ) {
    const swapIdx = 1 + Math.floor(Math.random() * (state.shuffledFilteredScenes.length - 1));
    [state.shuffledFilteredScenes[0], state.shuffledFilteredScenes[swapIdx]] = [
      state.shuffledFilteredScenes[swapIdx],
      state.shuffledFilteredScenes[0],
    ];
    console.log("[Stash Battle] 🔄 Swapped first scene to avoid repeat");
  }
}

/** Next left-side scene from the shuffled left pool (no network fetch). Scenes stay in the pool. */
function getNextFilteredScene(leftPool: Scene[], filterKey: string): Scene | null {
  if (leftPool.length === 0) {
    console.log("[Stash Battle] 🏁 Filtered pool is empty");
    return null;
  }

  if (filterKey !== state.shuffleFilterKey || state.shuffledFilteredScenes.length === 0) {
    console.log("[Stash Battle] 🔀 Shuffling filtered scenes (filter changed or first load)");
    state.shuffledFilteredScenes = shuffleArray(leftPool);
    state.shuffleIndex = 0;
    state.shuffleFilterKey = filterKey;
    lastShownSceneId = null;
  }

  if (state.shuffleIndex >= state.shuffledFilteredScenes.length) {
    startNewPass(leftPool);
  }

  const scene = state.shuffledFilteredScenes[state.shuffleIndex];
  state.shuffleIndex++;
  lastShownSceneId = scene.id;
  console.log(
    `[Stash Battle] 📍 Picked scene ${scene.id} (${state.shuffledFilteredScenes.length - state.shuffleIndex} left in this pass)`,
  );
  return scene;
}

function buildOpponentPool(allScenes: Scene[], leftPool: Scene[], filters: ListFilters): Scene[] {
  if (state.settings.filterOpponents && filters.filterActive) {
    return leftPool;
  }
  const ratedOnly = allScenes.filter((s) => s.rating100 != null);
  return ratedOnly.length >= 1 ? ratedOnly : allScenes;
}

/** Load the left ("to rate") and full pools. */
async function loadScenePools(
  filters: ListFilters,
): Promise<{ leftPool: Scene[]; allScenes: Scene[] }> {
  let leftPool: Scene[];
  let allScenes: Scene[];

  if (filters.filterActive) {
    // Re-query the filter after each full pass so filters like "unrated" shrink as scenes get rated
    const passComplete = isShuffleCycleComplete(filters.filterKey);
    if (passComplete) {
      console.log("[Stash Battle] 🔁 Pass complete, re-fetching filtered scenes");
      await clearFilteredCache();
    }
    console.log("[Stash Battle] 📋 Filter active, fetching filtered + all scenes");
    const [filteredResult, allResult] = await Promise.all([
      getFilteredScenesCached(filters),
      getAllScenesCached(),
    ]);
    leftPool = filteredResult.scenes || [];
    allScenes = allResult.scenes || [];
    // Start the next pass now, so later loads in a run (which pick no new left scene) don't
    // see the pass as complete and re-fetch the filter every time
    if (passComplete) startNewPass(leftPool);
  } else {
    console.log("[Stash Battle] 📋 No filter active, using all scenes");
    allScenes = (await getAllScenesCached()).scenes || [];
    leftPool = allScenes;
  }

  state.leftPoolSize = leftPool.length;
  return { leftPool, allScenes };
}

/** Load the pools (served from cache when possible) just to record the left pool's size. */
export async function loadPoolSize(): Promise<void> {
  await loadScenePools(readFilters());
}

/** Load left (scene to rate) and right (opponent) pools for Swiss. */
async function buildSwissPools(): Promise<{
  leftPool: Scene[];
  rightPool: Scene[];
  filterKey: string;
}> {
  const filters = readFilters();
  const { leftPool, allScenes } = await loadScenePools(filters);

  if (allScenes.length < 2) {
    throw new Error("Not enough scenes for comparison.");
  }

  const rightPool = buildOpponentPool(allScenes, leftPool, filters);
  if (state.settings.filterOpponents && filters.filterActive && rightPool.length < 2) {
    throw new Error("Not enough scenes in your filter for a match. You need at least 2 scenes.");
  }

  return { leftPool, rightPool, filterKey: filters.filterKey };
}

/** Index where a scene with this rating would sit in a rating-sorted (DESC) pool. */
function insertionIndex(pool: Scene[], rating: number): number {
  const idx = pool.findIndex((s) => (s.rating100 ?? 0) < rating);
  return idx === -1 ? pool.length : idx;
}

// Swiss mode: left = scene to rate (filtered pool), right = similar-strength opponent
export async function fetchSwissPair(forcedLeftScene: Scene | null = null): Promise<SwissPairResult> {
  const { leftPool, rightPool, filterKey } = await buildSwissPools();

  const scene1 = forcedLeftScene || getNextFilteredScene(leftPool, filterKey);
  if (!scene1) {
    throw new Error("No scenes match your filter criteria.");
  }

  const { scene2, ranks } = pickSwissOpponent(scene1, rightPool);
  return { scenes: [scene1, scene2], ranks };
}

/** Pick a random opponent near scene1's rank in the rating-sorted right pool (expanding band if needed). */
function pickSwissOpponent(
  scene1: Scene,
  rightPool: Scene[],
): { scene2: Scene; ranks: [Rank, Rank] } {
  const scene1IdxInPool = rightPool.findIndex((s) => s.id === scene1.id);
  // Rated scenes match around their own rank; unrated ones around where `unratedRating` would sit
  const effectiveScene1Idx =
    scene1.rating100 && scene1IdxInPool >= 0
      ? scene1IdxInPool
      : insertionIndex(rightPool, effectiveRating(scene1.rating100, state.settings.unratedRating));
  const scene1RankInPool = scene1IdxInPool >= 0 ? scene1IdxInPool + 1 : null;

  const candidates: { scene: Scene; idx: number }[] = [];
  // Prefer similar-strength matchups (±reach ranks). If the band is empty (edges, unrated left
  // scene, tiny pool), double reach until we find candidates or cover the whole pool.
  for (
    let reach = Math.min(SWISS_OPPONENT_REACH_INITIAL, rightPool.length);
    candidates.length === 0 && reach <= rightPool.length;
    reach = Math.min(reach * SWISS_OPPONENT_REACH_MULTIPLIER, rightPool.length)
  ) {
    for (let i = effectiveScene1Idx - reach; i <= effectiveScene1Idx + reach; i++) {
      if (i >= 0 && i < rightPool.length && i !== scene1IdxInPool) {
        candidates.push({ scene: rightPool[i], idx: i });
      }
    }
  }

  if (candidates.length === 0) {
    throw new Error("Not enough scenes for comparison. You need at least 2 scenes.");
  }

  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  return {
    scene2: pick.scene,
    ranks: [scene1RankInPool, pick.idx + 1],
  };
}

/** Random pick from the N undefeated opponents closest above the climber (list is rating-sorted DESC). */
function pickClosestClimbOpponent(remainingOpponents: Scene[]): Scene {
  const closest = remainingOpponents.slice(-CLIMB_OPPONENT_PICK_WINDOW);
  return closest[Math.floor(Math.random() * closest.length)];
}

/** Undefeated opponents above the climber in the rating-sorted right pool. */
function getRemainingClimbOpponents(
  climber: Scene,
  rightPool: Scene[],
  climberIndex: number,
): Scene[] {
  return rightPool.filter((s, idx) => {
    if (s.id === climber.id || state.gauntletDefeated.includes(s.id)) return false;
    return idx < climberIndex || (s.rating100 || 0) >= (climber.rating100 || 0);
  });
}

async function getClimbOpponentPool(): Promise<Scene[]> {
  const filters = readFilters();
  const { leftPool, allScenes } = await loadScenePools(filters);
  return buildOpponentPool(allScenes, leftPool, filters);
}

/** Apply ELO from a climber win; bump above the beaten opponent when the pool is cleared. */
export async function applyClimbWinRating(
  climber: Scene,
  beatenOpponent: Scene,
  eloRating: number,
): Promise<number> {
  climber.rating100 = eloRating;

  const rightPool = await getClimbOpponentPool();
  const climberIndex = rightPool.findIndex((s) => s.id === climber.id);
  // If the climber has remaining opponents return ELO rating as normal
  if (getRemainingClimbOpponents(climber, rightPool, climberIndex).length > 0) {
    return eloRating;
  }

  // If the climber has no remaining opponents, ensure their rating is above the opponent they just beat
  const minWinnerRating = Math.min(100, (beatenOpponent.rating100 ?? 0) + 1);
  if (eloRating < minWinnerRating) {
    await updateSceneRating(climber.id, minWinnerRating);
    climber.rating100 = minWinnerRating;
  }
  return climber.rating100 ?? eloRating;
}

// Find the lowest actually rated scene in a descending-sorted array, excluding a specific scene
// Returns { scene, index } or fallback to first non-excluded scene if none rated
function findLowestRated(scenes: Scene[], excludeId: string): { scene: Scene; index: number } {
  for (let i = scenes.length - 1; i >= 0; i--) {
    const s = scenes[i];
    if (s.id !== excludeId && s.rating100 != null) {
      return { scene: s, index: i };
    }
  }
  // Fallback to any scene if none rated
  const fallbackIndex = scenes.findIndex((s) => s.id !== excludeId);
  return { scene: scenes[fallbackIndex], index: fallbackIndex };
}

// Gauntlet mode: champion vs next challenger
export async function fetchGauntletPair(
  forcedLeftScene: Scene | null = null,
): Promise<GauntletPairResult> {
  const filters = readFilters();

  console.log("[Stash Battle] 📋 Fetching scenes for gauntlet...");
  const { leftPool, allScenes } = await loadScenePools(filters);

  let rightPool = buildOpponentPool(allScenes, leftPool, filters);
  state.totalScenesCount = rightPool.length;

  if (allScenes.length < 2) {
    throw new Error("Not enough scenes for comparison.");
  }

  // Handle falling mode - find next opponent BELOW to test against (from full collection)
  if (state.gauntletFalling && state.gauntletFallingScene) {
    const fallingScene = state.gauntletFallingScene;
    const fallingIndex = rightPool.findIndex((s) => s.id === fallingScene.id);

    const belowOpponents = rightPool.filter((s, idx) => {
      if (s.id === fallingScene.id || state.gauntletDefeated.includes(s.id)) return false;
      return idx > fallingIndex; // Below in ranking
    });

    if (belowOpponents.length === 0) {
      // Hit the bottom - place 1 below the last opponent that beat them
      const finalRank = rightPool.length;
      const lastDefeatedById = state.gauntletDefeated[state.gauntletDefeated.length - 1];
      const lastOpponent = rightPool.find((s) => s.id === lastDefeatedById);
      const finalRating = Math.max(1, (lastOpponent?.rating100 || 1) - 1);
      updateSceneRating(fallingScene.id, finalRating);

      return {
        scenes: [fallingScene],
        ranks: [finalRank],
        isVictory: false,
        isFalling: true,
        isPlacement: true,
        placementRank: finalRank,
        placementRating: finalRating,
      };
    } else {
      // Get next opponent below (first one, closest to falling scene)
      const nextBelow = belowOpponents[0];
      const nextBelowIndex = rightPool.findIndex((s) => s.id === nextBelow.id);

      // Update the falling scene's rank for display
      state.gauntletClimberRank = fallingIndex + 1;

      return {
        scenes: [fallingScene, nextBelow],
        ranks: [fallingIndex + 1, nextBelowIndex + 1],
        isVictory: false,
        isFalling: true,
      };
    }
  }

  // If no climber yet, pick from filtered pool to start
  if (!state.gauntletClimber) {
    state.gauntletDefeated = [];
    state.gauntletFalling = false;
    state.gauntletFallingScene = null;

    const challenger = forcedLeftScene || getNextFilteredScene(leftPool, filters.filterKey);

    if (!challenger) {
      throw new Error("No scenes match your filter criteria.");
    }

    const challengerIndex = rightPool.findIndex((s) => s.id === challenger.id);

    // Start at the bottom - find lowest rated scene in rightPool
    const { scene: lowestRated, index: lowestIndex } = findLowestRated(rightPool, challenger.id);

    state.gauntletClimberRank = challengerIndex >= 0 ? challengerIndex + 1 : rightPool.length;

    return {
      scenes: [challenger, lowestRated],
      ranks: [state.gauntletClimberRank, lowestIndex + 1],
      isVictory: false,
      isFalling: false,
    };
  }

  const climber = state.gauntletClimber;
  const climberIndex = rightPool.findIndex((s) => s.id === climber.id);

  state.gauntletClimberRank = climberIndex >= 0 ? climberIndex + 1 : 1;

  const remainingOpponents = getRemainingClimbOpponents(climber, rightPool, climberIndex);

  // If no opponents left, the climber has conquered the ladder
  if (remainingOpponents.length === 0) {
    state.gauntletClimberRank = 1;
    return {
      scenes: [climber],
      ranks: [1],
      isVictory: true,
      isFalling: false,
    };
  }

  const nextOpponent = pickClosestClimbOpponent(remainingOpponents);
  const nextOpponentIndex = rightPool.findIndex((s) => s.id === nextOpponent.id);

  return {
    scenes: [climber, nextOpponent],
    ranks: [climberIndex >= 0 ? climberIndex + 1 : null, nextOpponentIndex + 1],
    isVictory: false,
    isFalling: false,
  };
}

// Champion mode: like gauntlet but winner stays on (no falling)
export async function fetchChampionPair(
  forcedLeftScene: Scene | null = null,
): Promise<ChampionPairResult> {
  const filters = readFilters();

  console.log("[Stash Battle] 📋 Fetching scenes for champion...");
  const { leftPool, allScenes } = await loadScenePools(filters);

  let rightPool = buildOpponentPool(allScenes, leftPool, filters);
  state.totalScenesCount = rightPool.length;

  if (allScenes.length < 2) {
    throw new Error("Not enough scenes for comparison.");
  }

  // If no climber yet, pick from filtered pool to start
  if (!state.gauntletClimber) {
    state.gauntletDefeated = [];

    if (!forcedLeftScene && leftPool.length < 1) {
      throw new Error("No scenes match your filter criteria.");
    }

    const challenger = forcedLeftScene || getNextFilteredScene(leftPool, filters.filterKey);

    if (!challenger) {
      throw new Error("No scenes match your filter criteria.");
    }

    const challengerIndex = rightPool.findIndex((s) => s.id === challenger.id);

    // Start at the bottom - find lowest actually rated scene
    const { scene: lowestRated, index: lowestIndex } = findLowestRated(rightPool, challenger.id);

    state.gauntletClimberRank = challengerIndex >= 0 ? challengerIndex + 1 : rightPool.length;

    return {
      scenes: [challenger, lowestRated],
      ranks: [state.gauntletClimberRank, lowestIndex + 1],
      isVictory: false,
    };
  }

  const climber = state.gauntletClimber;
  const climberIndex = rightPool.findIndex((s) => s.id === climber.id);

  state.gauntletClimberRank = climberIndex >= 0 ? climberIndex + 1 : 1;

  const remainingOpponents = getRemainingClimbOpponents(climber, rightPool, climberIndex);
  
  // If no opponents left, the climber has conquered the ladder
  if (remainingOpponents.length === 0) {
    state.gauntletClimberRank = 1;
    return {
      scenes: [climber],
      ranks: [1],
      isVictory: true,
    };
  }

  const nextOpponent = pickClosestClimbOpponent(remainingOpponents);
  const nextOpponentIndex = rightPool.findIndex((s) => s.id === nextOpponent.id);

  return {
    scenes: [climber, nextOpponent],
    ranks: [climberIndex + 1, nextOpponentIndex + 1],
    isVictory: false,
  };
}

// --- Placement mode: bounded search with momentum ---
//
// The scene's slot lies in [lo, hi) of the rating-sorted opponent pool. A win against index i
// means the slot is above i (hi = i); a loss means it's below (lo = i + 1). A rated scene starts
// next to its current rank and gallops (steps 1, 2, 4, 8...) while results keep going the same
// way; the first reversal (or an unrated scene) switches to halving the remaining range.

function newPlacementRun(scene: Scene): PlacementRun {
  return {
    scene,
    aboveId: null,
    belowId: null,
    lastOpponentId: null,
    lastWon: null,
    galloping: scene.rating100 != null,
    step: 1,
    battles: 0,
    rangeLo: 0,
    rangeHi: 0,
  };
}

/** Current [lo, hi) slot bounds, resolved from the bounding opponents' ids. */
function placementBounds(run: PlacementRun, pool: Scene[]): { lo: number; hi: number } {
  const aboveIdx = run.aboveId ? pool.findIndex((s) => s.id === run.aboveId) : -1;
  const belowIdx = run.belowId ? pool.findIndex((s) => s.id === run.belowId) : -1;
  return { lo: aboveIdx + 1, hi: belowIdx >= 0 ? belowIdx : pool.length };
}

function nextPlacementIndex(run: PlacementRun, pool: Scene[], lo: number, hi: number): number {
  if (run.galloping) {
    if (run.lastOpponentId === null) {
      // Start just below the scene's current rating: a correctly rated scene confirms in ~2 battles
      return insertionIndex(pool, run.scene.rating100 ?? 0);
    }
    const lastIdx = pool.findIndex((s) => s.id === run.lastOpponentId);
    if (lastIdx >= 0) {
      // Step from the far edge of the last opponent's tie group: another equal rating teaches nothing
      const dir = run.lastWon ? -1 : 1;
      const lastRating = pool[lastIdx].rating100 ?? 0;
      let edge = lastIdx;
      while (edge + dir >= 0 && edge + dir < pool.length && (pool[edge + dir].rating100 ?? 0) === lastRating) {
        edge += dir;
      }
      return edge + dir * run.step;
    }
  }
  return lo + Math.floor((hi - lo) / 2);
}

/** Random pick among scenes in [lo, hi) that share pool[idx]'s rating (their order is arbitrary). */
function pickAmongTies(pool: Scene[], idx: number, lo: number, hi: number): number {
  const rating = pool[idx].rating100 ?? 0;
  const ties: number[] = [];
  for (let i = lo; i < hi; i++) {
    if ((pool[i].rating100 ?? 0) === rating) ties.push(i);
  }
  return ties[Math.floor(Math.random() * ties.length)];
}

/** Rating for a scene placed at `slot`: between its neighbours, ±1 at the edges. */
function placementRating(pool: Scene[], slot: number): number {
  const above = slot > 0 ? (pool[slot - 1].rating100 ?? 0) : null;
  const below = slot < pool.length ? (pool[slot].rating100 ?? 0) : null;
  if (above === null) return Math.min(100, (below ?? 0) + 1);
  if (below === null) return Math.max(1, above - 1);
  if (above - below >= 2) return Math.round((above + below) / 2);
  // No integer strictly between: tie with the scene above (cache ordering puts ties first-come)
  return Math.max(1, above);
}

/** Record a placement battle result and update the momentum. */
export function recordPlacementResult(won: boolean, opponentId: string): void {
  const run = state.placement;
  if (!run) return;

  if (run.lastWon !== null) {
    if (run.lastWon === won) run.step *= 2;
    else run.galloping = false;
  }
  if (won) run.belowId = opponentId;
  else run.aboveId = opponentId;

  run.lastOpponentId = opponentId;
  run.lastWon = won;
  run.battles++;
}

// Placement mode: left = scene being placed, right = the next opponent in its search range
export async function fetchPlacementPair(
  forcedLeftScene: Scene | null = null,
): Promise<PlacementPairResult> {
  const filters = readFilters();
  const { leftPool, allScenes } = await loadScenePools(filters);

  if (allScenes.length < 2) {
    throw new Error("Not enough scenes for comparison.");
  }

  if (!state.placement) {
    const scene = forcedLeftScene || getNextFilteredScene(leftPool, filters.filterKey);
    if (!scene) {
      throw new Error("No scenes match your filter criteria.");
    }
    state.placement = newPlacementRun(scene);
  }
  const run = state.placement;

  const pool = buildOpponentPool(allScenes, leftPool, filters).filter((s) => s.id !== run.scene.id);
  if (pool.length === 0) {
    throw new Error("Not enough scenes for comparison. You need at least 2 scenes.");
  }
  state.totalScenesCount = pool.length + 1;

  const { lo, hi } = placementBounds(run, pool);
  run.rangeLo = Math.min(lo, hi);
  run.rangeHi = hi;

  if (lo >= hi) {
    const slot = Math.min(lo, hi);
    const rating = placementRating(pool, slot);
    console.log(
      `[Stash Battle] 📍 Placement: scene ${run.scene.id} placed at #${slot + 1} after ${run.battles} battles, rating ${rating}`,
    );
    await updateSceneRating(run.scene.id, rating);
    run.scene.rating100 = rating;
    return { done: true, scene: run.scene, rank: slot + 1, rating };
  }

  const target = Math.max(lo, Math.min(hi - 1, nextPlacementIndex(run, pool, lo, hi)));
  const idx = pickAmongTies(pool, target, lo, hi);
  return { done: false, scenes: [run.scene, pool[idx]], ranks: [null, idx + 1] };
}
